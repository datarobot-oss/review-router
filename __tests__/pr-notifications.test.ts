import * as core from "@actions/core";
import {
  handleAssigned,
  handleComment,
  handleDequeued,
  handleDescriptionMentions,
  handleReviewedPush,
  handleReviewRequested,
} from "../src/router";
import * as slack from "../src/slack";
import { noteUnmapped, reportUnmapped, takeUnmapped } from "../src/unmapped";
import { OrgConfig } from "../src/types";

jest.mock("@actions/core");
jest.mock("../src/labels");
jest.mock("../src/comment");
jest.mock("../src/slack");
jest.mock("../src/checks");

const inputs = {
  githubToken: "token",
  slackToken: "xoxb-slack-token",
  configRepo: "",
  configToken: "",
  configPath: "config.yml",
  configS3: "",
  readyLabel: "Ready for Review",
  needsReviewPrefix: "Needs Review",
  needsReviewLabelColor: "fbca04",
  jiraToken: "",
  aiToken: "",
};

const teamsConfig: OrgConfig = {
  teams: {},
  users: { bob: "U_BOB", carol: "U_CAROL", erin: "U_ERIN" },
};

const prUrl = "https://github.com/org/repo/pull/1";
const base = {
  owner: "org",
  repo: "repo",
  prNumber: 1,
  prBody: "",
  prUrl,
  prTitle: "Add retry",
  inputs,
  teamsConfig,
};

const octokit = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
  takeUnmapped();
  (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);
});

