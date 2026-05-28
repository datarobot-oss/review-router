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
  repoName: string;
  author: string;
  teamSlug: string;
  statusEmoji: string;
  additions: number;
  deletions: number;
  files: FileStats[];
}

export function buildSlackAttachment(params: SlackMessageParams) {
  const fileList = params.files
    .map((f) => `• ${f.filename} \`+${f.additions} -${f.deletions}\``)
    .join("\n");

  const text = [
    `PR by *${params.author}* needs a review:` +
      `${params.statusEmoji} \`+${params.additions} -${params.deletions}\` ` +
      `<${params.prUrl}|${params.repoName}#${params.prNumber}: ${params.prTitle}>`,
    `based on the following changes:`,
    fileList,
  ].join("\n");

  return {
    text,
    color: "#1a7ccc",
  };
}

export function buildSlackFallbackText(params: SlackMessageParams): string {
  return `PR by ${params.author} needs a review: +${params.additions} -${params.deletions} ${params.repoName}#${params.prNumber}: ${params.prTitle}`;
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
      attachments: [buildSlackAttachment(params)],
    });
    core.info(`Sent Slack notification to ${channel}`);
  } catch (error) {
    core.warning(
      `Failed to send Slack notification to ${channel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
