import { Octokit } from "../types";
import { CommitFacts, GateFacts, ReviewFacts } from "./decide";

// The pull request commits and files endpoints stop listing at these counts.
const MAX_COMMITS = 250;
const MAX_FILES = 3000;
const PAGE_SIZE = 100;

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
  // Not caught: a failed lookup must fail the gate closed, not read as "no access".
  const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username,
  });
  const allowed = data.permission === "admin" || data.permission === "write";
  cache.set(username, allowed);
  return allowed;
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

  const params = { owner, repo, pull_number: prNumber, per_page: PAGE_SIZE };
  const [rawFiles, rawCommits, rawReviews] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listFiles, params),
    octokit.paginate(octokit.rest.pulls.listCommits, params),
    octokit.paginate(octokit.rest.pulls.listReviews, params),
  ]);
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
