import { Octokit } from "../types";
import { GateDecision } from "./decide";

export const GATE_CHECK_NAME = "Bouncer";
const EXTERNAL_ID_PREFIX = "rr-gate:";

/** The decision as the check run records it. The external id carries the reason for dedupe. */
function stateOf(decision: GateDecision): { conclusion: string; externalId: string } {
  return {
    conclusion: decision.conclusion,
    externalId: `${EXTERNAL_ID_PREFIX}${decision.reason}`,
  };
}

/**
 * Posts the decision as a new completed check run on a commit, unless the latest run of that
 * name already shows the same state. A new run per change keeps the history readable, and a
 * required check follows the latest run. Returns whether a run was posted.
 */
export async function postGateCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  decision: GateDecision,
  runUrl?: string
): Promise<boolean> {
  const { conclusion, externalId } = stateOf(decision);
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: GATE_CHECK_NAME,
    filter: "latest",
  });
  const [latest] = data.check_runs;
  if (latest?.status === "completed" && latest.conclusion === conclusion) {
    if (latest.external_id === externalId) return false;
  }

  await octokit.rest.checks.create({
    owner,
    repo,
    name: GATE_CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: conclusion as "success" | "action_required",
    external_id: externalId,
    ...(runUrl ? { details_url: runUrl } : {}),
    output: { title: decision.title, summary: decision.summary },
  });
  return true;
}

/** True when the commit already has a gate result, which a failure must then replace. */
export async function hasGateCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
): Promise<boolean> {
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: GATE_CHECK_NAME,
    filter: "latest",
  });
  return data.check_runs.length > 0;
}
