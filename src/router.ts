import * as core from "@actions/core";
import { WebClient } from "@slack/web-api";
import { fetchCodeownersContent, parseCodeowners, mapFilesToTeams } from "./codeowners";
import { ensureLabel, applyLabels, removeLabel } from "./labels";
import {
  buildOwnershipComment,
  upsertComment,
  COMMENT_MARKER,
  embedSlackRefs,
  embedSlackRefsInDescription,
  extractSlackRefsFromDescription,
  mergeSlackRefs,
  findExistingComment,
  extractSlackRefs,
  postExternalComment,
} from "./comment";
import {
  sendSlackNotification,
  addSlackReactions,
  isSlackMessageMuted,
  postSlackThreadReply,
  FileStats,
  SlackMessageRef,
} from "./slack";
import { getLabelForTeam, getSlackChannel } from "./config";
import {
  ActionInputs,
  Capabilities,
  ReactionsConfig,
  OrgConfig,
  CommentContext,
  Octokit,
} from "./types";

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (attempt === maxAttempts || (status !== undefined && status < 500)) throw error;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
      core.debug(`Retrying after transient error (attempt ${attempt + 1}/${maxAttempts})`);
    }
  }
  throw new Error("unreachable");
}

export function isReadyLabel(name: string, readyLabel: string, aliases: string[] = []): boolean {
  return name === readyLabel || aliases.includes(name);
}

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
  prBody: string;
  prUrl: string;
  author: string;
  reviewer: string;
  inputs: ActionInputs;
  capabilities: Capabilities;
  teamsConfig: OrgConfig;
}

