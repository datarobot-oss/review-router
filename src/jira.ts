import * as core from "@actions/core";
import { JiraConfig, Octokit } from "./types";

export function extractTicketIds(title: string): string[] {
  const ids = [...title.matchAll(/\[([A-Z][A-Z0-9]*-\d+)\]/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

const JIRA_API_GATEWAY = "https://api.atlassian.com/ex/jira";

/**
 * Resolves a Jira site URL to its cloud ID via the unauthenticated
 * `/_edge/tenant_info` endpoint. Scoped API tokens authenticate only against the
 * `api.atlassian.com/ex/jira/{cloudId}` gateway, so the cloud ID is required
 * before any authenticated read.
 */
export async function resolveCloudId(baseUrl: string): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/_edge/tenant_info`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      core.warning(`Jira tenant_info returned ${response.status} for ${baseUrl}`);
      return null;
    }
    const data = (await response.json()) as { cloudId?: string };
    return data.cloudId ?? null;
  } catch (error) {
    core.warning(
      `Failed to resolve Jira cloud ID for ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export interface JiraTicketDetails {
  summary: string;
  type?: string;
  parent?: { id: string; summary: string };
}

export interface JiraTicket extends Omit<JiraTicketDetails, "summary"> {
  id: string;
  summary: string | null;
}

interface IssueResponse {
  fields?: {
    summary?: string;
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string } };
  };
}

/** Fetches the ticket fields the PR comment shows, or null when the ticket can't be read. */
export async function fetchTicket(
  ticketId: string,
  cloudId: string,
  token: string
): Promise<JiraTicketDetails | null> {
  const url = `${JIRA_API_GATEWAY}/${cloudId}/rest/api/3/issue/${ticketId}?fields=summary,issuetype,parent`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      core.warning(`Jira API returned ${response.status} for ticket ${ticketId}`);
      return null;
    }
    const { fields } = (await response.json()) as IssueResponse;
    if (!fields?.summary) return null;
    const parent = fields.parent;
    return {
      summary: fields.summary,
      ...(fields.issuetype?.name ? { type: fields.issuetype.name } : {}),
      ...(parent?.key && parent.fields?.summary
        ? { parent: { id: parent.key, summary: parent.fields.summary } }
        : {}),
    };
  } catch (error) {
    core.warning(
      `Failed to fetch Jira ticket ${ticketId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export const JIRA_COMMENT_MARKER = "<!-- review-router-jira -->";

function renderTicket(baseUrl: string, ticket: JiraTicket): string {
  const link = (id: string) => `[${id}](${baseUrl}/browse/${id})`;
  const heading = `🎫 **${link(ticket.id)}**${ticket.summary && ticket.type ? ` · ${ticket.type}` : ""}`;
  if (!ticket.summary) return heading;
  const lines = [heading, `> ${ticket.summary}`];
  if (ticket.parent) {
    lines.push("", `<sub>Part of ${link(ticket.parent.id)} · ${ticket.parent.summary}</sub>`);
  }
  return lines.join("\n");
}

export function buildJiraComment(baseUrl: string, tickets: JiraTicket[]): string {
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const cards = tickets.map((t) => renderTicket(trimmedBase, t)).join("\n\n");
  const body = `${JIRA_COMMENT_MARKER}\n${cards}`;
  return tickets.some((t) => !t.summary)
    ? `${body}\n\n_Add a \`jira-token\` input for ticket titles here._`
    : body;
}

export async function postJiraComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  jiraConfig: JiraConfig | undefined,
  jiraToken: string
): Promise<void> {
  if (!jiraConfig?.enabled) return;

  const baseUrl = jiraConfig.base_url;
  if (!baseUrl) {
    core.warning('Jira is enabled but "base_url" is not configured; skipping Jira comment');
    return;
  }

  const ticketIds = extractTicketIds(prTitle);
  if (ticketIds.length === 0) return;

  const cloudId = jiraToken ? await resolveCloudId(baseUrl) : null;

  const tickets: JiraTicket[] = await Promise.all(
    ticketIds.map(async (id) => {
      const details = cloudId ? await fetchTicket(id, cloudId, jiraToken) : null;
      return { id, ...(details ?? { summary: null }) };
    })
  );

  const body = buildJiraComment(baseUrl, tickets);

  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });
    const existing = comments.find((c) => c.body?.includes(JIRA_COMMENT_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      core.info(`Updated Jira comment on PR #${prNumber}`);
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
      core.info(`Posted Jira comment on PR #${prNumber}`);
    }
  } catch (error) {
    core.warning(
      `Failed to post Jira comment on PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
