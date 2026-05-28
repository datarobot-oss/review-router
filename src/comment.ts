import * as core from "@actions/core";
import { OwnershipMap } from "./types";

export const COMMENT_MARKER = "<!-- review-router-ownership -->";

type Octokit = ReturnType<typeof import("@actions/github").getOctokit>;

export function buildOwnershipComment(ownership: OwnershipMap): string {
  const lines: string[] = [COMMENT_MARKER, "## Code Ownership", ""];

  for (const [team, files] of ownership.teamFiles) {
    lines.push(`**${team}**`);
    for (const file of files) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  if (ownership.unownedFiles.length > 0) {
    lines.push(
      "<details><summary>Unowned files (no CODEOWNERS match)</summary>"
    );
    lines.push("");
    for (const file of ownership.unownedFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  lines.push(
    "_Review requested from the teams above. Labels will be removed automatically upon approval._"
  );
  return lines.join("\n");
}

export async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });
  const existing = comments.find(
    (c) => c.body && c.body.includes(COMMENT_MARKER)
  );
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
