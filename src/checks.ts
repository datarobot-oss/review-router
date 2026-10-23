import * as core from "@actions/core";
import { Octokit } from "./types";

export const CHECK_NAME = "Review Router";
const EXTERNAL_ID_PREFIX = "rr:teams=";
const MAX_EARLIER_COMMITS = 10;

export interface ReviewCheck {
  status: "queued" | "completed";
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
  const externalId = `${EXTERNAL_ID_PREFIX}${routedTeams.join(",")}`;

  if (closed) {
    return {
      status: "completed",
      conclusion: "neutral",
      title: "PR closed",
      summary: "The PR was closed.",
      externalId,
    };
  }

  const approved = routedTeams.filter((t) => !pendingTeams.includes(t));
  const summary = `**Approved:** ${formatTeams(approved)}\n**Pending:** ${formatTeams(pendingTeams)}`;
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
    status: "queued",
    title: `Waiting for approval from ${pendingTeams.length} ${pendingTeams.length === 1 ? "team" : "teams"}`,
    summary,
    externalId,
  };
}

async function listChecks(octokit: Octokit, owner: string, repo: string, ref: string) {
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref,
    check_name: CHECK_NAME,
  });
  return data.check_runs;
}

/** Checks belong to a commit, so a push leaves the new head without the routed-team history. */
async function routedTeamsFromEarlierCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<string[]> {
  try {
    const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const earlier = commits
      .map((c) => c.sha)
      .filter((sha) => sha !== headSha)
      .reverse()
      .slice(0, MAX_EARLIER_COMMITS);
    for (const sha of earlier) {
      const [check] = await listChecks(octokit, owner, repo, sha);
      if (check) return parseRoutedTeams(check.external_id);
    }
  } catch (error) {
    core.debug(
      `Could not read earlier ${CHECK_NAME} checks: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return [];
}

/**
 * Creates or updates the "Review Router" check on a commit. With createIfMissing off it only
 * updates a check that already exists, so a repo outside the rollout still settles old checks.
 * Never throws: a missing Checks permission (403, 404) is expected until an installation approves it.
 */
export async function upsertReviewCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  pendingTeams: string[],
  closed = false,
  createIfMissing = true
): Promise<void> {
  try {
    const [existing] = await listChecks(octokit, owner, repo, headSha);
    // A check exists only to show pending teams: settle one that exists, never open an empty one.
    if (!existing && (closed || pendingTeams.length === 0 || !createIfMissing)) return;
    const previouslyRouted = existing
      ? parseRoutedTeams(existing.external_id)
      : await routedTeamsFromEarlierCommits(octokit, owner, repo, prNumber, headSha);
    const routedTeams = [...new Set([...previouslyRouted, ...pendingTeams])];
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
      const reason =
        error instanceof Error ? error.message : (error as { message?: string }).message;
      core.info(
        `Skipping the ${CHECK_NAME} check (${status}${reason ? `: ${reason}` : ""}); the Checks permission may not be granted here`
      );
      return;
    }
    core.warning(
      `Failed to update the ${CHECK_NAME} check: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
