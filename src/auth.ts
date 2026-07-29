import * as core from "@actions/core";
import { Octokit } from "./types";

export async function detectCapabilities(
  octokit: Octokit,
  org: string
): Promise<{ hasOrgAccess: boolean }> {
  try {
    await octokit.rest.orgs.get({ org });
    core.info("Full mode: token has org-level access");
    return { hasOrgAccess: true };
  } catch {
    core.warning(
      "Token lacks org-level access. Team review requests and auto-label removal on approval will be skipped."
    );
    return { hasOrgAccess: false };
  }
}

export async function isOrgMember(
  octokit: Octokit,
  org: string,
  username: string
): Promise<boolean> {
  try {
    await octokit.rest.orgs.checkMembershipForUser({ org, username });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a user has write or admin permission on the given repo,
 * i.e. is a maintainer. Returns false on API errors (fail-safe: treat as
 * external contributor so the label is not skipped erroneously).
 */
export async function isRepoMaintainer(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return data.permission === "admin" || data.permission === "write";
  } catch (error) {
    core.warning(
      `Failed to check collaborator permission for @${username} on ${owner}/${repo}: ${
        error instanceof Error ? error.message : String(error)
      }. Treating as non-maintainer.`
    );
    return false;
  }
}
