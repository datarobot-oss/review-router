import * as core from "@actions/core";
import { Octokit } from "../types";
import { GATE_CHECK_NAME } from "./check";
import { GatePolicy, parsePolicy, POLICY_PATH } from "./policy";

export interface Enrollment {
  policy: GatePolicy;
  /** Set when the policy file exists but can't be read as a policy. No family applies then. */
  policyError?: string;
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number }).status === 404;
}

/** The policy file's text on the default branch, or undefined when the file does not exist. */
async function readPolicyFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: POLICY_PATH,
      ref: defaultBranch,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      throw new Error(`${POLICY_PATH} is not a file.`);
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * True when a rule on the default branch requires the gate check. Throws when the rules can't be
 * read: a repository enrolled only through its ruleset must not drop out on a transient error.
 */
async function gateIsRequired(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string
): Promise<boolean> {
  const rules = await octokit.paginate(octokit.rest.repos.getBranchRules, {
    owner,
    repo,
    branch: defaultBranch,
    per_page: 100,
  });
  return rules.some(
    (rule) =>
      rule.type === "required_status_checks" &&
      "parameters" in rule &&
      rule.parameters?.required_status_checks.some((check) => check.context === GATE_CHECK_NAME)
  );
}

/**
 * Decides whether the repository uses the gate, and under which policy. A repository is
 * enrolled when its default branch requires the gate check or holds a policy file. The policy
 * comes from the default branch only, so a pull request can't change the rules it is judged by.
 * Returns null for a repository that is not enrolled.
 */
export async function loadEnrollment(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string
): Promise<Enrollment | null> {
  const text = await readPolicyFile(octokit, owner, repo, defaultBranch);
  if (text === undefined) {
    return (await gateIsRequired(octokit, owner, repo, defaultBranch)) ? { policy: {} } : null;
  }
  try {
    return { policy: parsePolicy(text) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(`${POLICY_PATH} is invalid: ${reason}`);
    return { policy: {}, policyError: reason };
  }
}
