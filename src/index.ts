import * as core from "@actions/core";
import * as github from "@actions/github";
import { handleLabeled, handleReviewSubmitted } from "./router";
import { detectCapabilities } from "./auth";
import { loadTeamsConfigForOrg } from "./config";
import { ActionInputs } from "./types";

async function run(): Promise<void> {
  const inputs: ActionInputs = {
    githubToken: core.getInput("github-token", { required: true }),
    slackToken: core.getInput("slack-token"),
    configRepo: core.getInput("config-repo"),
    configS3: core.getInput("config-s3"),
    readyLabel: core.getInput("ready-label"),
    needsReviewPrefix: core.getInput("needs-review-prefix"),
    needsReviewLabelColor: core.getInput("needs-review-label-color"),
  };

  const context = github.context;
  const { owner, repo } = context.repo;
  const octokit = github.getOctokit(inputs.githubToken);

  const teamsConfig = await loadTeamsConfigForOrg(
    owner,
    octokit,
    inputs.configRepo,
    inputs.configS3
  );

  const capabilities = await detectCapabilities(octokit, owner);

  const eventName = context.eventName;
  const action = context.payload.action;

  if (
    (eventName === "pull_request" || eventName === "pull_request_target") &&
    action === "labeled"
  ) {
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

    await handleLabeled(octokit, {
      owner,
      repo,
      prNumber: pr.number,
      baseBranch: pr.base.ref,
      prUrl: pr.html_url ?? "",
      prTitle: pr.title ?? "",
      author: pr.user?.login ?? "",
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      commits: pr.commits ?? 0,
      labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
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
