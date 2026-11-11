import * as core from "@actions/core";
import {
  embedDmCursor,
  extractDmCursor,
  findExistingComment,
  isRouterComment,
  removeDmCursor,
} from "./comment";
import { isAiReviewCommand } from "./ai-review/trigger";
import { extractMentions, notifiesAnyone } from "./mentions";
import { handleComment, handleReviewSubmitted, syncReviewCheck } from "./router";
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
  /** The text of the comment, review or approval summary, or null when there is none. */
  body: string | null;
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

/** A person whose comment can notify someone: anyone but a bot, and the author only when mentioning someone. */
function isNotifiable(
  user: Actor | null | undefined,
  author: string,
  body: string | null | undefined
): user is Actor {
  return (
    !!user && notifiesAnyone({ commenter: user.login, author, body, isBot: user.type === "Bot" })
  );
}

/** The live issue_comment path handles these as commands and never notifies on them. */
function isSlashCommand(body: string | null | undefined): boolean {
  return isAiReviewCommand(body ?? undefined) || (body ?? "").trim() === "/review";
}

/** A PR younger than this gets its events replayed on first sight. It outlasts the gap of a weekday-only schedule, which a long weekend stretches past three days. */
const REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the DM cursor starts on a PR the reconciler has not seen. A young PR starts at its
 * creation time, so an event that arrived before the first run still gets its DM. An older PR
 * starts now, so enabling the reconciler on a repository does not replay its backlog.
 */
function firstCursor(pr: PullSummary): string {
  const ageMs = Date.now() - Date.parse(pr.created_at);
  return ageMs < REPLAY_WINDOW_MS ? pr.created_at : new Date().toISOString();
}

interface CursorHome {
  /** The ownership comment, which holds the cursor once the PR is routed. */
  comment: { id: number } | null;
  /** True when an older version left the cursor in the description. */
  descriptionHasCursor: boolean;
}

/**
 * Stores the cursor in the ownership comment, and moves out of the description one an older
 * version left there. A PR with no ownership comment yet keeps the cursor in its description.
 */
async function writeCursor(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  iso: string,
  home: CursorHome
): Promise<void> {
  if (!home.comment) {
    const { data: fresh } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: prNumber,
      body: embedDmCursor(fresh.body ?? "", iso),
    });
    return;
  }

  const { data: freshComment } = await octokit.rest.issues.getComment({
    owner,
    repo,
    comment_id: home.comment.id,
  });
  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: home.comment.id,
    body: embedDmCursor(freshComment.body ?? "", iso),
  });
  if (home.descriptionHasCursor) {
    const { data: freshPr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: prNumber,
      body: removeDmCursor(freshPr.body ?? ""),
    });
  }
}

/**
 * The events that get a DM: the first per commenter, kind and set of mentioned people, so a burst of
 * inline comments does not flood the author, and a comment that mentions someone new still goes out.
 */
