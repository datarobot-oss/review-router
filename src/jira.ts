import * as core from "@actions/core";

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
