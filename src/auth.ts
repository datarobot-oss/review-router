import * as core from "@actions/core";

type Octokit = ReturnType<typeof import("@actions/github").getOctokit>;

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
      "PoC mode: token lacks org-level access. Team review requests and auto-label removal on approval will be skipped."
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
