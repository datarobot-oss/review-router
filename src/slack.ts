import * as core from "@actions/core";
import { WebClient, KnownBlock } from "@slack/web-api";

export interface SlackMessageParams {
  prUrl: string;
  prTitle: string;
  prNumber: number;
  repoName: string;
  author: string;
  teamSlug: string;
  files: string[];
}

export function buildSlackBlocks(params: SlackMessageParams): KnownBlock[] {
  const fileList = params.files.map((f) => `\`${f}\``).join("\n");

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "📋 Review Requested",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*PR:*\n<${params.prUrl}|${params.repoName}#${params.prNumber}: ${params.prTitle}>`,
        },
        {
          type: "mrkdwn",
          text: `*Author:*\n${params.author}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Team:* ${params.teamSlug}\n*Files:*\n${fileList}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Open PR",
            emoji: true,
          },
          url: params.prUrl,
          style: "primary",
        },
      ],
    },
  ];
}

export function buildSlackFallbackText(params: SlackMessageParams): string {
  return `Review requested: ${params.repoName}#${params.prNumber}: ${params.prTitle} by ${params.author}`;
}

export async function sendSlackNotification(
  token: string,
  channel: string,
  params: SlackMessageParams
): Promise<void> {
  if (!token) {
    core.debug("No Slack token provided, skipping notification");
    return;
  }

  try {
    const client = new WebClient(token);
    await client.chat.postMessage({
      channel,
      text: buildSlackFallbackText(params),
      blocks: buildSlackBlocks(params),
    });
    core.info(`Sent Slack notification to ${channel}`);
  } catch (error) {
    core.warning(
      `Failed to send Slack notification to ${channel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
