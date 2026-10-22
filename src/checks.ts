import * as core from "@actions/core";
import { Octokit } from "./types";

export const CHECK_NAME = "Review Router";
const EXTERNAL_ID_PREFIX = "rr:teams=";

export interface ReviewCheck {
  status: "in_progress" | "completed";
  conclusion?: "success" | "neutral";
  title: string;
  summary: string;
  externalId: string;
}

export function parseRoutedTeams(externalId: string | null | undefined): string[] {
  if (!externalId?.startsWith(EXTERNAL_ID_PREFIX)) return [];
  return externalId.slice(EXTERNAL_ID_PREFIX.length).split(",").filter(Boolean);
}

function formatTeams(teams: string[]): string {
  return teams.length > 0 ? teams.map((t) => `\`${t}\``).join(", ") : "none";
}

export function buildReviewCheck(
  routedTeams: string[],
  pendingTeams: string[],
  closed: boolean
): ReviewCheck {
  const approved = routedTeams.filter((t) => !pendingTeams.includes(t));
  const summary = `**Approved:** ${formatTeams(approved)}\n**Pending:** ${formatTeams(pendingTeams)}`;
  const externalId = `${EXTERNAL_ID_PREFIX}${routedTeams.join(",")}`;

  if (closed) {
    return { status: "completed", conclusion: "neutral", title: "PR closed", summary, externalId };
  }
  if (pendingTeams.length === 0) {
    return {
      status: "completed",
      conclusion: "success",
      title: "All teams approved",
      summary,
      externalId,
    };
  }
  return {
    status: "in_progress",
    title: `Waiting for approval from ${pendingTeams.length} team(s)`,
    summary,
    externalId,
  };
}

/**
 * Creates or updates the "Review Router" check on a commit. Never throws: a missing
 * Checks permission (403, 404) is expected until an installation approves it.
 */
export async function upsertReviewCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  pendingTeams: string[],
  closed = false
): Promise<void> {
  try {
    const { data } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      check_name: CHECK_NAME,
    });
    const existing = data.check_runs[0];
    const routedTeams = [...new Set([...parseRoutedTeams(existing?.external_id), ...pendingTeams])];
    const check = buildReviewCheck(routedTeams, pendingTeams, closed);
    const fields = {
      owner,
      repo,
      status: check.status,
      ...(check.conclusion ? { conclusion: check.conclusion } : {}),
      external_id: check.externalId,
      output: { title: check.title, summary: check.summary },
    };

    if (existing) {
      await octokit.rest.checks.update({ ...fields, check_run_id: existing.id });
    } else {
      await octokit.rest.checks.create({ ...fields, name: CHECK_NAME, head_sha: headSha });
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 404) {
      core.info(`Skipping the ${CHECK_NAME} check: the Checks permission is not granted here`);
      return;
    }
    core.warning(
      `Failed to update the ${CHECK_NAME} check: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
