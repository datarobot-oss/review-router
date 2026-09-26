import * as core from "@actions/core";
import * as fs from "fs";
import { Octokit, OrgConfig } from "../types";
import { prepareWorkspace } from "./inputs";
import { PipelineResult, runPipeline } from "./pipeline";
import { CommandRunner, processRunner } from "./process";
import { buildReview, hasReviewForSha, postFailure, postReview, react } from "./publish";
import { runSession } from "./session";
import { resolveAiReviewSettings } from "./settings";
import { ProcessToolRuntime, ToolRuntime } from "./tools";
import { evaluateGates, TriggerKind } from "./trigger";

export const WALL_CLOCK_MS = 15 * 60 * 1000;

/** An error whose message is safe to post on the PR. */
export class AiReviewError extends Error {
  constructor(
    readonly userMessage: string,
    options?: { cause?: unknown }
  ) {
    super(userMessage, options);
  }
}

export interface AiReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  kind: TriggerKind;
  commentId?: number;
  commenterAssociation?: string;
  orgConfig: OrgConfig;
  aiToken: string;
  /** The workflow run, linked from everything the review posts. */
  runUrl?: string;
}

export interface AiReviewDeps {
  runner: CommandRunner;
  tools: ToolRuntime;
  now: () => number;
}

export function defaultDeps(): AiReviewDeps {
  return { runner: processRunner, tools: new ProcessToolRuntime(processRunner), now: Date.now };
}

async function stage<T>(userMessage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new AiReviewError(userMessage, { cause: error });
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/**
 * Returns why a pipeline result can't be posted as a review, or null when it can.
 *
 * With no confirmed findings, any pass or candidate left unfinished would make "no issues" a false
 * all-clear.
 */
function incompleteReason(result: PipelineResult): string | null {
  if (result.findings.length > 0) return null;
  if (result.timedOut) return "stopped at the time limit";
  if (result.failedPasses.length === result.passes.length) return "every review pass failed";
  if (result.skippedCandidates > 0) return "ran out of budget before scoring every candidate";
  if (result.failedCandidates === 0) return null;
  return result.failedCandidates === result.scoredCandidates
    ? "every scoring session failed"
    : "a scoring session failed";
}

/** Runs one AI review end to end: gates, workspace, tools, pipeline, and the posted review. */
export async function runAiReview(
  octokit: Octokit,
  req: AiReviewRequest,
  deps: AiReviewDeps = defaultDeps()
): Promise<void> {
  // Cheap checks first, so repos without the feature cost no API calls.
  if (!req.aiToken || !resolveAiReviewSettings(req.orgConfig, req.repo)) return;

  const { data: pr } = await octokit.rest.pulls.get({
    owner: req.owner,
    repo: req.repo,
    pull_number: req.prNumber,
  });
  const gate = evaluateGates({
    kind: req.kind,
    settings: resolveAiReviewSettings(req.orgConfig, req.repo),
    aiToken: req.aiToken,
    prState: pr.state,
    headRepo: pr.head.repo?.full_name,
    baseRepo: pr.base.repo?.full_name,
    authorType: pr.user?.type,
    commenterAssociation: req.commenterAssociation,
  });
  if (!gate.run) {
    core.info(`AI review skipped: ${gate.reason}`);
    return;
  }
  if (
    req.kind === "label" &&
    (await hasReviewForSha(octokit, req.owner, req.repo, req.prNumber, pr.head.sha))
  ) {
    core.info(`AI review skipped: ${pr.head.sha} already reviewed`);
    return;
  }

  const settings = gate.settings;
  const started = deps.now();
  if (req.commentId) await react(octokit, req.owner, req.repo, req.commentId, "eyes");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WALL_CLOCK_MS);
  let workspaceRoot: string | undefined;
  try {
    const ws = await stage("could not download the PR", () =>
      prepareWorkspace(
        octokit,
        deps.runner,
        req.owner,
        req.repo,
        {
          number: pr.number,
          title: pr.title,
          body: pr.body ?? "",
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          baseRef: pr.base.ref,
        },
        controller.signal
      )
    );
    workspaceRoot = ws.root;
    const claudeBin = await stage("could not install the review tools", () =>
      deps.tools.install(controller.signal)
    );
    const proxy = await stage("could not start the LLM proxy", () =>
      deps.tools.startProxy(settings.endpoint, req.aiToken)
    );
    const result = await runPipeline(
      (spec) => runSession(deps.runner, claudeBin, proxy, spec, controller.signal),
      ws,
      settings,
      controller.signal
    );
    const incomplete = incompleteReason(result);
    if (incomplete) throw new AiReviewError(incomplete);
    const review = buildReview(result.findings, ws.files, {
      headSha: pr.head.sha,
      reviewerModel: settings.reviewerModel,
      scorerModel: settings.scorerModel,
      seconds: Math.round((deps.now() - started) / 1000),
      failedPasses: result.failedPasses,
      skippedCandidates: result.skippedCandidates,
      failedCandidates: result.failedCandidates,
      timedOut: result.timedOut,
      runUrl: req.runUrl,
    });
    await stage("could not post the review", () =>
      postReview(octokit, req.owner, req.repo, req.prNumber, pr.head.sha, review)
    );
    if (req.commentId) await react(octokit, req.owner, req.repo, req.commentId, "hooray");
    core.info(
      `AI review posted: ${result.findings.length} findings, $${result.costUsd.toFixed(2)} at list price`
    );
  } catch (error) {
    core.warning(`AI review failed: ${errorText(error)}`);
    const reason =
      error instanceof AiReviewError
        ? error.userMessage
        : "unexpected error, see the workflow logs";
    if (req.commentId) await react(octokit, req.owner, req.repo, req.commentId, "confused");
    await postFailure(octokit, req.owner, req.repo, req.prNumber, reason, req.runUrl).catch((e) =>
      core.warning(`Could not post the failure comment: ${errorText(e)}`)
    );
  } finally {
    clearTimeout(timer);
    deps.tools.stop();
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

/** Runs the AI review without ever failing the router's job. */
export async function runAiReviewSafely(octokit: Octokit, req: AiReviewRequest): Promise<void> {
  try {
    await runAiReview(octokit, req);
  } catch (error) {
    core.warning(`AI review crashed: ${errorText(error)}`);
  }
}
