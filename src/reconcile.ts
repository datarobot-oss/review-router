import * as core from "@actions/core";
import { COMMENT_MARKER, EXTERNAL_COMMENT_MARKER, embedDmCursor, extractDmCursor } from "./comment";
import { handleComment, handleReviewSubmitted } from "./router";
import { ActionInputs, Capabilities, CommentContext, OrgConfig, Octokit } from "./types";

export interface ReconcileContext {
  owner: string;
  repo: string;
  inputs: ActionInputs;
  capabilities: Capabilities;
  teamsConfig: OrgConfig;
}

interface ReviewLike {
  user: { login: string } | null;
  state: string;
}

interface Actor {
  login: string;
  type?: string;
}

interface CommentEvent {
  kind: CommentContext["kind"];
  commenter: string;
  commentUrl: string;
  at: string;
}

/** Logins whose latest non-COMMENTED review is an approval. Reviews must be in chronological order. */
export function latestApprovers(reviews: ReviewLike[]): string[] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (!review.user || review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(review.user.login, review.state);
  }
  return [...latest].filter(([, state]) => state === "APPROVED").map(([login]) => login);
}

function isNewer(at: string | null | undefined, cursor: string): boolean {
  return !!at && Date.parse(at) > Date.parse(cursor);
}

function isRealPerson(user: Actor | null | undefined, author: string): user is Actor {
  return !!user && user.type !== "Bot" && user.login !== author;
}

function isRouterComment(body: string | null | undefined): boolean {
  return !!body && (body.includes(COMMENT_MARKER) || body.includes(EXTERNAL_COMMENT_MARKER));
}

async function writeCursor(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  iso: string
): Promise<void> {
  const { data: fresh } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body: embedDmCursor(fresh.body ?? "", iso),
  });
}

type PullSummary = Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"][number];

async function collectEvents(
  octokit: Octokit,
  ctx: ReconcileContext,
  pr: PullSummary,
  reviews: Awaited<ReturnType<Octokit["rest"]["pulls"]["listReviews"]>>["data"],
  cursor: string
): Promise<CommentEvent[]> {
  const author = pr.user?.login ?? "";
  const events: CommentEvent[] = [];

  for (const review of reviews) {
    if (!isNewer(review.submitted_at, cursor) || !isRealPerson(review.user, author)) continue;
    if (review.state === "APPROVED") {
      events.push({
        kind: "review",
        commenter: review.user.login,
        commentUrl: "",
        at: review.submitted_at as string,
      });
    } else if (
      review.state === "COMMENTED" &&
      (review.body ?? "").trim().length > 0 &&
      !isRouterComment(review.body)
    ) {
      events.push({
        kind: "review",
        commenter: review.user.login,
        commentUrl: review.html_url ?? "",
        at: review.submitted_at as string,
      });
    }
  }

  const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: pr.number,
    since: cursor,
    per_page: 100,
  });
  for (const c of reviewComments) {
    if (!isNewer(c.created_at, cursor) || !isRealPerson(c.user, author)) continue;
    events.push({
      kind: "review_comment",
      commenter: c.user.login,
      commentUrl: c.html_url ?? "",
      at: c.created_at,
    });
  }

  const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: pr.number,
    since: cursor,
    per_page: 100,
  });
  for (const c of issueComments) {
    if (!isNewer(c.created_at, cursor) || !isRealPerson(c.user, author)) continue;
    if (isRouterComment(c.body)) continue;
    events.push({
      kind: "comment",
      commenter: c.user.login,
      commentUrl: c.html_url ?? "",
      at: c.created_at,
    });
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

async function reconcilePull(
  octokit: Octokit,
  ctx: ReconcileContext,
  pr: PullSummary
): Promise<void> {
  const author = pr.user?.login ?? "";
  const body = pr.body ?? "";
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  for (const reviewer of latestApprovers(reviews)) {
    await handleReviewSubmitted(octokit, {
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: pr.number,
      prBody: body,
      prUrl: pr.html_url ?? "",
      author,
      reviewer,
      inputs: ctx.inputs,
      capabilities: ctx.capabilities,
      teamsConfig: ctx.teamsConfig,
      headSha: pr.head.sha,
    });
  }

  const cursor = extractDmCursor(body);
  if (!cursor) {
    await writeCursor(octokit, ctx.owner, ctx.repo, pr.number, new Date().toISOString());
    core.info(`Set the DM cursor on fork PR #${pr.number}; earlier events are not replayed`);
    return;
  }

  const events = await collectEvents(octokit, ctx, pr, reviews, cursor);
  for (const event of events) {
    await handleComment(octokit, {
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: pr.number,
      prBody: body,
      prUrl: pr.html_url ?? "",
      author,
      commenter: event.commenter,
      commentUrl: event.commentUrl,
      assignees: (pr.assignees ?? []).map((a) => a.login),
      kind: event.kind,
      inputs: ctx.inputs,
      teamsConfig: ctx.teamsConfig,
    });
  }

  if (events.length > 0) {
    await writeCursor(octokit, ctx.owner, ctx.repo, pr.number, events[events.length - 1].at);
  }
}

/**
 * Replays what review events could not deliver for open fork PRs, whose workflow runs have no
 * secrets: label removal and the approved reaction on approvals, and DMs for new approvals and
 * comments. Runs from the schedule trigger. Never throws.
 */
export async function reconcileForkPulls(octokit: Octokit, ctx: ReconcileContext): Promise<void> {
  let pulls: PullSummary[];
  try {
    pulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner: ctx.owner,
      repo: ctx.repo,
      state: "open",
      per_page: 100,
    });
  } catch (error) {
    core.warning(
      `Failed to list open PRs for reconciliation: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  for (const pr of pulls) {
    if (pr.head.repo?.full_name === pr.base.repo.full_name) continue;
    try {
      await reconcilePull(octokit, ctx, pr);
    } catch (error) {
      core.warning(
        `Failed to reconcile PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