async function getSlackRefsWithFallback(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  prBody: string
): Promise<SlackMessageRef[]> {
  const refs = extractSlackRefsFromDescription(prBody);
  if (refs.length > 0) return refs;

  // Self-healing: check bot comment for legacy refs
  const existing = await findExistingComment(octokit, owner, repo, prNumber);
  if (!existing) return [];

  const legacyRefs = extractSlackRefs(existing.body);
  if (legacyRefs.length > 0) {
    try {
      const { data: freshPr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      const updatedBody = embedSlackRefsInDescription(freshPr.body ?? "", legacyRefs);
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prNumber,
        body: updatedBody,
      });
      core.info("Self-healed: migrated Slack refs from comment to PR description");
    } catch (error) {
      core.warning(
        `Failed to self-heal Slack refs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return legacyRefs;
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

  const allLabelNames: string[] = [];
  const allTeamSlugs: string[] = [];
  const slackChannelsToNotify: Array<{ channel: string; individualOwners: string[] }> = [];

  for (const [teamSlug] of ownership.teamFiles) {
    const labelName = getLabelForTeam(ctx.teamsConfig, teamSlug, ctx.inputs.needsReviewPrefix);

    await ensureLabel(octokit, ctx.owner, ctx.repo, labelName, ctx.inputs.needsReviewLabelColor);
    allLabelNames.push(labelName);

    if (ctx.capabilities.hasOrgAccess) {
      allTeamSlugs.push(teamSlug);
    } else {
      core.info(`Skipping team review request for ${teamSlug} (no org access)`);
    }

    const slackChannel = getSlackChannel(ctx.teamsConfig, teamSlug);
    if (
      slackChannel &&
      ctx.inputs.slackToken &&
      !slackChannelsToNotify.some((c) => c.channel === slackChannel)
    ) {
      const individualOwners = [...(channelIndividualOwners.get(slackChannel) ?? [])];
      slackChannelsToNotify.push({ channel: slackChannel, individualOwners });
    }
  }

  try {
    await applyLabels(octokit, ctx.owner, ctx.repo, ctx.prNumber, allLabelNames);
  } catch (error) {
    core.warning(
      `Failed to apply labels: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (allTeamSlugs.length > 0) {
    try {
      await octokit.rest.pulls.requestReviewers({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
        team_reviewers: allTeamSlugs,
      });
      core.info(`Requested review from ${allTeamSlugs.length} team(s)`);
    } catch {
      core.warning("Batched requestReviewers failed, falling back to per-team calls");
      for (const slug of allTeamSlugs) {
        try {
          await octokit.rest.pulls.requestReviewers({
            owner: ctx.owner,
            repo: ctx.repo,
            pull_number: ctx.prNumber,
            team_reviewers: [slug],
          });
        } catch (error) {
          core.warning(
            `Failed to request review from team ${slug}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  const slackRefs: SlackMessageRef[] = [];
  const displayLabels = ctx.labels.filter(
    (l) =>
      !l.startsWith(ctx.inputs.needsReviewPrefix) &&
      !isReadyLabel(l, ctx.inputs.readyLabel, ctx.teamsConfig.ready_label_aliases)
  );

  for (const { channel, individualOwners } of slackChannelsToNotify) {
    const ref = await sendSlackNotification(ctx.inputs.slackToken, channel, {
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
      const fnames = allFileStats.map((f) => f.filename);
      const emojis = getFileTypeEmojis(fnames, ctx.teamsConfig.reactions);
      await addSlackReactions(ctx.inputs.slackToken, ref, emojis);
    }
  }

  const existing = await findExistingComment(octokit, ctx.owner, ctx.repo, ctx.prNumber);
  const commentRefs = existing ? extractSlackRefs(existing.body) : [];
  const { data: currentPr } = await octokit.rest.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  const descriptionRefs = extractSlackRefsFromDescription(currentPr.body ?? "");
  const mergedRefs = mergeSlackRefs(mergeSlackRefs(descriptionRefs, commentRefs), slackRefs);

  let commentBody = buildOwnershipComment(ownership, ctx.capabilities.hasOrgAccess);
  commentBody = embedSlackRefs(commentBody, mergedRefs);
  await withRetry(() =>
    upsertComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, commentBody, existing)
  );

  if (mergedRefs.length > 0) {
    try {
      const updatedBody = embedSlackRefsInDescription(currentPr.body ?? "", mergedRefs);
      await withRetry(() =>
        octokit.rest.pulls.update({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
          body: updatedBody,
        })
      );
    } catch (error) {
      core.warning(
        `Failed to update PR description with Slack refs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
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
      const refs = await getSlackRefsWithFallback(
        octokit,
        ctx.owner,
        ctx.repo,
        ctx.prNumber,
        ctx.prBody
      );
      if (refs.length === 0) {
        core.warning(
          "No Slack refs found for this PR — approval reaction skipped. This can happen if the initial routing run failed before persisting the Slack message reference."
        );
      }
      const emoji = getStatusEmoji("approved", ctx.teamsConfig.reactions);
      if (emoji) {
        for (const ref of refs) {
          if (approvedChannels.has(ref.channel)) {
            await addSlackReactions(ctx.inputs.slackToken, ref, [emoji]);
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
  isFork: boolean;
  isDraft: boolean;
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}

export const EXTERNAL_CONTRIBUTION_LABEL = "external-contribution";

export async function handleOpened(octokit: Octokit, ctx: OpenedContext): Promise<void> {
  if (ctx.teamsConfig.dependabot?.auto_label && ctx.author === "dependabot[bot]") {
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
    return;
  }

  if (!ctx.teamsConfig.external_contributors?.auto_label) {
    core.info("External contributor auto-label is disabled or not configured");
    return;
  }

  if (!ctx.isFork) {
    core.info("PR is not from a fork, skipping external contributor auto-label");
    return;
  }

  const labels = ctx.isDraft
    ? [EXTERNAL_CONTRIBUTION_LABEL]
    : [EXTERNAL_CONTRIBUTION_LABEL, ctx.inputs.readyLabel];

  core.info(
    `Fork PR #${ctx.prNumber} detected (draft=${ctx.isDraft}), adding labels: ${labels.join(", ")}`
  );
  try {
    await octokit.rest.issues.addLabels({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.prNumber,
      labels,
    });
  } catch (error) {
    core.warning(
      `Failed to add labels to fork PR #${ctx.prNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const message = ctx.teamsConfig.external_contributors?.message;
  if (message) {
    await postExternalComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, message);
  }
}

export interface ReadyForReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
  author: string;
  isFork: boolean;
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}

export async function handleReadyForReview(
  octokit: Octokit,
  ctx: ReadyForReviewContext
): Promise<void> {
  if (!ctx.teamsConfig.external_contributors?.auto_label) {
    core.info("External contributor auto-label is disabled or not configured");
    return;
  }

  if (!ctx.isFork) {
    core.info("PR is not from a fork, skipping external contributor auto-label");
    return;
  }

  core.info(`Fork PR #${ctx.prNumber} marked ready, adding "${ctx.inputs.readyLabel}" label`);
  try {
    await octokit.rest.issues.addLabels({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.prNumber,
      labels: [ctx.inputs.readyLabel],
    });
  } catch (error) {
    core.warning(
      `Failed to add label to fork PR #${ctx.prNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface ClosedContext {
  owner: string;
  repo: string;
  prNumber: number;
  prBody: string;
  merged: boolean;
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}

export async function handleClosed(octokit: Octokit, ctx: ClosedContext): Promise<void> {
  if (!ctx.merged) {
    core.info("PR was closed without merging, skipping label cleanup");
    if (ctx.inputs.slackToken) {
      try {
        const refs = await getSlackRefsWithFallback(
          octokit,
          ctx.owner,
          ctx.repo,
          ctx.prNumber,
          ctx.prBody
        );
        const emoji = getStatusEmoji("closed", ctx.teamsConfig.reactions);
        if (emoji) {
          for (const ref of refs) {
            await addSlackReactions(ctx.inputs.slackToken, ref, [emoji]);
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
        isReadyLabel(l.name, ctx.inputs.readyLabel, ctx.teamsConfig.ready_label_aliases) ||
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
      const refs = await getSlackRefsWithFallback(
        octokit,
        ctx.owner,
        ctx.repo,
        ctx.prNumber,
        ctx.prBody
      );
      const emoji = getStatusEmoji("merged", ctx.teamsConfig.reactions);
      if (emoji) {
        for (const ref of refs) {
          await addSlackReactions(ctx.inputs.slackToken, ref, [emoji]);
        }
      }
    } catch (error) {
      core.warning(
        `Failed to add merged reaction: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export async function handleComment(octokit: Octokit, ctx: CommentContext): Promise<void> {
  if (!ctx.inputs.slackToken) {
    core.debug("No Slack token provided, skipping thread notification");
    return;
  }

  const refs = await getSlackRefsWithFallback(
    octokit,
    ctx.owner,
    ctx.repo,
    ctx.prNumber,
    ctx.prBody
  );
  if (refs.length === 0) {
    core.debug("No Slack refs found, skipping thread notification");
    return;
  }

  const client = new WebClient(ctx.inputs.slackToken);
  const kindLabel =
    ctx.kind === "review_comment" ? "review comment" : ctx.kind === "review" ? "review" : "comment";
  const urlPart = ctx.commentUrl ? ` — <${ctx.commentUrl}|view>` : "";

  const recipients: Array<{ slackId: string; text: string }> = [];

  const authorSlackId = ctx.teamsConfig.users?.[ctx.author];
  if (authorSlackId) {
    const text =
      ctx.kind === "review" && ctx.commentUrl === ""
        ? `:white_check_mark: <@${authorSlackId}>, your PR was approved by *${ctx.commenter}*`
        : `:speech_balloon: <@${authorSlackId}>, you have a new ${kindLabel} from *${ctx.commenter}*${urlPart}`;
    recipients.push({ slackId: authorSlackId, text });
  }

  if (ctx.kind !== "review") {
    for (const assignee of ctx.assignees) {
      if (assignee === ctx.commenter || assignee === ctx.author) continue;
      const slackId = ctx.teamsConfig.users?.[assignee];
      if (!slackId || recipients.some((r) => r.slackId === slackId)) continue;
      recipients.push({
        slackId,
        text: `:eyes: <@${slackId}> new ${kindLabel} on a PR you're watching from *${ctx.commenter}*${urlPart}`,
      });
    }
  }

  if (recipients.length === 0) {
    core.debug("No recipients with Slack IDs found, skipping thread notifications");
    return;
  }

  for (const ref of refs) {
    try {
      const muted = await isSlackMessageMuted(client, ref.channel, ref.ts);
      if (muted) {
        core.debug(`Slack message in ${ref.channel} is muted, skipping thread reply`);
        continue;
      }
      for (const { text } of recipients) {
        await postSlackThreadReply(client, ref.channel, ref.ts, text);
      }
      core.info(
        `Posted ${recipients.length} thread reply(s) in ${ref.channel} for PR #${ctx.prNumber}`
      );
    } catch (error) {
      core.warning(
        `Failed to post thread reply in ${ref.channel}: ${error instanceof Error ? error.message : String(error)}`
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
