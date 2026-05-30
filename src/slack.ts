import * as core from "@actions/core";
import { WebClient } from "@slack/web-api";

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
  allFiles: FileStats[];
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string | { type: string; text: string }; url?: string }>;
}

export function buildSlackBlocks(params: SlackMessageParams): { blocks: SlackBlock[]; fallback: string } {
  const maxFiles = 10;
  const visibleFiles = params.allFiles.slice(0, maxFiles);
  const remaining = params.allFiles.length - visibleFiles.length;
  let fileList = visibleFiles
    .map((f) => `• \`${f.filename}\` \`+${f.additions} -${f.deletions}\``)
    .join("\n");
  if (remaining > 0) {
    fileList += `\n_and ${remaining} more file${remaining === 1 ? "" : "s"}_`;
  }

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:pencil2: *<${params.prUrl}|${params.orgName}/${params.repoName}#${params.prNumber}>*  \`+${params.additions} -${params.deletions}\` to be merged into \`${params.baseBranch}\`\n${params.prTitle}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Author:* ${params.author}`,
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Changes:*\n${fileList}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PR" },
          url: params.prUrl,
        },
      ],
    },
  ];

  const fallback = `PR by ${params.author} needs a review: ${params.repoName}#${params.prNumber}: ${params.prTitle}`;

  return { blocks, fallback };
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
    const { blocks, fallback } = buildSlackBlocks(params);
    await client.chat.postMessage({
      channel,
      text: fallback,
      blocks,
    });
    core.info(`Sent Slack notification to ${channel}`);
  } catch (error) {
    core.warning(
      `Failed to send Slack notification to ${channel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
