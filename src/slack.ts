import * as core from "@actions/core";
import { WebClient } from "@slack/web-api";
import { NotificationIcons } from "./types";

export interface FileStats {
  filename: string;
  additions: number;
  deletions: number;
}

export interface SlackMessageParams {
  prUrl: string;
  prTitle: string;
  prNumber: number;
  orgName: string;
  repoName: string;
  baseBranch: string;
  author: string;
  additions: number;
  deletions: number;
  commits: number;
  labels: string[];
  allFiles: FileStats[];
  individualOwners?: string[];
  users?: Record<string, string>;
  icons?: NotificationIcons;
}

const DEFAULT_ICONS: Required<NotificationIcons> = {
  header: "mag",
  branch: "twisted_rightwards_arrows",
  commits: "arrow_heading_up",
  files: "page_facing_up",
  labels: "label",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlackBlock = Record<string, any>;

export function buildSlackBlocks(params: SlackMessageParams): {
  blocks: SlackBlock[];
  fallback: string;
} {
  const maxFiles = 10;
  const visibleFiles = params.allFiles.slice(0, maxFiles);
  const remaining = params.allFiles.length - visibleFiles.length;
  let fileList = visibleFiles
    .map((f) => `• \`${f.filename}\` \`+${f.additions} -${f.deletions}\``)
    .join("\n");
  if (remaining > 0) {
    fileList += `\n_and ${remaining} more file${remaining === 1 ? "" : "s"}_`;
  }

  const repoFullName = `${params.orgName}/${params.repoName}`;
  const avatarUrl = `https://github.com/${params.author}.png?size=24`;
  const icons = { ...DEFAULT_ICONS, ...params.icons };

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:${icons.header}: *Review requested* · <${params.prUrl}|${repoFullName} #${params.prNumber}> \`+${params.additions} -${params.deletions}\``,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${params.prTitle}*`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "image",
          image_url: avatarUrl,
          alt_text: params.author,
        },
        {
          type: "mrkdwn",
          text: `*${params.author}* requested a review on a PR merging into \`${params.baseBranch}\``,
        },
      ],
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Files changed:*\n${fileList}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:${icons.branch}: \`${params.baseBranch}\` • :${icons.commits}: ${params.commits} commit${params.commits === 1 ? "" : "s"} • :${icons.files}: ${params.allFiles.length} file${params.allFiles.length === 1 ? "" : "s"}${params.labels.length > 0 ? ` • :${icons.labels}: ${params.labels.map((l) => `\`${l}\``).join(" · ")}` : ""}`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View pull request" },
          url: params.prUrl,
        },
      ],
    },
  ];

  if (params.individualOwners?.length) {
    const mentions = params.individualOwners
      .map((owner) => {
        const username = owner.replace(/^@/, "");
        const slackId = params.users?.[username];
        return slackId ? `<@${slackId}>` : null;
      })
      .filter((v): v is string => v !== null)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (mentions.length > 0) {
      blocks.splice(-1, 0, {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `:bust_in_silhouette: cc ${mentions.join(" ")}`,
          },
        ],
      });
    }
  }

  const fallback = `PR by ${params.author} needs a review: ${repoFullName}#${params.prNumber}: ${params.prTitle}`;

  return { blocks, fallback };
}

export interface SlackReminderParams {
  prUrl: string;
  prTitle: string;
  prNumber: number;
  orgName: string;
  repoName: string;
  teamName: string;
  ageDisplay: string;
  icons?: NotificationIcons;
}

export function buildSlackReminderBlocks(params: SlackReminderParams): {
  blocks: SlackBlock[];
  fallback: string;
} {
  const repoFullName = `${params.orgName}/${params.repoName}`;
  const headerIcon = params.icons?.header ?? DEFAULT_ICONS.header;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:${headerIcon}: *Reminder* — <${params.prUrl}|${repoFullName} #${params.prNumber}> still needs review`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${params.prTitle}*`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:hourglass: Open for *${params.ageDisplay}* · Waiting on *${params.teamName}*`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View pull request" },
          url: params.prUrl,
        },
      ],
    },
  ];

  const fallback = `Reminder: ${repoFullName}#${params.prNumber} still needs review (open for ${params.ageDisplay})`;

  return { blocks, fallback };
}

export async function sendSlackReminder(
  token: string,
  channel: string,
  params: SlackReminderParams
): Promise<void> {
  if (!token) {
    core.debug("No Slack token provided, skipping reminder");
    return;
  }

  try {
    const client = new WebClient(token);
    const { blocks, fallback } = buildSlackReminderBlocks(params);
    await client.chat.postMessage({
      channel,
      text: fallback,
      blocks: blocks as never[],
    });
    core.info(`Sent Slack reminder to ${channel} for PR #${params.prNumber}`);
  } catch (error) {
    core.warning(
      `Failed to send Slack reminder to ${channel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface SlackMessageRef {
  channel: string;
  ts: string;
}

export async function sendSlackNotification(
  token: string,
  channel: string,
  params: SlackMessageParams
): Promise<SlackMessageRef | null> {
  if (!token) {
    core.debug("No Slack token provided, skipping notification");
    return null;
  }

  try {
    const client = new WebClient(token);
    const { blocks, fallback } = buildSlackBlocks(params);
    const result = await client.chat.postMessage({
      channel,
      text: fallback,
      blocks: blocks as never[],
    });
    core.info(`Sent Slack notification to ${channel}`);
    return result.ts ? { channel, ts: result.ts } : null;
  } catch (error) {
    core.warning(
      `Failed to send Slack notification to ${channel}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

const MUTE_REACTIONS = ["mute", "no_bell"];

export async function isSlackMessageMuted(
  client: WebClient,
  channel: string,
  ts: string
): Promise<boolean> {
  try {
    const result = await client.reactions.get({ channel, timestamp: ts, full: true });
    const reactions = (result.message as { reactions?: Array<{ name: string }> })?.reactions ?? [];
    return reactions.some((r) => MUTE_REACTIONS.includes(r.name));
  } catch (error) {
    core.warning(
      `Failed to check mute status: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export async function postSlackThreadReply(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}

export async function addSlackReactions(
  token: string,
  ref: SlackMessageRef,
  emojis: string[]
): Promise<void> {
  if (!token || emojis.length === 0) return;

  const client = new WebClient(token);
  for (const emoji of emojis) {
    try {
      await client.reactions.add({
        channel: ref.channel,
        timestamp: ref.ts,
        name: emoji,
      });
    } catch (error) {
      const slackError = error as { data?: { error?: string } };
      if (slackError.data?.error === "already_reacted") {
        core.debug(`Reaction :${emoji}: already present`);
      } else {
        core.warning(
          `Failed to add reaction :${emoji}: to ${ref.channel}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
