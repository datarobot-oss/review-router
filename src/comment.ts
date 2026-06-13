import * as core from "@actions/core";
import { OwnershipMap, Octokit } from "./types";
import { humanizeSlug } from "./config";
import { SlackMessageRef } from "./slack";

export const COMMENT_MARKER = "<!-- review-router-ownership -->";
const SLACK_REF_PATTERN = /<!-- rr:slack:([^:]+):([^ ]+) -->/;

export function buildOwnershipComment(ownership: OwnershipMap, hasOrgAccess: boolean): string {
  const lines: string[] = [COMMENT_MARKER, "## Code Ownership", ""];

  for (const [team, files] of ownership.teamFiles) {
    lines.push(`**${humanizeSlug(team)}**`);
    for (const file of files) {
      const originalOwners = ownership.defaultedFiles.get(file);
      if (originalOwners) {
        lines.push(`- \`${file}\` _(default — owned by ${originalOwners.join(", ")})_`);
      } else {
        lines.push(`- \`${file}\``);
      }
    }
    lines.push("");
  }

  if (ownership.unownedFiles.length > 0) {
    lines.push("<details><summary>Unowned files (no CODEOWNERS match)</summary>");
    lines.push("");
    for (const file of ownership.unownedFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (hasOrgAccess) {
    lines.push(
      "_Review requested from the teams above. Labels will be removed automatically upon approval._"
    );
  } else {
    lines.push("_Review requested from the teams above._");
  }
  return lines.join("\n");
}

export function embedSlackRefs(body: string, refs: SlackMessageRef[]): string {
  if (refs.length === 0) return body;
  const tags = refs.map((r) => `<!-- rr:slack:${r.channel}:${r.ts} -->`).join("\n");
  return `${body}\n${tags}`;
}

export function mergeSlackRefs(
  oldRefs: SlackMessageRef[],
  newRefs: SlackMessageRef[]
): SlackMessageRef[] {
  const byChannel = new Map<string, SlackMessageRef>();
  for (const ref of oldRefs) byChannel.set(ref.channel, ref);
  for (const ref of newRefs) byChannel.set(ref.channel, ref);
  return [...byChannel.values()];
}

export function extractSlackRefs(body: string): SlackMessageRef[] {
  return [...body.matchAll(new RegExp(SLACK_REF_PATTERN, "g"))].map((m) => ({
    channel: m[1],
    ts: m[2],
  }));
}

const SLACK_DESC_START = "<!-- rr:slack:start -->";
const SLACK_DESC_END = "<!-- rr:slack:end -->";
const CURSOR_SUMMARY = "<!-- CURSOR_SUMMARY -->";
const SLACK_DESC_BLOCK_PATTERN = new RegExp(
  `\\n?${SLACK_DESC_START}[\\s\\S]*?${SLACK_DESC_END}`,
  ""
);

export function embedSlackRefsInDescription(body: string, refs: SlackMessageRef[]): string {
  if (refs.length === 0) return body;

  const tags = refs.map((r) => `<!-- rr:slack:${r.channel}:${r.ts} -->`);
  const block = `\n${SLACK_DESC_START}\n${tags.join("\n")}\n${SLACK_DESC_END}`;

  // Replace existing block if both markers present
  if (body.includes(SLACK_DESC_START) && body.includes(SLACK_DESC_END)) {
    return body.replace(SLACK_DESC_BLOCK_PATTERN, block);
  }

  // Insert before Cursor summary if present
  const cursorIdx = body.indexOf(CURSOR_SUMMARY);
  if (cursorIdx !== -1) {
    const prefix = body.slice(0, cursorIdx).replace(/\n$/, "");
    return prefix + block + "\n" + body.slice(cursorIdx);
  }

  return body + block;
}

export function extractSlackRefsFromDescription(body: string): SlackMessageRef[] {
  if (!body) return [];
  const startIdx = body.indexOf(SLACK_DESC_START);
  const endIdx = body.indexOf(SLACK_DESC_END, startIdx);
  if (startIdx === -1 || endIdx === -1) return [];
  const block = body.slice(startIdx + SLACK_DESC_START.length, endIdx);
  return [...block.matchAll(new RegExp(SLACK_REF_PATTERN, "g"))].map((m) => ({
    channel: m[1],
    ts: m[2],
  }));
}

export async function findExistingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ id: number; body: string } | null> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });
  const existing = comments.find((c) => c.body && c.body.includes(COMMENT_MARKER));
  return existing ? { id: existing.id, body: existing.body ?? "" } : null;
}

export async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  existingComment?: { id: number; body: string } | null
): Promise<void> {
  const existing =
    existingComment !== undefined
      ? existingComment
      : await findExistingComment(octokit, owner, repo, prNumber);

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated ownership comment on PR #${prNumber}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    core.info(`Posted ownership comment on PR #${prNumber}`);
  }
}
