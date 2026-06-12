import * as core from "@actions/core";
import { fetchCodeownersContent, parseCodeowners, mapFilesToTeams } from "./codeowners";
import { ensureLabel, applyLabel, removeLabel } from "./labels";
import {
  buildOwnershipComment,
  upsertComment,
  COMMENT_MARKER,
  embedSlackRefs,
  mergeSlackRefs,
  findExistingComment,
  extractSlackRefs,
} from "./comment";
import { sendSlackNotification, addSlackReactions, FileStats, SlackMessageRef } from "./slack";
import { getLabelForTeam, getSlackChannel } from "./config";
import { ActionInputs, Capabilities, ReactionsConfig, OrgConfig, Octokit } from "./types";

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

export async function handleLabeled(octokit: Octokit, ctx: LabeledContext): Promise<void> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  const filenames = files.map((f: { filename: string }) => f.filename);
  const fileStatsMap = new Map<string, FileStats>();
  for (const f of files as Array<{ filename: string; additions: number; deletions: number }>) {
    fileStatsMap.set(f.filename, {
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
    });
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

  const channelIndividualOwners = new Map<string, Set<string>>();
  for (const [teamSlug, teamFileList] of ownership.teamFiles) {
    const slackChannel = getSlackChannel(ctx.teamsConfig, teamSlug);
    if (!slackChannel) continue;
    const teamFiles = new Set(teamFileList);
    const owners = [...ownership.defaultedFiles.entries()]
      .filter(([file]) => teamFiles.has(file))
      .flatMap(([, o]) => o);
    if (!channelIndividualOwners.has(slackChannel)) {
      channelIndividualOwners.set(slackChannel, new Set());
    }
    for (const owner of owners) {
      channelIndividualOwners.get(slackChannel)!.add(owner);
    }
  }

  const notifiedChannels = new Set<string>();
  const slackRefs: SlackMessageRef[] = [];

  for (const [teamSlug] of ownership.teamFiles) {
    const labelName = getLabelForTeam(ctx.teamsConfig, teamSlug, ctx.inputs.needsReviewPrefix);

    await ensureLabel(octokit, ctx.owner, ctx.repo, labelName, ctx.inputs.needsReviewLabelColor);
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
      core.info(`Skipping team review request for ${teamSlug} (no org access)`);
    }

    const slackChannel = getSlackChannel(ctx.teamsConfig, teamSlug);
    if (slackChannel && ctx.inputs.slackToken && !notifiedChannels.has(slackChannel)) {
      notifiedChannels.add(slackChannel);
      const displayLabels = ctx.labels.filter(
        (l) => !l.startsWith(ctx.inputs.needsReviewPrefix) && l !== ctx.inputs.readyLabel
      );
      const individualOwners = [...(channelIndividualOwners.get(slackChannel) ?? [])];
      const ref = await sendSlackNotification(ctx.inputs.slackToken, slackChannel, {
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
        individualOwners,
        users: ctx.teamsConfig.users,
        icons: ctx.teamsConfig.reactions?.icons,
      });
      if (ref) {
        slackRefs.push(ref);
        const filenames = allFileStats.map((f) => f.filename);
        const emojis = getFileTypeEmojis(filenames, ctx.teamsConfig.reactions);
        await addSlackReactions(ctx.inputs.slackToken, ref, emojis);
      }
    }
  }

  const existing = await findExistingComment(octokit, ctx.owner, ctx.repo, ctx.prNumber);
  const oldRefs = existing ? extractSlackRefs(existing.body) : [];
  const mergedRefs = mergeSlackRefs(oldRefs, slackRefs);

  let commentBody = buildOwnershipComment(ownership, ctx.capabilities.hasOrgAccess);
  commentBody = embedSlackRefs(commentBody, mergedRefs);
  await upsertComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, commentBody);
}

