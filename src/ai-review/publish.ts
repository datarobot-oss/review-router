import * as core from "@actions/core";
import { Octokit } from "../types";
import { PrFile } from "./inputs";
import { ScoredFinding } from "./pipeline";
import { PassName } from "./prompts";

export const MARKER_PREFIX = "<!-- ai-review sha=";

export function reviewMarker(sha: string): string {
  return `${MARKER_PREFIX}${sha} -->`;
}

export interface ReviewMeta {
  headSha: string;
  reviewerModel: string;
  scorerModel: string;
  seconds: number;
  failedPasses: PassName[];
  skippedCandidates: number;
  failedCandidates: number;
  timedOut: boolean;
  runUrl?: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export interface ReviewPayload {
  body: string;
  comments: ReviewComment[];
}

export type Reaction = "eyes" | "hooray" | "confused";

/** Returns the new-side line numbers a review comment can anchor to in one file's patch. */
export function rightSideLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || line === "" || line.startsWith("-") || line.startsWith("\\")) continue;
    lines.add(next++);
  }
  return lines;
}

/**
 * Neutralizes model text: no pings, and no HTML comments that could forge the marker.
 * Code spans get the same treatment: telling them apart takes a full Markdown parser, and a
 * wrong guess leaves a live mention.
 */
export function sanitize(text: string): string {
  return text.replace(/<!--/g, "&lt;!--").replace(/@(?=[A-Za-z0-9-])/g, "@\u200b");
}

/** Renders a location heading; backticks are dropped so a model-written path stays in its code span. */
function locationHeading(path: string, line: number): string {
  return `#### \`${path.replace(/`/g, "")}:${line}\``;
}

function formatFinding(f: ScoredFinding): string {
  return `**${f.severity}** · ${sanitize(f.title)}\n\n${sanitize(f.body)}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m > 0 ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}

function footer(meta: ReviewMeta): string {
  const models =
    meta.reviewerModel === meta.scorerModel
      ? meta.reviewerModel
      : `${meta.reviewerModel}, scorer ${meta.scorerModel}`;
  const notes = [
    ...meta.failedPasses.map((p) => `${p} pass failed`),
    ...(meta.skippedCandidates ? [`${meta.skippedCandidates} candidates not scored (budget)`] : []),
    ...(meta.failedCandidates ? [`${meta.failedCandidates} candidates failed scoring`] : []),
    ...(meta.timedOut ? ["stopped at the time limit"] : []),
  ];
  const parts = [
    "AI review via DataRobot LLM Gateway",
    models,
    formatDuration(meta.seconds),
    ...notes,
    ...(meta.runUrl ? [`[workflow run](${meta.runUrl})`] : []),
  ];
  return `<sub>${parts.join(" · ")}</sub>`;
}

/** Builds the review: inline comments on diff lines, everything else in the body. */
export function buildReview(
  findings: ScoredFinding[],
  files: PrFile[],
  meta: ReviewMeta
): ReviewPayload {
  const anchorable = new Map(files.map((f) => [f.filename, rightSideLines(f.patch ?? "")]));
  const comments: ReviewComment[] = [];
  const outside: string[] = [];
  for (const f of findings) {
    if (anchorable.get(f.path)?.has(f.line)) {
      comments.push({ path: f.path, line: f.line, side: "RIGHT", body: formatFinding(f) });
    } else {
      outside.push(`${locationHeading(f.path, f.line)}\n\n${formatFinding(f)}`);
    }
  }
  const summary =
    findings.length === 0
      ? "No issues found."
      : `Found ${findings.length} issue${findings.length === 1 ? "" : "s"}.`;
  const body = [summary, ...outside, footer(meta), reviewMarker(meta.headSha)].join("\n\n");
  return { body, comments };
}

/** Posts the review, moving every finding into the body if GitHub rejects an inline anchor. */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  review: ReviewPayload
): Promise<void> {
  const base = {
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "COMMENT" as const,
  };
  try {
    await octokit.rest.pulls.createReview({
      ...base,
      body: review.body,
      comments: review.comments,
    });
  } catch (error) {
    if ((error as { status?: number }).status !== 422 || review.comments.length === 0) throw error;
    const moved = review.comments
      .map((c) => `${locationHeading(c.path, c.line)}\n\n${c.body}`)
      .join("\n\n");
    await octokit.rest.pulls.createReview({ ...base, body: `${moved}\n\n${review.body}` });
  }
}

export async function hasReviewForSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  sha: string
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  // Anyone can post a review, so only the bot's own marker counts.
  return reviews.some(
    (r: { body?: string | null; user?: { type?: string } | null }) =>
      r.user?.type === "Bot" && (r.body ?? "").includes(reviewMarker(sha))
  );
}

export async function react(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: Reaction
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch (error) {
    core.warning(
      `Could not add ${content} reaction: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function postFailure(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  reason: string,
  runUrl?: string
): Promise<void> {
  const link = runUrl ? ` See the [workflow run](${runUrl}).` : "";
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `AI review couldn't finish: ${reason}.${link}`,
  });
}
