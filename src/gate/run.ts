import * as core from "@actions/core";
import { quotaLow, readQuota } from "../rate-limit";
import { Octokit } from "../types";
import { hasGateCheck, postGateCheck } from "./check";
import { decideGate, GateDecision } from "./decide";
import { Enrollment, loadEnrollment } from "./enroll";
import { collectFacts, currentHead } from "./facts";

const PULL_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const REVIEW_ACTIONS = new Set(["submitted", "dismissed"]);
const QUEUE_REF = /^refs\/heads\/gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/;

const HOUR_MS = 60 * 60 * 1000;
/** A sweep checks the API budget after each batch of this many pull requests. */
const SWEEP_BATCH_SIZE = 25;

/**
 * Starts the list one batch further along for each hour. A sweep that stops early on a low
 * budget then leaves a different tail each hour, so no pull request waits for good.
 */
function rotateByBatch<T>(items: T[], hour: number): T[] {
  const batches = Math.ceil(items.length / SWEEP_BATCH_SIZE);
  const start = batches > 0 ? (hour % batches) * SWEEP_BATCH_SIZE : 0;
  return [...items.slice(start), ...items.slice(0, start)];
}

export type GateTarget =
  | { kind: "pull"; number: number; headSha?: string }
  | { kind: "queue"; number: number | undefined; sha: string }
  | { kind: "sweep" };

export interface GateEvent {
  eventName: string;
  action?: string;
  payload: {
    pull_request?: { number: number; head?: { sha: string } };
    merge_group?: { head_sha: string; head_ref: string };
    repository?: { default_branch?: string };
  };
}

/** Maps a workflow event to what the gate has to evaluate, or null for an event it ignores. */
export function gateTarget(event: GateEvent): GateTarget | null {
  const { eventName, action, payload } = event;
  const pr = payload.pull_request;

  if (eventName === "schedule") return { kind: "sweep" };
  if (eventName === "merge_group" && action === "checks_requested" && payload.merge_group) {
    const match = QUEUE_REF.exec(payload.merge_group.head_ref);
    return {
      kind: "queue",
      number: match ? Number(match[1]) : undefined,
      sha: payload.merge_group.head_sha,
    };
  }
  if (
    (eventName === "pull_request" || eventName === "pull_request_target") &&
    pr &&
    action &&
    PULL_ACTIONS.has(action)
  ) {
    return { kind: "pull", number: pr.number, headSha: pr.head?.sha };
  }
  if (eventName === "pull_request_review" && pr && action && REVIEW_ACTIONS.has(action)) {
    return { kind: "pull", number: pr.number, headSha: pr.head?.sha };
  }
  return null;
}

interface RepoRef {
  owner: string;
  repo: string;
  runUrl: string;
}

function errorDecision(error: unknown): GateDecision {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    conclusion: "action_required",
    reason: "needs-approval",
    title: "The gate could not decide",
    summary: `The gate failed closed: ${reason}`,
  };
}

function withPolicyNote(decision: GateDecision, enrollment: Enrollment): GateDecision {
  if (!enrollment.policyError || decision.conclusion === "success") return decision;
  return {
    ...decision,
    summary: `${decision.summary} The policy file is invalid, so no family applies: ${enrollment.policyError}`,
  };
}

/**
 * Evaluates one pull request and posts the result. For a queue entry the result goes on the
 * queue's commit instead of the pull request head. An error posts a blocking result on the
 * best known commit: the queue's, the pull request's as of the event, or the one just read.
 */
