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
  commits: number;
  labels: string[];
  allFiles: FileStats[];
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
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

  const repoFullName = `${params.orgName}/${params.repoName}`;

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:rr-mag: *Pull request ready for review*\n<${params.prUrl}|${params.prTitle}>\n${repoFullName} #${params.prNumber}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Author*\n${params.author}` },
        { type: "mrkdwn", text: `*Merging into*\n\`${params.baseBranch}\`` },
        { type: "mrkdwn", text: `*Changes*\n\`+${params.additions} -${params.deletions}\`` },
        { type: "mrkdwn", text: `*Commits*\n${params.commits}` },
        { type: "mrkdwn", text: `*Files changed*\n${params.allFiles.length}` },
        { type: "mrkdwn", text: `*Labels*\n${params.labels.length > 0 ? params.labels.join(" · ") : "—"}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: fileList,
      },
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
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:rr-twisted_rightwards_arrows: \`${params.baseBranch}\` · :rr-git_commit: ${params.commits} commit${params.commits === 1 ? "" : "s"} · :rr-file: ${params.allFiles.length} file${params.allFiles.length === 1 ? "" : "s"}${params.labels.length > 0 ? ` · :rr-label: ${params.labels.join(", ")}` : ""}`,
        },
      ],
    },
  ];

  const fallback = `PR by ${params.author} needs a review: ${repoFullName}#${params.prNumber}: ${params.prTitle}`;

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
