import { withRunLink } from "../checks";
import { Octokit } from "../types";
import { GateDecision } from "./decide";
import { GateAppMismatchError } from "./errors";

export const GATE_CHECK_NAME = "Bouncer";
/** Where a person lands from the check row, to learn why the check is there. */
export const GATE_DOCS_URL =
  "https://github.com/datarobot-oss/review-router/blob/main/docs/setup/gate.md#how-the-gate-decides";
const EXTERNAL_ID_PREFIX = "rr-gate:";
/**
 * The gate's own App marks its runs differently. A Router that posts the same check without
 * naming an App then never takes the gate App's latest run for its own, which would skip a post
 * the pinned ruleset still waits for.
 */
const APP_EXTERNAL_ID_PREFIX = "rr-gate-app:";

/** The decision as the check run records it. The external id carries the reason for dedupe. */
function stateOf(
  decision: GateDecision,
  appId?: number
): {
  status: "in_progress" | "completed";
  conclusion?: string;
  externalId: string;
} {
  const prefix = appId === undefined ? EXTERNAL_ID_PREFIX : APP_EXTERNAL_ID_PREFIX;
  const externalId = `${prefix}${decision.reason}`;
  return decision.pending
    ? { status: "in_progress", externalId }
    : { status: "completed", conclusion: decision.conclusion, externalId };
}

/**
 * Posts the decision as a new check run on a commit, unless the latest run of that name already
 * shows the same state. A pending decision is an in_progress run, any other a completed one. A
 * new run per change keeps the history readable, and a required check follows the latest run.
 * With an appId, only the runs of that App count as the latest, so another App's result can't
 * stand in for this one's. Throws a GateAppMismatchError when the new run was created by another
 * App than the one named, since the dedupe would then never see the gate's own runs. Returns
 * whether a run was posted.
 */
export async function postGateCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  decision: GateDecision,
  runUrl?: string,
  appId?: number
): Promise<boolean> {
  const { status, conclusion, externalId } = stateOf(decision, appId);
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: GATE_CHECK_NAME,
    filter: "latest",
    ...(appId === undefined ? {} : { app_id: appId }),
  });
  const [latest] = data.check_runs;
  if (latest?.status === status && latest.conclusion === (conclusion ?? null)) {
    if (latest.external_id === externalId) return false;
  }

  const created = await octokit.rest.checks.create({
    owner,
    repo,
    name: GATE_CHECK_NAME,
    head_sha: headSha,
    status,
    ...(conclusion ? { conclusion: conclusion as "success" | "action_required" } : {}),
    external_id: externalId,
    details_url: GATE_DOCS_URL,
    output: {
      title: decision.title,
      summary: `${withRunLink(decision.summary, runUrl)}\n\n[How the Bouncer works](${GATE_DOCS_URL})`,
    },
  });
  if (appId !== undefined && created.data?.app?.id !== appId) {
    throw new GateAppMismatchError(appId, created.data?.app?.id);
  }
  return true;
}

/**
 * True when the commit already has a gate result, which a failure must then replace. With an
 * appId, only a result of that App counts.
 */
export async function hasGateCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  appId?: number
): Promise<boolean> {
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: GATE_CHECK_NAME,
    filter: "latest",
    ...(appId === undefined ? {} : { app_id: appId }),
  });
  return data.check_runs.length > 0;
}
