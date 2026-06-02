import * as core from "@actions/core";
import {
  fetchCodeownersContent,
  parseCodeowners,
  mapFilesToTeams,
} from "./codeowners";
import { ensureLabel, applyLabel, removeLabel } from "./labels";
import {
  buildOwnershipComment,
  upsertComment,
  COMMENT_MARKER,
} from "./comment";
import { sendSlackNotification, FileStats } from "./slack";
import { getLabelForTeam, getSlackChannel } from "./config";
import { ActionInputs, Capabilities, OrgConfig, Octokit } from "./types";

export interface LabeledContext {
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  prUrl: string;
  prTitle: string;
  author: string;
  additions: number;
  deletions: number;
  commits: number;
  labels: string[];
  inputs: ActionInputs;
  capabilities: Capabilities;
  teamsConfig: OrgConfig;
}

export interface ReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
  reviewer: string;
  inputs: ActionInputs;
  capabilities: Capabilities;
  teamsConfig: OrgConfig;
}

export async function handleLabeled(
  octokit: Octokit,
  ctx: LabeledContext
): Promise<void> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  const filenames = files.map((f: { filename: string }) => f.filename);
  const fileStatsMap = new Map<string, FileStats>();
  for (const f of files as Array<{ filename: string; additions: number; deletions: number }>) {
    fileStatsMap.set(f.filename, { filename: f.filename, additions: f.additions, deletions: f.deletions });
  }
  core.info(`PR #${ctx.prNumber} has ${filenames.length} changed files`);

  const codeownersContent = await fetchCodeownersContent(
    octokit,
    ctx.owner,
    ctx.repo,
    ctx.baseBranch
  );

  if (codeownersContent === null) {
    const warningBody = `${COMMENT_MARKER}\n⚠️ No \`.github/CODEOWNERS\` file found on the \`${ctx.baseBranch}\` branch. Review routing skipped.\n\nPlease add a CODEOWNERS file to enable automatic review routing.`;
    await upsertComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, warningBody);
    core.warning("No CODEOWNERS file found, skipping review routing");
    return;
  }

  const entries = parseCodeowners(codeownersContent);
  const ownership = mapFilesToTeams(filenames, entries);

  const allFileStats = filenames
    .map((f) => fileStatsMap.get(f))
    .filter((s): s is FileStats => s !== undefined);

  core.info(
    `Found ${ownership.teamFiles.size} team(s), ${ownership.unownedFiles.length} unowned file(s)`
  );

  const notifiedChannels = new Set<string>();

  for (const [teamSlug] of ownership.teamFiles) {
    const labelName = getLabelForTeam(
      ctx.teamsConfig,
      teamSlug,
      ctx.inputs.needsReviewPrefix
    );

    await ensureLabel(
      octokit,
      ctx.owner,
      ctx.repo,
      labelName,
      ctx.inputs.needsReviewLabelColor
    );
    await applyLabel(octokit, ctx.owner, ctx.repo, ctx.prNumber, labelName);

    if (ctx.capabilities.hasOrgAccess) {
      try {
        await octokit.rest.pulls.requestReviewers({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
          team_reviewers: [teamSlug],
        });
        core.info(`Requested review from team ${teamSlug}`);
      } catch (error) {
        core.warning(
          `Failed to request review from team ${teamSlug}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      core.info(
        `Skipping team review request for ${teamSlug} (no org access)`
      );
    }

    const slackChannel = getSlackChannel(ctx.teamsConfig, teamSlug);
    if (slackChannel && ctx.inputs.slackToken && !notifiedChannels.has(slackChannel)) {
      notifiedChannels.add(slackChannel);
      const displayLabels = ctx.labels.filter(
        (l) => !l.startsWith(ctx.inputs.needsReviewPrefix) && l !== ctx.inputs.readyLabel
      );
      await sendSlackNotification(ctx.inputs.slackToken, slackChannel, {
        prUrl: ctx.prUrl,
        prTitle: ctx.prTitle,
        prNumber: ctx.prNumber,
        orgName: ctx.owner,
        repoName: ctx.repo,
        baseBranch: ctx.baseBranch,
        author: ctx.author,
        additions: ctx.additions,
        deletions: ctx.deletions,
        commits: ctx.commits,
        labels: displayLabels,
        allFiles: allFileStats,
      });
    }
  }

  const commentBody = buildOwnershipComment(ownership, ctx.capabilities.hasOrgAccess);
  await upsertComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, commentBody);

  await removeLabel(octokit, ctx.owner, ctx.repo, ctx.prNumber, ctx.inputs.readyLabel);
}

export async function handleReviewSubmitted(
  octokit: Octokit,
  ctx: ReviewContext
): Promise<void> {
  if (!ctx.capabilities.hasOrgAccess) {
    core.info(
      "Skipping label removal on approval (no org access)"
    );
    return;
  }

  const { data: prLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
  });

  const needsReviewLabels = prLabels.filter((l: { name: string }) =>
    l.name.startsWith(ctx.inputs.needsReviewPrefix + ":")
  );

  if (needsReviewLabels.length === 0) {
    core.info("No 'Needs Review' labels found on PR, nothing to remove");
    return;
  }

  for (const label of needsReviewLabels) {
    const teamSlug = resolveTeamSlugFromLabel(label.name, ctx.teamsConfig, ctx.inputs.needsReviewPrefix);
    if (!teamSlug) continue;

    try {
      await octokit.rest.teams.getMembershipForUserInOrg({
        org: ctx.owner,
        team_slug: teamSlug,
        username: ctx.reviewer,
      });
      await removeLabel(octokit, ctx.owner, ctx.repo, ctx.prNumber, label.name);
      core.info(
        `Removed "${label.name}" — reviewer ${ctx.reviewer} is a member of ${teamSlug}`
      );
    } catch (error: unknown) {
      const httpError = error as { status?: number };
      if (httpError.status === 404) {
        core.debug(
          `Reviewer ${ctx.reviewer} is not a member of team ${teamSlug}`
        );
      } else {
        core.warning(
          `Error checking team membership for ${ctx.reviewer} in ${teamSlug}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

export function resolveTeamSlugFromLabel(
  labelName: string,
  teamsConfig: OrgConfig,
  prefix: string
): string | undefined {
  for (const [slug, cfg] of Object.entries(teamsConfig.teams)) {
    if (cfg.label === labelName) {
      return slug;
    }
  }
  const suffix = labelName.replace(`${prefix}: `, "");
  if (!suffix) return undefined;
  return suffix.toLowerCase().replace(/\s+/g, "-");
}
