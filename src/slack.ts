import * as core from "@actions/core";
import { WebClient } from "@slack/web-api";

export interface SlackMessageParams {
  prUrl: string;
  prTitle: string;
  prNumber: number;
  repoName: string;
  author: string;
  files: string[];
}

export function buildSlackMessage(params: SlackMessageParams): string {
  const fileList = params.files.map((f) => `• ${f}`).join("\n");
  return [
    `📋 *Review requested:* <${params.prUrl}|${params.repoName}#${params.prNumber}: ${params.prTitle}>`,
    `*Author:* ${params.author}`,
    `*Files for your team:*`,
    fileList,
  ].join("\n");
}

export async function sendSlackNotification(
  token: string,
  channel: string,
  text: string
): Promise<void> {
  if (!token) {
    core.debug("No Slack token provided, skipping notification");
    return;
  }

  try {
    const client = new WebClient(token);
    await client.chat.postMessage({ channel, text });
    core.info(`Sent Slack notification to ${channel}`);
  } catch (error) {
    core.warning(
      `Failed to send Slack notification to ${channel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
