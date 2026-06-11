import * as core from "@actions/core";
import { getSlackChannel, humanizeSlug } from "./config";
import { resolveTeamSlugFromLabel } from "./router";
import { sendSlackReminder } from "./slack";
import { ActionInputs, OrgConfig, Octokit } from "./types";

export interface ReminderContext {
  owner: string;
  repo: string;
  inputs: ActionInputs;
  teamsConfig: OrgConfig;
}

export async function handleSchedule(octokit: Octokit, ctx: ReminderContext): Promise<void> {
  const remindersConfig = ctx.teamsConfig.reminders;
  if (!remindersConfig?.enabled) {
    core.info("Reminders are disabled or not configured, skipping");
    return;
  }

  if (!ctx.inputs.slackToken) {
    core.warning(
      "Reminders are enabled but no Slack token is configured -- no reminders will be sent"
    );
    return;
  }

  const staleHours = remindersConfig.stale_hours ?? 24;
  const staleThreshold = new Date(Date.now() - staleHours * 60 * 60 * 1000);

  let openIssues;
  try {
    openIssues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner: ctx.owner,
      repo: ctx.repo,
      state: "open",
      per_page: 100,
    });
  } catch (error) {
    core.warning(
      `Failed to list open issues for reminders: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  let remindedCount = 0;

  for (const issue of openIssues) {
    if (!issue.pull_request) continue;

    const issueLabels = (issue.labels ?? []).filter(
      (l): l is { name: string } => typeof l === "object" && l !== null && "name" in l
    );

    const hasReadyLabel = issueLabels.some((l) => l.name === ctx.inputs.readyLabel);
    if (!hasReadyLabel) continue;

    const needsReviewLabels = issueLabels.filter((l) =>
      l.name.startsWith(ctx.inputs.needsReviewPrefix + ":")
    );
    if (needsReviewLabels.length === 0) continue;

    const readyAt = await getReadyForReviewTime(
      octokit,
      ctx.owner,
      ctx.repo,
      issue.number,
      ctx.inputs.readyLabel
    );

    if (readyAt === null) {
      core.info(`PR #${issue.number}: Could not determine review request time, skipping reminder`);
      continue;
    }

    if (readyAt > staleThreshold) {
      core.debug(
        `PR #${issue.number}: Review requested recently (${readyAt.toISOString()}), skipping`
      );
      continue;
    }

    const ageMs = Date.now() - readyAt.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const ageDisplay =
      ageDays > 0
        ? `${ageDays} day${ageDays === 1 ? "" : "s"}`
        : `${ageHours} hour${ageHours === 1 ? "" : "s"}`;

    const notifiedChannels = new Set<string>();
    for (const label of needsReviewLabels) {
      const teamSlug = resolveTeamSlugFromLabel(
        label.name,
        ctx.teamsConfig,
        ctx.inputs.needsReviewPrefix
      );
      if (!teamSlug) continue;

      const slackChannel = getSlackChannel(ctx.teamsConfig, teamSlug);
      if (slackChannel && ctx.inputs.slackToken && !notifiedChannels.has(slackChannel)) {
        notifiedChannels.add(slackChannel);
        await sendSlackReminder(ctx.inputs.slackToken, slackChannel, {
          prUrl: issue.html_url ?? "",
          prTitle: issue.title ?? "",
          prNumber: issue.number,
          orgName: ctx.owner,
          repoName: ctx.repo,
          teamName: humanizeSlug(teamSlug),
          ageDisplay,
        });
        remindedCount++;
      }
    }
  }

  core.info(`Sent ${remindedCount} reminder(s) for stale PRs`);
}

async function getReadyForReviewTime(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  readyLabel: string
): Promise<Date | null> {
  try {
    const events = await octokit.paginate(octokit.rest.issues.listEvents, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    let latest: Date | null = null;
    for (const event of events) {
      const label = "label" in event ? event.label : undefined;
      if (event.event === "labeled" && label?.name === readyLabel) {
        const eventDate = new Date(event.created_at);
        if (!latest || eventDate > latest) {
          latest = eventDate;
        }
      }
    }
    return latest;
  } catch (error) {
    core.warning(
      `Failed to fetch label events for PR #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