function firstOfEachBurst(events: CommentEvent[]): Set<CommentEvent> {
  const seen = new Set<string>();
  const first = new Set<CommentEvent>();
  for (const event of events) {
    const mentioned = extractMentions(event.body)
      .map((login) => login.toLowerCase())
      .sort()
      .join(",");
    const key = `${event.kind}:${event.commenter}:${event.commentUrl === ""}:${mentioned}`;
    if (seen.has(key)) continue;
    seen.add(key);
    first.add(event);
  }
  return first;
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
  const currentApprovers = new Set(latestApprovers(reviews));

  for (const review of reviews) {
    if (!isNewer(review.submitted_at, cursor) || !isNotifiable(review.user, author, review.body)) {
      continue;
    }
    if (review.state === "APPROVED") {
      if (!currentApprovers.has(review.user.login)) continue;
      events.push({
        kind: "review",
        commenter: review.user.login,
        commentUrl: "",
        body: review.body ?? null,
        at: review.submitted_at as string,
      });
    } else if (
      (review.state === "COMMENTED" || review.state === "CHANGES_REQUESTED") &&
      (review.body ?? "").trim().length > 0 &&
      !isRouterComment(review.body)
    ) {
      events.push({
        kind: "review",
        commenter: review.user.login,
        commentUrl: review.html_url ?? "",
        body: review.body ?? null,
        at: review.submitted_at as string,
      });
    }
  }

  // No `since` filter: a comment drafted in a pending review keeps its draft time, so the
  // review's submission time decides whether it is new.
  const submittedAt = new Map(reviews.map((r) => [r.id, r.submitted_at]));
  const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: pr.number,
    per_page: 100,
  });
  for (const c of reviewComments) {
    const at =
      (c.pull_request_review_id && submittedAt.get(c.pull_request_review_id)) || c.created_at;
    if (!isNewer(at, cursor) || !isNotifiable(c.user, author, c.body)) continue;
    events.push({
      kind: "review_comment",
      commenter: c.user.login,
      commentUrl: c.html_url ?? "",
      body: c.body ?? null,
      at,
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
    if (!isNewer(c.created_at, cursor) || !isNotifiable(c.user, author, c.body)) continue;
    if (isRouterComment(c.body) || isSlashCommand(c.body)) continue;
    events.push({
      kind: "comment",
      commenter: c.user.login,
      commentUrl: c.html_url ?? "",
      body: c.body ?? null,
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

  const watchers = [author, ...(pr.assignees ?? []).map((a) => a.login)];
  const watcherCanBeMessaged = watchers.some((login) => ctx.teamsConfig.users?.[login]);
  // A mention can reach any mapped person, whoever is on the PR.
  const anyoneCanBeMessaged = Object.keys(ctx.teamsConfig.users ?? {}).length > 0;
  if (!ctx.inputs.slackToken || !anyoneCanBeMessaged) return;

  const comment = await findExistingComment(octokit, ctx.owner, ctx.repo, pr.number);
  // When only a mention can reach someone, the cursor goes in the router's own comment, never in the description.
  if (!watcherCanBeMessaged && !comment) return;
  const home: CursorHome = {
    comment: comment ? { id: comment.id } : null,
    descriptionHasCursor: extractDmCursor(body) !== null,
  };
  let cursor = (comment && extractDmCursor(comment.body)) ?? extractDmCursor(body);
  if (!cursor) {
    cursor = firstCursor(pr);
    await writeCursor(octokit, ctx.owner, ctx.repo, pr.number, cursor, home);
    if (cursor !== pr.created_at) {
      core.info(`Set the DM cursor on fork PR #${pr.number}; earlier events are not replayed`);
      return;
    }
    core.info(`Set the DM cursor on fork PR #${pr.number} to its creation time`);
  }

  const events = await collectEvents(octokit, ctx, pr, reviews, cursor);
  const toSend = firstOfEachBurst(events);
  let lastHandled: string | undefined;
  try {
    for (const event of events) {
      if (toSend.has(event)) {
        await handleComment(octokit, {
          owner: ctx.owner,
          repo: ctx.repo,
          prNumber: pr.number,
          prBody: body,
          prUrl: pr.html_url ?? "",
          author,
          commenter: event.commenter,
          commentUrl: event.commentUrl,
          body: event.body,
          assignees: (pr.assignees ?? []).map((a) => a.login),
          kind: event.kind,
          inputs: ctx.inputs,
          teamsConfig: ctx.teamsConfig,
        });
      }
      lastHandled = event.at;
    }
  } finally {
    // Keep what was delivered even when a later event throws, so the next run does not re-send it.
    if (lastHandled) {
      await writeCursor(octokit, ctx.owner, ctx.repo, pr.number, lastHandled, home);
    }
  }
}

async function refreshCheck(
  octokit: Octokit,
  ctx: ReconcileContext,
  pr: PullSummary
): Promise<void> {
  await syncReviewCheck(octokit, {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: pr.number,
    headSha: pr.head.sha,
    inputs: ctx.inputs,
    teamsConfig: ctx.teamsConfig,
  });
}

/**
 * Replays what review events could not deliver for open fork PRs, whose workflow runs have no
 * secrets: label removal and the approved reaction on approvals, and DMs for new approvals and
 * comments. For every open PR it also rewrites the review check on the current head, which
 * pushes and hand-removed labels leave behind. Runs from the schedule trigger. Never throws.
 */
export async function reconcileOpenPulls(octokit: Octokit, ctx: ReconcileContext): Promise<void> {
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
    if (pr.head.repo?.full_name !== pr.base.repo.full_name) {
      try {
        await reconcilePull(octokit, ctx, pr);
      } catch (error) {
        core.warning(
          `Failed to reconcile PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    try {
      await refreshCheck(octokit, ctx, pr);
    } catch (error) {
      core.warning(
        `Failed to refresh the review check on PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
