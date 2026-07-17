import * as core from "@actions/core";
import { JiraConfig, Octokit } from "./types";

export function extractTicketIds(title: string): string[] {
  return [...title.matchAll(/\[([A-Z][A-Z0-9]*-\d+)\]/g)].map((m) => m[1]);
}

export async function fetchTicketSummary(
  ticketId: string,
  baseUrl: string,
  token: string
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${ticketId}?fields=summary`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(token).toString("base64")}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      core.warning(`Jira API returned ${response.status} for ticket ${ticketId}`);
      return null;
    }
    const data = (await response.json()) as { fields?: { summary?: string } };
    return data.fields?.summary ?? null;
  } catch (error) {
    core.warning(
      `Failed to fetch Jira ticket ${ticketId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export const JIRA_COMMENT_MARKER = "<!-- review-router-jira -->";

export function buildJiraComment(
  baseUrl: string,
  tickets: Array<{ id: string; summary: string | null }>
): string {
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const lines: string[] = [JIRA_COMMENT_MARKER, "### 🎫 Jira", ""];
  let missingSummary = false;

  for (const ticket of tickets) {
    const url = `${trimmedBase}/browse/${ticket.id}`;
    if (ticket.summary) {
      lines.push(`- [${ticket.id}: ${ticket.summary}](${url})`);
    } else {
      lines.push(`- [${ticket.id}](${url})`);
      missingSummary = true;
    }
  }

  if (missingSummary) {
    lines.push("");
    lines.push("_Add a `jira-token` input for ticket titles here._");
  }

  return lines.join("\n");
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

  const tickets = await Promise.all(
    ticketIds.map(async (id) => ({
      id,
      summary: jiraToken ? await fetchTicketSummary(id, baseUrl, jiraToken) : null,
    }))
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
