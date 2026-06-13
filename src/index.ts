import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  handleLabeled,
  handleReviewSubmitted,
  handleOpened,
  handleClosed,
  handleComment,
} from "./router";
import { COMMENT_MARKER } from "./comment";
import { handleSchedule } from "./reminders";
import { detectCapabilities } from "./auth";
import { loadTeamsConfigForOrg } from "./config";
import { ActionInputs } from "./types";

async function run(): Promise<void> {
  const inputs: ActionInputs = {
    githubToken: core.getInput("github-token", { required: true }),
    slackToken: core.getInput("slack-token"),
    configRepo: core.getInput("config-repo"),
    configToken: core.getInput("config-token"),
    configPath: core.getInput("config-path"),
    configS3: core.getInput("config-s3"),
    readyLabel: core.getInput("ready-label"),
    needsReviewPrefix: core.getInput("needs-review-prefix"),
    needsReviewLabelColor: core.getInput("needs-review-label-color"),
  };

  const context = github.context;
  const { owner, repo } = context.repo;
  const octokit = github.getOctokit(inputs.githubToken);

  const eventName = context.eventName;
  const action = context.payload.action;

  if (eventName === "issue_comment" && action === "created") {
    const comment = context.payload.comment;
    const issue = context.payload.issue;
    if (!comment || !issue || !issue.pull_request) {
      core.info("Ignoring non-PR comment");
      return;
    }

    if (context.payload.sender?.type === "Bot") {
      core.info("Ignoring bot comment");
      return;
    }

    // /review command — handle and return (no thread notification)
    if ((comment.body ?? "").trim() === "/review") {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: issue.number,
        labels: [inputs.readyLabel],
      });
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: comment.id,
        content: "rocket",
      });
      core.info(`Added "${inputs.readyLabel}" label to PR #${issue.number} via /review comment`);
      return;
    }

    // Thread notification for general comments
    if (comment.body?.includes(COMMENT_MARKER)) {
      core.info("Ignoring review-router's own comment");
      return;
    }

    const prAuthor = issue.user?.login ?? "";
    const commenterLogin = comment.user?.login ?? "";
    if (commenterLogin === prAuthor) {
      core.info("Ignoring comment from PR author");
      return;
    }

    const teamsConfig = await loadTeamsConfigForOrg(
      owner,
      octokit,
      inputs.configRepo,
      inputs.configToken,
      inputs.configPath,
      inputs.configS3
    );

    // issue_comment payload doesn't include PR body — fetch it
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: issue.number,
    });

    await handleComment(octokit, {
      owner,
      repo,
      prNumber: issue.number,
      prBody: pr.body ?? "",
      prUrl: pr.html_url ?? "",
      author: prAuthor,
      commenter: commenterLogin,
      commentUrl: comment.html_url ?? "",
      kind: "comment",
      inputs,
      teamsConfig,
    });
    return;
  }

  const teamsConfig = await loadTeamsConfigForOrg(
    owner,
    octokit,
    inputs.configRepo,
    inputs.configToken,
    inputs.configPath,
    inputs.configS3
  );

  const capabilities = await detectCapabilities(octokit, owner);

  if (eventName === "schedule") {
    await handleSchedule(octokit, {
      owner,
      repo,
      inputs,
      teamsConfig,
    });
    return;
  }

  if (
    (eventName === "pull_request" || eventName === "pull_request_target") &&
    action === "opened"
  ) {
    const pr = context.payload.pull_request;
    if (!pr) {
      core.setFailed("No pull_request in payload");
      return;
    }

    await handleOpened(octokit, {
      owner,
      repo,
      prNumber: pr.number,
      author: pr.user?.login ?? "",
      inputs,
      teamsConfig,
    });
    return;
  }

  if (
    (eventName === "pull_request" || eventName === "pull_request_target") &&
    action === "closed"
  ) {
    const pr = context.payload.pull_request;
    if (!pr) {
      core.setFailed("No pull_request in payload");
      return;
    }

    await handleClosed(octokit, {
      owner,
      repo,
      prNumber: pr.number,
      prBody: pr.body ?? "",
      merged: pr.merged ?? false,
      inputs,
      teamsConfig,
    });
    return;
  }

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
  } else if (eventName === "pull_request_review" && action === "submitted") {
    const pr = context.payload.pull_request;
    const review = context.payload.review;
    if (!pr || !review) {
      core.setFailed("Missing pull_request or review in payload");
      return;
    }

    if (review.state === "approved") {
      await handleReviewSubmitted(octokit, {
        owner,
        repo,
        prNumber: pr.number,
        prBody: pr.body ?? "",
        prUrl: pr.html_url ?? "",
        author: pr.user?.login ?? "",
        reviewer: review.user.login,
        inputs,
        capabilities,
        teamsConfig,
      });

      // Thread notification for approval
      const prAuthor = pr.user?.login ?? "";
      const reviewer = review.user?.login ?? "";
      if (reviewer !== prAuthor && context.payload.sender?.type !== "Bot") {
        await handleComment(octokit, {
          owner,
          repo,
          prNumber: pr.number,
          prBody: pr.body ?? "",
          prUrl: pr.html_url ?? "",
          author: prAuthor,
          commenter: reviewer,
          commentUrl: "",
          kind: "review",
          inputs,
          teamsConfig,
        });
      }
    } else if (review.state === "commented") {
      const prAuthor = pr.user?.login ?? "";
      const reviewer = review.user?.login ?? "";

      if (
        reviewer !== prAuthor &&
        context.payload.sender?.type !== "Bot" &&
        !(review.body ?? "").includes(COMMENT_MARKER) &&
        (review.body ?? "").trim().length > 0
      ) {
        await handleComment(octokit, {
          owner,
          repo,
          prNumber: pr.number,
          prBody: pr.body ?? "",
          prUrl: pr.html_url ?? "",
          author: prAuthor,
          commenter: reviewer,
          commentUrl: review.html_url ?? "",
          kind: "review",
          inputs,
          teamsConfig,
        });
      }
    } else {
      core.info(`Ignoring review with state "${review.state}"`);
    }
  } else if (eventName === "pull_request_review_comment" && action === "created") {
    const pr = context.payload.pull_request;
    const reviewComment = context.payload.comment;
    if (!pr || !reviewComment) {
      core.setFailed("Missing pull_request or comment in payload");
      return;
    }

    const prAuthor = pr.user?.login ?? "";
    const commenter = reviewComment.user?.login ?? "";

    if (context.payload.sender?.type === "Bot" || commenter === prAuthor) {
      core.info("Ignoring bot or self review comment");
      return;
    }

    await handleComment(octokit, {
      owner,
      repo,
      prNumber: pr.number,
      prBody: pr.body ?? "",
      prUrl: pr.html_url ?? "",
      author: prAuthor,
      commenter,
      commentUrl: reviewComment.html_url ?? "",
      kind: "review_comment",
      inputs,
      teamsConfig,
    });
  } else {
    core.info(`Ignoring event: ${eventName}/${action}`);
  }
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