export async function handleReviewSubmitted(octokit: Octokit, ctx: ReviewContext): Promise<void> {
  if (!ctx.capabilities.hasOrgAccess) {
    core.info("Skipping label removal on approval (no org access)");
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

  const approvedChannels = new Set<string>();
  for (const label of needsReviewLabels) {
    const teamSlug = resolveTeamSlugFromLabel(
      label.name,
      ctx.teamsConfig,
      ctx.inputs.needsReviewPrefix
    );
    if (!teamSlug) continue;

    try {
      await octokit.rest.teams.getMembershipForUserInOrg({
        org: ctx.owner,
        team_slug: teamSlug,
        username: ctx.reviewer,
      });
      await removeLabel(octokit, ctx.owner, ctx.repo, ctx.prNumber, label.name);
      core.info(`Removed "${label.name}" — reviewer ${ctx.reviewer} is a member of ${teamSlug}`);
      const channel = getSlackChannel(ctx.teamsConfig, teamSlug);
      if (channel) approvedChannels.add(channel);
    } catch (error: unknown) {
      const httpError = error as { status?: number };
      if (httpError.status === 404) {
        core.debug(`Reviewer ${ctx.reviewer} is not a member of team ${teamSlug}`);
      } else {
        core.warning(
          `Error checking team membership for ${ctx.reviewer} in ${teamSlug}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (approvedChannels.size > 0 && ctx.inputs.slackToken) {
    try {
      const existing = await findExistingComment(octokit, ctx.owner, ctx.repo, ctx.prNumber);
      if (existing) {
        const refs = extractSlackRefs(existing.body);
        const emoji = getStatusEmoji("approved", ctx.teamsConfig.reactions);
        if (emoji) {
          for (const ref of refs) {
            if (approvedChannels.has(ref.channel)) {
              await addSlackReactions(ctx.inputs.slackToken, ref, [emoji]);
            }
          }
        }
      }
    } catch (error) {
      core.warning(
        `Failed to add approval reaction: ${error instanceof Error ? error.message : String(error)}`
      );
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

export interface OpenedContext {
  owner: string;
  repo: string;
  prNumber: number;
  author: string;
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}

export async function handleOpened(octokit: Octokit, ctx: OpenedContext): Promise<void> {
  if (!ctx.teamsConfig.dependabot?.auto_label) {
    core.info("Dependabot auto-label is disabled or not configured");
    return;
  }

  if (ctx.author !== "dependabot[bot]") {
    core.info(`PR author "${ctx.author}" is not dependabot[bot], skipping auto-label`);
    return;
  }

  core.info(`Dependabot PR #${ctx.prNumber} detected, adding "${ctx.inputs.readyLabel}" label`);
  try {
    await octokit.rest.issues.addLabels({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.prNumber,
      labels: [ctx.inputs.readyLabel],
    });
  } catch (error) {
    core.warning(
      `Failed to add label to dependabot PR #${ctx.prNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface ClosedContext {
  owner: string;
  repo: string;
  prNumber: number;
  merged: boolean;
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}

export async function handleClosed(octokit: Octokit, ctx: ClosedContext): Promise<void> {
  if (!ctx.merged) {
    core.info("PR was closed without merging, skipping label cleanup");
    if (ctx.inputs.slackToken) {
      try {
        const existing = await findExistingComment(octokit, ctx.owner, ctx.repo, ctx.prNumber);
        if (existing) {
          const emoji = getStatusEmoji("closed", ctx.teamsConfig.reactions);
          if (emoji) {
            const refs = extractSlackRefs(existing.body);
            for (const ref of refs) {
              await addSlackReactions(ctx.inputs.slackToken, ref, [emoji]);
            }
          }
        }
      } catch (error) {
        core.warning(
          `Failed to add closed reaction: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return;
  }

  const { data: labels } = await octokit.rest.issues.listLabelsOnIssue({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
  });

  const configuredLabels = new Set(Object.values(ctx.teamsConfig.teams).map((t) => t.label));
  const labelsToRemove = labels
    .filter(
      (l) =>
        l.name === ctx.inputs.readyLabel ||
        l.name.startsWith(ctx.inputs.needsReviewPrefix + ":") ||
        configuredLabels.has(l.name)
    )
    .map((l) => l.name);

  for (const labelName of labelsToRemove) {
    try {
      await removeLabel(octokit, ctx.owner, ctx.repo, ctx.prNumber, labelName);
    } catch (error: unknown) {
      const httpError = error as { status?: number };
      if (httpError.status === 404) {
        core.debug(`Label "${labelName}" already removed`);
      } else {
        core.warning(
          `Failed to remove label "${labelName}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (labelsToRemove.length > 0) {
    core.info(`Cleaned up ${labelsToRemove.length} label(s) from merged PR #${ctx.prNumber}`);
  }

  if (ctx.inputs.slackToken) {
    try {
      const existing = await findExistingComment(octokit, ctx.owner, ctx.repo, ctx.prNumber);
      if (existing) {
        const emoji = getStatusEmoji("merged", ctx.teamsConfig.reactions);
        if (emoji) {
          const refs = extractSlackRefs(existing.body);
          for (const ref of refs) {
            await addSlackReactions(ctx.inputs.slackToken, ref, [emoji]);
          }
        }
      }
    } catch (error) {
      core.warning(
        `Failed to add merged reaction: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function getFileTypeEmojis(filenames: string[], config?: ReactionsConfig): string[] {
  if (!config?.enabled || !config.file_types) return [];

  const fileTypeMap = config.file_types;
  const emojis = new Set<string>();
  for (const filename of filenames) {
    const lower = filename.toLowerCase();
    if (lower.includes(".github/workflows/")) {
      const emoji = fileTypeMap["github-actions"];
      if (emoji) emojis.add(emoji);
      continue;
    }
    if (lower.endsWith("dockerfile") || lower.endsWith(".dockerignore")) {
      const emoji = fileTypeMap["dockerfile"];
      if (emoji) emojis.add(emoji);
      continue;
    }
    if (lower.endsWith("makefile")) {
      const emoji = fileTypeMap["makefile"];
      if (emoji) emojis.add(emoji);
      continue;
    }
    const ext = lower.split(".").pop() ?? "";
    const emoji = fileTypeMap[ext];
    if (emoji) emojis.add(emoji);
  }
  return [...emojis];
}

export function getStatusEmoji(
  name: "approved" | "merged" | "closed",
  config?: ReactionsConfig
): string | null {
  if (!config?.enabled) return null;
  const defaults: Record<string, string> = {
    approved: "white_check_mark",
    merged: "heavy_check_mark",
    closed: "no_entry_sign",
  };
  return config[name] ?? defaults[name];
}
