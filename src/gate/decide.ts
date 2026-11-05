import { DependencyFacts, evaluateDependencies } from "./dependabot";
import { DependabotPolicy, GatePolicy, matchesAny } from "./policy";

export const DEPENDABOT_LOGIN = "dependabot[bot]";
const GITHUB_WEB_COMMITTER = "web-flow";
const DEPENDABOT_BRANCH_PREFIX = "dependabot/";
const WORKFLOW_DIRECTORY = ".github/";

export interface CommitFacts {
  authorLogin: string | null;
  committerLogin: string | null;
  verified: boolean;
  message: string;
}

/** The latest review of one reviewer, with the review's state resolved. */
export interface ReviewFacts {
  user: string;
  userType: string;
  state: "APPROVED" | "CHANGES_REQUESTED";
  commitId: string;
  canWrite: boolean;
}

export interface GateFacts {
  author: string;
  authorType: string;
  isFork: boolean;
  headRef: string;
  headSha: string;
  /** Changed paths. A renamed file appears under both its new and its previous name. */
  files: string[];
  /** Number of changed files as GitHub counts them, so a rename counts once. */
  changedFileCount: number;
  /** Everyone who pushed to the head branch, from the repository's push history. */
  pushers: string[];
  commits: CommitFacts[];
  /** The dependencies Dependabot lists, with scores when the policy needs them. Empty for other authors. */
  dependencies: DependencyFacts[];
  reviews: ReviewFacts[];
}

export type GateReason = "approved" | "dependabot" | "changes-requested" | "needs-approval";

export interface GateDecision {
  conclusion: "success" | "action_required";
  reason: GateReason;
  title: string;
  summary: string;
}

type FamilyResult = { ok: true; summary: string } | { ok: false; why: string };

function commitUsers(facts: GateFacts): Set<string> {
  const users = new Set<string>();
  for (const commit of facts.commits) {
    if (commit.authorLogin) users.add(commit.authorLogin);
    if (commit.committerLogin) users.add(commit.committerLogin);
  }
  // Commit emails can name anyone or nobody, so the push history is what proves who pushed.
  facts.pushers.forEach((pusher) => users.add(pusher));
  return users;
}

/** A person other than the author or a committer, with write access, approved the current head. */
function findApprover(facts: GateFacts): string | undefined {
  const involved = commitUsers(facts);
  return facts.reviews.find(
    (review) =>
      review.state === "APPROVED" &&
      review.userType === "User" &&
      review.canWrite &&
      review.commitId === facts.headSha &&
      review.user !== facts.author &&
      !involved.has(review.user)
  )?.user;
}

function findChangeRequest(facts: GateFacts): string | undefined {
  return facts.reviews.find(
    (review) =>
      review.state === "CHANGES_REQUESTED" && review.userType === "User" && review.canWrite
  )?.user;
}

function evaluateDependabot(facts: GateFacts, policy: DependabotPolicy | undefined): FamilyResult {
  if (facts.author !== DEPENDABOT_LOGIN || facts.authorType !== "Bot") {
    return { ok: false, why: "The author is not Dependabot." };
  }
  if (!policy) {
    return { ok: false, why: "The repository does not enable the Dependabot family." };
  }
  if (facts.isFork || !facts.headRef.startsWith(DEPENDABOT_BRANCH_PREFIX)) {
    return { ok: false, why: "The branch is not a Dependabot branch of this repository." };
  }
  if (facts.commits.length === 0) {
    return { ok: false, why: "The pull request has no commits." };
  }
  // The commit fields below can be set by any token that may write to the branch.
  if (facts.pushers.length === 0 || facts.pushers.some((pusher) => pusher !== DEPENDABOT_LOGIN)) {
    return { ok: false, why: "An account other than Dependabot pushed to the branch." };
  }
  for (const commit of facts.commits) {
    if (
      commit.authorLogin !== DEPENDABOT_LOGIN ||
      commit.committerLogin !== GITHUB_WEB_COMMITTER ||
      !commit.verified
    ) {
      return {
        ok: false,
        why: "A commit is not a verified Dependabot commit (author, committer and signature).",
      };
    }
  }

  if (facts.files.length === 0) {
    return { ok: false, why: "The pull request changes no file." };
  }
  if (facts.changedFileCount > policy.maxChangedFiles) {
    return { ok: false, why: `It changes more than ${policy.maxChangedFiles} files.` };
  }
  const workflow = facts.files.find((file) => file.startsWith(WORKFLOW_DIRECTORY));
  if (workflow) return { ok: false, why: `It changes \`${workflow}\`.` };
  const outside = facts.files.find((file) => !matchesAny(file, policy.allowedPaths));
  if (outside) return { ok: false, why: `\`${outside}\` is outside the allowed paths.` };

  const dependencies = evaluateDependencies(facts.dependencies, policy);
  if (!dependencies.ok) return { ok: false, why: dependencies.why };
  return { ok: true, summary: dependencies.summary };
}

/**
 * Decides the "Bouncer" state of one pull request from plain facts.
 * Order: a writer's change request blocks, a person's approval passes, a policy family
 * passes, everything else waits for a person.
 */
export function decideGate(facts: GateFacts, policy: GatePolicy): GateDecision {
  const changeRequester = findChangeRequest(facts);
  if (changeRequester) {
    return {
      conclusion: "action_required",
      reason: "changes-requested",
      title: "Changes requested",
      summary: `@${changeRequester} requested changes. The pull request needs a new review from them or a dismissal.`,
    };
  }

  const approver = findApprover(facts);
  if (approver) {
    return {
      conclusion: "success",
      reason: "approved",
      title: "Approved",
      summary: `@${approver} approved the current commit.`,
    };
  }

  const family = evaluateDependabot(facts, policy.dependabot);
  if (family.ok) {
    return {
      conclusion: "success",
      reason: "dependabot",
      title: "Dependabot update",
      summary: family.summary,
    };
  }

  const why = facts.author === DEPENDABOT_LOGIN ? ` ${family.why}` : "";
  return {
    conclusion: "action_required",
    reason: "needs-approval",
    title: "Waiting for an approval",
    summary: `A person with write access, other than the author and committers, must approve the latest commit.${why}`,
  };
}
