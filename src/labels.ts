import * as core from "@actions/core";
import { Octokit } from "./types";

export async function ensureLabel(octokit: Octokit, owner: string, repo: string, labelName: string, color: string): Promise<void> {
  try {
    await octokit.rest.issues.createLabel({ owner, repo, name: labelName, color });
    core.info(`Created label "${labelName}"`);
  } catch (error: unknown) {
    const httpError = error as { status?: number };
    if (httpError.status === 422) {
      core.debug(`Label "${labelName}" already exists`);
    } else { throw error; }
  }
}

export async function applyLabel(octokit: Octokit, owner: string, repo: string, prNumber: number, labelName: string): Promise<void> {
  await octokit.rest.issues.addLabels({ owner, repo, issue_number: prNumber, labels: [labelName] });
  core.info(`Applied label "${labelName}" to PR #${prNumber}`);
}

export async function removeLabel(octokit: Octokit, owner: string, repo: string, prNumber: number, labelName: string): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: prNumber, name: labelName });
    core.info(`Removed label "${labelName}" from PR #${prNumber}`);
  } catch (error: unknown) {
    const httpError = error as { status?: number };
    if (httpError.status === 404) {
      core.debug(`Label "${labelName}" was not on PR #${prNumber}`);
    } else { throw error; }
  }
}