async function gatePull(
  octokit: Octokit,
  ref: RepoRef,
  enrollment: Enrollment,
  defaultBranch: string,
  number: number | undefined,
  queueSha?: string,
  eventSha?: string
): Promise<void> {
  const { owner, repo, runUrl } = ref;
  let sha = queueSha ?? eventSha;
  try {
    if (number === undefined) throw new Error("The merge queue entry names no pull request.");
    const found = await collectFacts(octokit, owner, repo, number, {
      fetchCompatibility: enrollment.policy.dependabot?.usesCompatibility === true,
    });
    sha = queueSha ?? found.facts.headSha;
    if (found.baseRef !== defaultBranch || found.state !== "open") {
      core.info(`Skipping #${number}: not an open pull request for ${defaultBranch}.`);
      return;
    }
    const decision = withPolicyNote(decideGate(found.facts, enrollment.policy), enrollment);

    // A push during the evaluation makes the result stale. The push triggers its own run.
    if (!queueSha && (await currentHead(octokit, owner, repo, number)) !== found.facts.headSha) {
      core.info(`Skipping #${number}: the head moved during the evaluation.`);
      return;
    }
    const posted = await postGateCheck(octokit, owner, repo, sha, decision, runUrl);
    core.info(
      `#${number}: ${decision.conclusion} (${decision.reason})${posted ? "" : ", unchanged"}`
    );
  } catch (error) {
    core.warning(
      `The gate failed on ${number === undefined ? "a queue entry" : `#${number}`}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (sha) {
      await postGateCheck(octokit, owner, repo, sha, errorDecision(error), runUrl).catch((e) =>
        core.warning(`Could not post the failure result: ${e instanceof Error ? e.message : e}`)
      );
    }
  }
}

/**
 * A failure before the pull request is evaluated leaves an earlier result standing, and an
 * earlier success would let the pull request merge. Replace it with a blocking result. A commit
 * with no result needs nothing: the missing required check already blocks, and a repository
 * that never used the gate gets no stray check.
 */
async function failClosed(
  octokit: Octokit,
  ref: RepoRef,
  target: GateTarget,
  error: unknown
): Promise<boolean> {
  const sha =
    target.kind === "queue" ? target.sha : target.kind === "pull" ? target.headSha : undefined;
  if (!sha) return false;
  try {
    if (!(await hasGateCheck(octokit, ref.owner, ref.repo, sha))) return false;
    await postGateCheck(octokit, ref.owner, ref.repo, sha, errorDecision(error), ref.runUrl);
    return true;
  } catch (e) {
    core.warning(`Could not post the failure result: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Entry point of the gate. Does nothing in a repository that is not enrolled. Never throws,
 * so the Review Router's other work is not blocked by it.
 */
export async function runGate(octokit: Octokit, event: GateEvent, ref: RepoRef): Promise<void> {
  const target = gateTarget(event);
  if (!target) return;

  try {
    const { owner, repo } = ref;
    const defaultBranch =
      event.payload.repository?.default_branch ??
      (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
    const enrollment = await loadEnrollment(octokit, owner, repo, defaultBranch);
    if (!enrollment) {
      core.debug("The gate is not enabled for this repository.");
      return;
    }

    if (target.kind === "sweep") {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        base: defaultBranch,
        per_page: 100,
      });
      core.info(`Gate sweep: ${pulls.length} open pull requests.`);
      const hourOfSweep = Math.floor(Date.now() / HOUR_MS);
      for (const [index, pull] of rotateByBatch(pulls, hourOfSweep).entries()) {
        if (index > 0 && index % SWEEP_BATCH_SIZE === 0) {
          const quota = await readQuota(octokit);
          if (quota && quotaLow(quota)) {
            core.warning(
              `The gate sweep stopped after ${index} of ${pulls.length} open pull requests: ` +
                `${quota.remaining} of ${quota.limit} calls of the API budget remain.`
            );
            break;
          }
        }
        await gatePull(
          octokit,
          ref,
          enrollment,
          defaultBranch,
          pull.number,
          undefined,
          pull.head.sha
        );
      }
    } else if (target.kind === "queue") {
      await gatePull(octokit, ref, enrollment, defaultBranch, target.number, target.sha);
    } else {
      await gatePull(
        octokit,
        ref,
        enrollment,
        defaultBranch,
        target.number,
        undefined,
        target.headSha
      );
    }
  } catch (error) {
    // A warning only where a result stood and was replaced, so a repository that never used
    // the gate sees no new annotation on a transient API error.
    const replaced = await failClosed(octokit, ref, target, error);
    const log = replaced ? core.warning : core.info;
    log(`The gate stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