describe("handleDescriptionMentions", () => {
  const opened = { ...base, author: "bob", prBody: "@carol can you look at the retry?" };

  it("sends a person named in the description a DM", async () => {
    await handleDescriptionMentions(octokit, opened);

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({
        headline: ":bell: *Mention* from <@U_BOB>",
        prUrl,
        prTitle: "Add retry",
      })
    );
  });

  it("sends a person named twice one DM", async () => {
    await handleDescriptionMentions(octokit, { ...opened, prBody: "@carol and again @Carol" });

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to the author for a self mention", async () => {
    await handleDescriptionMentions(octokit, { ...opened, prBody: "cc @bob" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("ignores a mention in code", async () => {
    await handleDescriptionMentions(octokit, { ...opened, prBody: "run `@carol` in a shell" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("does not note a mentioned login that has no Slack user, which can be a bot or an outsider", async () => {
    await handleDescriptionMentions(octokit, { ...opened, prBody: "@dependabot rebase" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(takeUnmapped()).toEqual([]);
  });

  it("does nothing without a Slack token", async () => {
    await handleDescriptionMentions(octokit, {
      ...opened,
      inputs: { ...inputs, slackToken: "" },
    });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });
});

describe("handleAssigned", () => {
  const assigned = { ...base, assigner: "bob", assignee: "carol" };

  it("sends the assignee a DM", async () => {
    await handleAssigned(octokit, assigned);

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({ headline: ":eyes: *Assigned* to you by <@U_BOB>" })
    );
  });

  it("sends nothing when people assign themselves", async () => {
    await handleAssigned(octokit, { ...assigned, assigner: "carol" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("matches the assignee's login to the Slack user whatever its case", async () => {
    await handleAssigned(octokit, { ...assigned, assignee: "Carol" });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({ headline: expect.stringContaining("*Assigned*") })
    );
  });

  it("notes an assignee that has no Slack user", async () => {
    await handleAssigned(octokit, { ...assigned, assignee: "dave" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(takeUnmapped()).toEqual(["dave"]);
  });

  it("does nothing without a Slack token", async () => {
    await handleAssigned(octokit, { ...assigned, inputs: { ...inputs, slackToken: "" } });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });
});

describe("handleDequeued", () => {
  const dequeued = { ...base, author: "carol", remover: "github-merge-queue[bot]" };

  it.each([
    ["CI_FAILURE", "the queue checks failed"],
    ["CI_TIMEOUT", "the queue checks timed out"],
    ["MERGE_CONFLICT", "of a merge conflict"],
    ["BRANCH_PROTECTIONS", "it no longer meets the branch rules"],
    ["QUEUE_CLEARED", "the queue was cleared"],
    ["ROLL_BACK", "the queue rolled back"],
    ["GIT_TREE_INVALID", "the merge commit could not be built"],
    ["INVALID_MERGE_COMMIT", "the merge commit could not be built"],
    ["UNKNOWN_REMOVAL_REASON", "the reason is unknown"],
  ])("tells the author who lost the queue spot to %s", async (reason, why) => {
    await handleDequeued(octokit, { ...dequeued, reason });

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({ headline: `:warning: *Left the merge queue*: ${why}` })
    );
  });

  it.each(["MERGE", "ALREADY_MERGED"])(
    "sends nothing when the removal is the merge itself (%s)",
    async (reason) => {
      await handleDequeued(octokit, { ...dequeued, reason });

      expect(slack.sendSlackDm).not.toHaveBeenCalled();
      expect(takeUnmapped()).toEqual([]);
    }
  );

  it("says who removed the pull request by hand", async () => {
    await handleDequeued(octokit, { ...dequeued, reason: "MANUAL", remover: "bob" });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({ headline: ":warning: *Left the merge queue*: <@U_BOB> removed it" })
    );
  });

  it("sends nothing when the author removed the pull request", async () => {
    await handleDequeued(octokit, { ...dequeued, reason: "MANUAL", remover: "carol" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("notes an author that has no Slack user", async () => {
    await handleDequeued(octokit, { ...dequeued, reason: "CI_FAILURE", author: "dave" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(takeUnmapped()).toEqual(["dave"]);
  });

  it("sends nothing for a bot author and does not count it as unmapped", async () => {
    await handleDequeued(octokit, {
      ...dequeued,
      reason: "CI_FAILURE",
      author: "dependabot[bot]",
    });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(takeUnmapped()).toEqual([]);
  });

  it("does nothing without a Slack token", async () => {
    await handleDequeued(octokit, {
      ...dequeued,
      reason: "CI_FAILURE",
      inputs: { ...inputs, slackToken: "" },
    });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });
});

describe("notes of logins without a Slack user in the other handlers", () => {
  const comment = {
    ...base,
    author: "bob",
    commenter: "carol",
    commentUrl: "",
    assignees: [] as string[],
    kind: "comment" as const,
  };

  it("does not note a mentioned login in a comment, which can be a bot or an outsider", async () => {
    await handleComment(octokit, { ...comment, body: "@dependabot rebase" });

    expect(takeUnmapped()).toEqual([]);
  });

  it("does not note the author of a commented pull request, who can be an outsider", async () => {
    await handleComment(octokit, { ...comment, author: "dave" });

    expect(takeUnmapped()).toEqual([]);
  });

  it("matches the author of a commented pull request to the Slack user whatever its case", async () => {
    await handleComment(octokit, { ...comment, author: "Bob" });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_BOB",
      expect.objectContaining({ headline: expect.stringContaining("*Comment* from") })
    );
    expect(takeUnmapped()).toEqual([]);
  });

  it("matches an assignee of a commented pull request to the Slack user whatever its case", async () => {
    await handleComment(octokit, { ...comment, assignees: ["Erin"] });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_ERIN",
      expect.objectContaining({ headline: expect.stringContaining("assigned to you") })
    );
    expect(takeUnmapped()).toEqual([]);
  });

  it("notes an assignee of a commented pull request", async () => {
    await handleComment(octokit, { ...comment, assignees: ["dave"] });

    expect(takeUnmapped()).toEqual(["dave"]);
  });

  it("notes a requested reviewer", async () => {
    await handleReviewRequested(octokit, { ...base, requester: "bob", reviewer: "dave" });

    expect(takeUnmapped()).toEqual(["dave"]);
  });
});

describe("noteUnmapped, takeUnmapped and reportUnmapped", () => {
  it("returns each login once, whatever its case, and clears the list", () => {
    noteUnmapped("Dave");
    noteUnmapped("dave");
    noteUnmapped("erin");

    expect(takeUnmapped()).toEqual(["Dave", "erin"]);
    expect(takeUnmapped()).toEqual([]);
  });

  it("ignores bot logins", () => {
    noteUnmapped("dependabot[bot]");

    expect(takeUnmapped()).toEqual([]);
  });

  it("reports the logins in one notice and clears them", () => {
    noteUnmapped("dave");
    noteUnmapped("erin");

    reportUnmapped();

    expect(core.notice).toHaveBeenCalledTimes(1);
    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining("dave, erin"));
    expect(takeUnmapped()).toEqual([]);
  });

  it("says login in the singular for one login", () => {
    noteUnmapped("dave");

    reportUnmapped();

    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining("1 GitHub login has no"));
  });

  it("reports nothing when every login had a Slack user", () => {
    reportUnmapped();

    expect(core.notice).not.toHaveBeenCalled();
  });

  it("names the first logins and counts the rest when many are missing", () => {
    for (let i = 0; i < 25; i++) noteUnmapped(`user${i}`);

    reportUnmapped();

    const message = (core.notice as jest.Mock).mock.calls[0][0] as string;
    expect(message).toContain("25 GitHub logins");
    expect(message).toContain("user0");
    expect(message).not.toContain("user24");
    expect(message).toContain("and 5 more");
  });
});

describe("handleReviewedPush", () => {
  const review = (login: string, state: string, commitId: string) => ({
    user: { login },
    state,
    commit_id: commitId,
  });
  const listReviews = jest.fn();
  const listCommits = jest.fn();
  const reviewsOf = (reviews: object[], commits: object[] = []) => {
    const client = {
      paginate: jest.fn((endpoint: unknown) =>
        Promise.resolve(endpoint === listCommits ? commits : reviews)
      ),
      rest: { pulls: { listReviews, listCommits } },
    };
    return client as never;
  };
  const commit = (sha: string, login: string | null, type = "User") => ({
    sha,
    author: login === null ? null : { login, type },
  });
  const pushed = { ...base, author: "bob", pusher: "bob", before: "sha1" };

  it("tells a reviewer who requested changes on the reviewed commit that the author pushed", async () => {
    const client = reviewsOf([review("carol", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, pushed);

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({
        headline: ":repeat: *New commits* from <@U_BOB>, where you requested changes",
      })
    );
  });

  it("tells each reviewer who requested changes on the reviewed commit", async () => {
    const client = reviewsOf([
      review("carol", "CHANGES_REQUESTED", "sha1"),
      review("erin", "CHANGES_REQUESTED", "sha1"),
    ]);

    await handleReviewedPush(client, {
      ...pushed,
      teamsConfig: { ...teamsConfig, users: { ...teamsConfig.users, erin: "U_ERIN" } },
    });

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(2);
  });

  it("tells the reviewer after a bot commit that followed the review", async () => {
    const client = reviewsOf(
      [review("carol", "CHANGES_REQUESTED", "sha1")],
      [commit("sha1", "bob"), commit("shaBot", "github-actions[bot]", "Bot"), commit("sha3", "bob")]
    );

    await handleReviewedPush(client, { ...pushed, before: "shaBot" });

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CAROL",
      expect.objectContaining({ headline: expect.stringContaining("where you requested changes") })
    );
  });

  it("sends nothing when a person's commit already followed the review", async () => {
    const client = reviewsOf(
      [review("carol", "CHANGES_REQUESTED", "sha1")],
      [
        commit("sha1", "bob"),
        commit("shaHuman", "bob"),
        commit("shaBot", "dependabot[bot]", "Bot"),
        commit("sha4", "bob"),
      ]
    );

    await handleReviewedPush(client, { ...pushed, before: "shaBot" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("counts a commit with no GitHub user as a person's commit", async () => {
    const client = reviewsOf(
      [review("carol", "CHANGES_REQUESTED", "sha1")],
      [commit("sha1", "bob"), commit("shaUnlinked", null), commit("sha3", "bob")]
    );

    await handleReviewedPush(client, { ...pushed, before: "shaUnlinked" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing when the reviewed commit is no longer in the pull request", async () => {
    const client = reviewsOf(
      [review("carol", "CHANGES_REQUESTED", "sha1")],
      [commit("shaX", "bob"), commit("shaBot", "github-actions[bot]", "Bot")]
    );

    await handleReviewedPush(client, { ...pushed, before: "shaBot" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing when the previous head is older than the reviewed commit", async () => {
    const client = reviewsOf(
      [review("carol", "CHANGES_REQUESTED", "sha3")],
      [commit("sha1", "bob"), commit("sha2", "bob"), commit("sha3", "bob")]
    );

    await handleReviewedPush(client, { ...pushed, before: "sha1" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing when only bot commits remain and the reviewed commit is gone", async () => {
    const client = reviewsOf(
      [review("carol", "CHANGES_REQUESTED", "sha1")],
      [commit("shaBot1", "github-actions[bot]", "Bot"), commit("shaBot", "dependabot[bot]", "Bot")]
    );

    await handleReviewedPush(client, { ...pushed, before: "shaBot" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("does not read the commits when the review is on the previous head", async () => {
    const client = reviewsOf([review("carol", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, pushed);

    const calls = (client as unknown as { paginate: jest.Mock }).paginate.mock.calls;
    expect(calls.map((call) => call[0])).not.toContain(listCommits);
  });

  it("warns and sends nothing when the commits can't be read", async () => {
    const client = {
      paginate: jest.fn((endpoint: unknown) =>
        endpoint === listCommits
          ? Promise.reject(new Error("commits down"))
          : Promise.resolve([review("carol", "CHANGES_REQUESTED", "sha1")])
      ),
      rest: { pulls: { listReviews, listCommits } },
    } as never;

    await expect(
      handleReviewedPush(client, { ...pushed, before: "shaBot" })
    ).resolves.toBeUndefined();

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("commits down"));
    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing on a later push, when the previous head is not the reviewed commit", async () => {
    const client = reviewsOf([review("carol", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, { ...pushed, before: "sha2" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing to a reviewer who approved after requesting changes", async () => {
    const client = reviewsOf([
      review("carol", "CHANGES_REQUESTED", "sha1"),
      review("carol", "APPROVED", "sha1"),
    ]);

    await handleReviewedPush(client, pushed);

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("keeps a request for changes that a later comment review does not clear", async () => {
    const client = reviewsOf([
      review("carol", "CHANGES_REQUESTED", "sha1"),
      review("carol", "COMMENTED", "sha1"),
    ]);

    await handleReviewedPush(client, pushed);

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to a reviewer whose review was dismissed", async () => {
    const client = reviewsOf([
      review("carol", "CHANGES_REQUESTED", "sha1"),
      review("carol", "DISMISSED", "sha1"),
    ]);

    await handleReviewedPush(client, pushed);

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing for an approval or a plain comment", async () => {
    const client = reviewsOf([
      review("carol", "APPROVED", "sha1"),
      review("erin", "COMMENTED", "sha1"),
    ]);

    await handleReviewedPush(client, pushed);

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing to the person who pushed", async () => {
    const client = reviewsOf([review("carol", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, { ...pushed, pusher: "carol" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("sends nothing to the author, who just pushed their own changes", async () => {
    const client = reviewsOf([review("bob", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, { ...pushed, pusher: "carol" });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("notes a reviewer that has no Slack user", async () => {
    const client = reviewsOf([review("dave", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, pushed);

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(takeUnmapped()).toEqual(["dave"]);
  });

  it("warns and sends nothing when the reviews can't be read", async () => {
    const client = {
      paginate: jest.fn().mockRejectedValue(new Error("boom")),
      rest: { pulls: { listReviews: jest.fn() } },
    } as never;

    await expect(handleReviewedPush(client, pushed)).resolves.toBeUndefined();

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });

  it("does not read the reviews without a Slack token", async () => {
    const client = reviewsOf([review("carol", "CHANGES_REQUESTED", "sha1")]);

    await handleReviewedPush(client, { ...pushed, inputs: { ...inputs, slackToken: "" } });

    expect((client as unknown as { paginate: jest.Mock }).paginate).not.toHaveBeenCalled();
    expect(slack.sendSlackDm).not.toHaveBeenCalled();
  });
});
