import { Octokit } from "../types";
import { CommitFacts, GateFacts, ReviewFacts } from "./decide";

// The pull request commits and files endpoints stop listing at these counts.
const MAX_COMMITS = 250;
const MAX_FILES = 3000;
const PAGE_SIZE = 100;
const PUSH_ACTIVITIES = new Set(["push", "force_push", "branch_creation"]);

export interface PullRequestFacts {
  facts: GateFacts;
  baseRef: string;
  state: string;
}

interface RawReview {
  state: string;
  commit_id?: string | null;
  user: { login: string; type: string } | null;
}

/**
 * Resolves the reviews in order to one standing review per person: an approval or a change
 * request replaces the earlier one, a dismissal removes it, a plain comment changes nothing.
 */
export function standingReviews(reviews: RawReview[]): Map<string, RawReview> {
  const standing = new Map<string, RawReview>();
  for (const review of reviews) {
    if (!review.user) continue;
    const state = review.state.toUpperCase();
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") {
      standing.set(review.user.login, review);
    } else if (state === "DISMISSED") {
      standing.delete(review.user.login);
    }
  }
  return standing;
}

async function canWrite(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
  cache: Map<string, boolean>
): Promise<boolean> {
  const known = cache.get(username);
  if (known !== undefined) return known;
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    const allowed = data.permission === "admin" || data.permission === "write";
    cache.set(username, allowed);
    return allowed;
  } catch (error) {
    // Anyone can review a public repository, and a stranger has no permission to look up.
    // Any other failure must fail the gate closed, not read as "no access".
    if ((error as { status?: number }).status !== 404) throw error;
    cache.set(username, false);
    return false;
  }
}

/**
 * Lists everyone who created or pushed to the branch, from the repository's activity feed of
 * the head repository. A full page may hide older pushes, so it fails instead of guessing.
 */
async function readPushers(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<string[]> {
  const { data } = await octokit.rest.repos.listActivities({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    per_page: PAGE_SIZE,
  });
  if (data.length >= PAGE_SIZE) {
    throw new Error(`The branch has ${PAGE_SIZE} or more pushes on record.`);
  }
  const pushers = data
    .filter((activity) => PUSH_ACTIVITIES.has(activity.activity_type))
    .map((activity) => activity.actor?.login ?? "(unknown)");
  return [...new Set(pushers)];
}

/** Reads everything the decision needs. Throws when a list is cut short or a call fails. */
export async function collectFacts(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestFacts> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.commits > MAX_COMMITS) {
    throw new Error(`The pull request has more than ${MAX_COMMITS} commits.`);
  }
  if (pr.changed_files > MAX_FILES) {
    throw new Error(`The pull request changes more than ${MAX_FILES} files.`);
  }

  if (!pr.head.repo) throw new Error("The head repository of the pull request is gone.");
  const params = { owner, repo, pull_number: prNumber, per_page: PAGE_SIZE };
  const [rawFiles, rawCommits, pushers] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listFiles, params),
    octokit.paginate(octokit.rest.pulls.listCommits, params),
    readPushers(octokit, pr.head.repo.owner.login, pr.head.repo.name, pr.head.ref),
  ]);
  // Last, so the reviews are as fresh as the write that follows.
  const rawReviews = await octokit.paginate(octokit.rest.pulls.listReviews, params);
  if (rawCommits.length < pr.commits || rawFiles.length < pr.changed_files) {
    throw new Error("GitHub returned fewer commits or files than the pull request has.");
  }

  const files = rawFiles.flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]
  );
  const commits: CommitFacts[] = rawCommits.map((commit) => ({
    authorLogin: commit.author?.login ?? null,
    committerLogin: commit.committer?.login ?? null,
    verified: commit.commit.verification?.verified === true,
    message: commit.commit.message,
  }));

  const cache = new Map<string, boolean>();
  const reviews: ReviewFacts[] = [];
  for (const review of standingReviews(rawReviews as RawReview[]).values()) {
    reviews.push({
      user: review.user!.login,
      userType: review.user!.type,
      state: review.state.toUpperCase() as ReviewFacts["state"],
      commitId: review.commit_id ?? "",
      canWrite: await canWrite(octokit, owner, repo, review.user!.login, cache),
    });
  }

  return {
    baseRef: pr.base.ref,
    state: pr.state,
    facts: {
      author: pr.user?.login ?? "",
      authorType: pr.user?.type ?? "",
      isFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      files,
      changedFileCount: rawFiles.length,
      pushers,
      commits,
      reviews,
    },
  };
}

/** The current head commit of a pull request. */
export async function currentHead(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return data.head.sha;
}
