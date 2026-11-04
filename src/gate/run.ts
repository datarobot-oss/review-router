import * as core from "@actions/core";
import { Octokit } from "../types";
import { postGateCheck } from "./check";
import { decideGate, GateDecision } from "./decide";
import { Enrollment, loadEnrollment } from "./enroll";
import { collectFacts, currentHead } from "./facts";

const PULL_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);
const REVIEW_ACTIONS = new Set(["submitted", "dismissed", "edited"]);
const QUEUE_REF = /^refs\/heads\/gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/;

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
    const found = await collectFacts(octokit, owner, repo, number);
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
      for (const pull of pulls) {
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
    core.warning(`The gate stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
