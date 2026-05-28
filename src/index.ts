import * as core from "@actions/core";
import * as github from "@actions/github";
import * as path from "path";
import { handleLabeled, handleReviewSubmitted } from "./router";
import { detectCapabilities, isOrgMember } from "./auth";
import { loadTeamsConfig, fetchOrgTeamsConfig } from "./config";
import { ActionInputs } from "./types";

async function run(): Promise<void> {
  const inputs: ActionInputs = {
    githubToken: core.getInput("github-token", { required: true }),
    slackToken: core.getInput("slack-token"),
    readyLabel: core.getInput("ready-label"),
    needsReviewPrefix: core.getInput("needs-review-prefix"),
    needsReviewLabelColor: core.getInput("needs-review-label-color"),
  };

  const octokit = github.getOctokit(inputs.githubToken);
  const context = github.context;
  const { owner, repo } = context.repo;

  const orgConfig = await fetchOrgTeamsConfig(octokit, owner);
  const teamsConfig = orgConfig ?? loadTeamsConfig(
    path.join(__dirname, "..", "config", "teams.yml")
  );

  const capabilities = await detectCapabilities(octokit, owner);

  const eventName = context.eventName;
  const action = context.payload.action;

  if (eventName === "pull_request" && action === "labeled") {
    const pr = context.payload.pull_request;
    if (!pr) {
      core.setFailed("No pull_request in payload");
      return;
    }

    const labelName = context.payload.label?.name;
    if (labelName !== inputs.readyLabel) {
      core.info(`Ignoring label "${labelName}" (not "${inputs.readyLabel}")`);
      return;
    }

    const author = pr.user?.login ?? "";
    if (capabilities.hasOrgAccess && author && !(await isOrgMember(octokit, owner, author))) {
      core.info(
        `Skipping review routing — PR author "${author}" is not a member of the ${owner} org`
      );
      return;
    }

    await handleLabeled(octokit, {
      owner,
      repo,
      prNumber: pr.number,
      baseBranch: pr.base.ref,
      prUrl: pr.html_url ?? "",
      prTitle: pr.title ?? "",
      author: pr.user?.login ?? "",
      inputs,
      capabilities,
      teamsConfig,
    });
  } else if (
    eventName === "pull_request_review" &&
    action === "submitted"
  ) {
    const pr = context.payload.pull_request;
    const review = context.payload.review;
    if (!pr || !review) {
      core.setFailed("Missing pull_request or review in payload");
      return;
    }

    if (review.state !== "approved") {
      core.info(`Ignoring review with state "${review.state}" (not "approved")`);
      return;
    }

    await handleReviewSubmitted(octokit, {
      owner,
      repo,
      prNumber: pr.number,
      reviewer: review.user.login,
      inputs,
      capabilities,
      teamsConfig,
    });
  } else {
    core.info(`Ignoring event: ${eventName}/${action}`);
  }
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
