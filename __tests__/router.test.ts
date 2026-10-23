import {
  handleLabeled,
  handleReviewSubmitted,
  handleOpened,
  handleReadyForReview,
  handleClosed,
  syncReviewCheck,
  handleComment,
  resolveTeamSlugFromLabel,
  getFileTypeEmojis,
  isReadyLabel,
  isHumanTeamLabel,
  classifyLabel,
  shouldSkipDuplicateRouting,
} from "../src/router";
import * as codeowners from "../src/codeowners";
import * as labels from "../src/labels";
import * as comment from "../src/comment";
import * as slack from "../src/slack";
import * as checks from "../src/checks";

const mockPostExternalComment = comment.postExternalComment as jest.MockedFunction<
  typeof comment.postExternalComment
>;
import { OrgConfig } from "../src/types";

jest.mock("../src/labels");
jest.mock("../src/comment");
jest.mock("../src/slack");
jest.mock("../src/checks");

const mockOctokit = {
  rest: {
    pulls: {
      listFiles: jest.fn(),
      requestReviewers: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
    },
    repos: {
      getContent: jest.fn(),
      getCollaboratorPermissionLevel: jest.fn(),
    },
    orgs: {
      checkMembershipForUser: jest.fn(),
    },
    teams: {
      getMembershipForUserInOrg: jest.fn(),
    },
    issues: {
      listLabelsOnIssue: jest.fn(),
      listComments: jest.fn(),
      createComment: jest.fn(),
      removeLabel: jest.fn(),
      addLabels: jest.fn(),
    },
  },
  paginate: jest.fn(),
};

const teamsConfig: OrgConfig = {
  teams: {
    "customer-engineering": {
      label: "Needs Review: Customer Engineering",
      slack_channel: "#app-templates-tests",
    },
    "platform-team": {
      label: "Needs Review: Platform",
      slack_channel: "#platform-reviews",
    },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOctokit.rest.pulls.get.mockResolvedValue({ data: { body: "" } });
  mockOctokit.rest.pulls.update.mockResolvedValue({});
  mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
    data: { permission: "none" },
  });
});

describe("handleLabeled", () => {
  it("applies labels and posts comment for owned files", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { filename: "src/app.py" },
      { filename: "infra/main.tf" },
    ]);

    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue(
        "* @datarobot-community/customer-engineering\ninfra/ @datarobot-community/platform-team\n"
      );

    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
    (slack.sendSlackNotification as jest.Mock).mockResolvedValue(undefined);

    await handleLabeled(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      baseBranch: "main",
      prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
      prTitle: "Test PR",
      author: "alice",
      additions: 10,
      deletions: 5,
      commits: 1,
      labels: [],
      inputs: {
        githubToken: "token",
        slackToken: "",
        configRepo: "",
        configToken: "",
        configPath: "config.yml",
        configS3: "",
        readyLabel: "Ready for Review",
        needsReviewPrefix: "Needs Review",
        needsReviewLabelColor: "fbca04",
        jiraToken: "",
        aiToken: "",
      },
      capabilities: { hasOrgAccess: false },
      teamsConfig,
    });

    expect(labels.ensureLabel).toHaveBeenCalled();
    expect(labels.applyLabels).toHaveBeenCalled();
    expect(comment.upsertComment).toHaveBeenCalled();
  });

  it("requests team review when hasOrgAccess is true", async () => {
    mockOctokit.paginate.mockResolvedValue([{ filename: "src/app.py" }]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue("* @datarobot-community/customer-engineering\n");
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
    mockOctokit.rest.pulls.requestReviewers.mockResolvedValue({});

    await handleLabeled(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      baseBranch: "main",
      prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
      prTitle: "Test PR",
      author: "alice",
      additions: 10,
      deletions: 5,
      commits: 1,
      labels: [],
      inputs: {
        githubToken: "token",
        slackToken: "",
        configRepo: "",
        configToken: "",
        configPath: "config.yml",
        configS3: "",
        readyLabel: "Ready for Review",
        needsReviewPrefix: "Needs Review",
        needsReviewLabelColor: "fbca04",
        jiraToken: "",
        aiToken: "",
      },
      capabilities: { hasOrgAccess: true },
      teamsConfig,
    });

    expect(mockOctokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
      owner: "datarobot-community",
      repo: "test-repo",
      pull_number: 1,
      team_reviewers: ["customer-engineering"],
    });
  });

  it("falls back to per-team requestReviewers on batch failure", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { filename: "src/app.py" },
      { filename: "infra/main.tf" },
    ]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue(
        "* @datarobot-community/customer-engineering\ninfra/ @datarobot-community/platform-team\n"
      );
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
    mockOctokit.rest.pulls.requestReviewers
      .mockRejectedValueOnce(new Error("Batch failed"))
      .mockResolvedValue({});

    await handleLabeled(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      baseBranch: "main",
      prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
      prTitle: "Test PR",
      author: "alice",
      additions: 10,
      deletions: 5,
      commits: 1,
      labels: [],
      inputs: {
        githubToken: "token",
        slackToken: "",
        configRepo: "",
        configToken: "",
        configPath: "config.yml",
        configS3: "",
        readyLabel: "Ready for Review",
        needsReviewPrefix: "Needs Review",
        needsReviewLabelColor: "fbca04",
        jiraToken: "",
        aiToken: "",
      },
      capabilities: { hasOrgAccess: true },
      teamsConfig,
    });

    // First call is batched (fails), then two per-team fallback calls
    expect(mockOctokit.rest.pulls.requestReviewers).toHaveBeenCalledTimes(3);
    expect(mockOctokit.rest.pulls.requestReviewers).toHaveBeenNthCalledWith(1, {
      owner: "datarobot-community",
      repo: "test-repo",
      pull_number: 1,
      team_reviewers: ["customer-engineering", "platform-team"],
    });
  });

  it("warns but does not fail when requestReviewers throws", async () => {
    mockOctokit.paginate.mockResolvedValue([{ filename: "src/app.py" }]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue("* @datarobot-community/customer-engineering\n");
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
    mockOctokit.rest.pulls.requestReviewers.mockRejectedValue(new Error("Not Found"));

    await expect(
      handleLabeled(mockOctokit as any, {
        owner: "datarobot-community",
        repo: "test-repo",
        prNumber: 1,
        baseBranch: "main",
        prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
        prTitle: "Test PR",
        author: "alice",
        additions: 10,
        deletions: 5,
        commits: 1,
        labels: [],
        inputs: {
          githubToken: "token",
          slackToken: "",
          configRepo: "",
          configToken: "",
          configPath: "config.yml",
          configS3: "",
          readyLabel: "Ready for Review",
          needsReviewPrefix: "Needs Review",
          needsReviewLabelColor: "fbca04",
          jiraToken: "",
          aiToken: "",
        },
        capabilities: { hasOrgAccess: true },
        teamsConfig,
      })
    ).resolves.not.toThrow();
  });

  it("sends Slack notification when token and channel are configured", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { filename: "src/app.py", additions: 5, deletions: 2 },
    ]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue("* @datarobot-community/customer-engineering\n");
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
    (slack.sendSlackNotification as jest.Mock).mockResolvedValue(undefined);

    await handleLabeled(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      baseBranch: "main",
      prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
      prTitle: "Test PR",
      author: "alice",
      additions: 5,
      deletions: 2,
      commits: 1,
      labels: ["bug", "Ready for Review"],
      inputs: {
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
      },
      capabilities: { hasOrgAccess: false },
      teamsConfig,
    });

    expect(slack.sendSlackNotification).toHaveBeenCalledWith(
      "xoxb-slack-token",
      "#app-templates-tests",
      expect.objectContaining({
        prNumber: 1,
        author: "alice",
        labels: ["bug"],
      })
    );
  });

  it("posts warning comment when CODEOWNERS is missing", async () => {
    mockOctokit.paginate.mockResolvedValue([{ filename: "src/app.py" }]);
    jest.spyOn(codeowners, "fetchCodeownersContent").mockResolvedValue(null);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);

    await handleLabeled(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      baseBranch: "main",
      prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
      prTitle: "Test PR",
      author: "alice",
      additions: 10,
      deletions: 5,
      commits: 1,
      labels: [],
      inputs: {
        githubToken: "token",
        slackToken: "",
        configRepo: "",
        configToken: "",
        configPath: "config.yml",
        configS3: "",
        readyLabel: "Ready for Review",
        needsReviewPrefix: "Needs Review",
        needsReviewLabelColor: "fbca04",
        jiraToken: "",
        aiToken: "",
      },
      capabilities: { hasOrgAccess: false },
      teamsConfig,
    });

    expect(labels.ensureLabel).not.toHaveBeenCalled();
    expect(comment.upsertComment).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-community",
      "test-repo",
      1,
      expect.stringContaining("CODEOWNERS")
    );
  });
});

describe("handleLabeled withRetry", () => {
  const baseCtx = {
    owner: "datarobot-community",
    repo: "test-repo",
    prNumber: 1,
    baseBranch: "main",
    prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
    prTitle: "Test PR",
    author: "alice",
    additions: 10,
    deletions: 5,
    commits: 1,
    labels: [],
    inputs: {
      githubToken: "token",
      slackToken: "",
      configRepo: "",
      configToken: "",
      configPath: "config.yml",
      configS3: "",
      readyLabel: "Ready for Review",
      needsReviewPrefix: "Needs Review",
      needsReviewLabelColor: "fbca04",
      jiraToken: "",
      aiToken: "",
    },
    capabilities: { hasOrgAccess: false },
    teamsConfig,
  };

  beforeEach(() => {
    mockOctokit.paginate.mockResolvedValue([{ filename: "src/app.py" }]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue("* @datarobot-community/customer-engineering\n");
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
  });

  it("retries upsertComment on transient 500 and succeeds", async () => {
    jest.useFakeTimers();
    const err500 = Object.assign(new Error("Internal Server Error"), { status: 500 });
    (comment.upsertComment as jest.Mock).mockRejectedValueOnce(err500).mockResolvedValue(undefined);

    const promise = handleLabeled(mockOctokit as any, baseCtx);
    await jest.runAllTimersAsync();
    await promise;

    expect(comment.upsertComment).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("does not retry upsertComment on 422 client error", async () => {
    const err422 = Object.assign(new Error("Unprocessable Entity"), { status: 422 });
    (comment.upsertComment as jest.Mock).mockRejectedValue(err422);

    await expect(handleLabeled(mockOctokit as any, baseCtx)).rejects.toMatchObject({
      status: 422,
    });

    expect(comment.upsertComment).toHaveBeenCalledTimes(1);
  });

  it("retries pulls.update on 500 and succeeds", async () => {
    jest.useFakeTimers();
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    // Return a non-empty refs list so the description update is attempted
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([
      { channel: "C123", ts: "1234567890.000001" },
    ]);
    (comment.embedSlackRefsInDescription as jest.Mock).mockReturnValue("updated body");
    const err500 = Object.assign(new Error("Internal Server Error"), { status: 500 });
    mockOctokit.rest.pulls.update.mockRejectedValueOnce(err500).mockResolvedValue({});

    const promise = handleLabeled(mockOctokit as any, baseCtx);
    await jest.runAllTimersAsync();
    await promise;

    expect(mockOctokit.rest.pulls.update).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});

describe("handleLabeled with a team label", () => {
  const ctx = {
    owner: "datarobot-community",
    repo: "test-repo",
    prNumber: 1,
    baseBranch: "main",
    prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
    prTitle: "Test PR",
    author: "alice",
    additions: 10,
    deletions: 5,
    commits: 1,
    labels: ["Needs Review: Platform"],
    inputs: {
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
    },
    capabilities: { hasOrgAccess: true },
    teamsConfig,
  };

  beforeEach(() => {
    mockOctokit.paginate.mockResolvedValue([
      { filename: "src/app.py", additions: 5, deletions: 2 },
      { filename: "infra/main.tf", additions: 5, deletions: 3 },
      { filename: "README.md", additions: 1, deletions: 0 },
    ]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue(
        "src/ @datarobot-community/customer-engineering\ninfra/ @datarobot-community/platform-team\n"
      );
    mockOctokit.rest.pulls.requestReviewers.mockResolvedValue({});
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
    (slack.sendSlackNotification as jest.Mock).mockResolvedValue(undefined);
  });

  it("notifies only the channel of the labeled team", async () => {
    await handleLabeled(mockOctokit as any, { ...ctx, teamLabel: "Needs Review: Platform" });

    expect(slack.sendSlackNotification).toHaveBeenCalledTimes(1);
    expect(slack.sendSlackNotification).toHaveBeenCalledWith(
      "xoxb-slack-token",
      "#platform-reviews",
      expect.anything()
    );
  });

  it("requests review only from the labeled team", async () => {
    await handleLabeled(mockOctokit as any, { ...ctx, teamLabel: "Needs Review: Platform" });

    expect(mockOctokit.rest.pulls.requestReviewers).toHaveBeenCalledTimes(1);
    expect(mockOctokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ team_reviewers: ["platform-team"] })
    );
  });

  it("limits the ownership comment to the labeled team", async () => {
    await handleLabeled(mockOctokit as any, { ...ctx, teamLabel: "Needs Review: Platform" });

    const [ownership] = (comment.buildOwnershipComment as jest.Mock).mock.calls[0];
    expect([...ownership.teamFiles.keys()]).toEqual(["platform-team"]);
    expect(ownership.unownedFiles).toEqual([]);
  });

  it("does nothing when the labeled team owns no file in the PR", async () => {
    await handleLabeled(mockOctokit as any, {
      ...ctx,
      teamLabel: "Needs Review: Data Science",
      labels: ["Needs Review: Data Science"],
    });

    expect(slack.sendSlackNotification).not.toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    expect(labels.applyLabels).not.toHaveBeenCalled();
    expect(comment.upsertComment).not.toHaveBeenCalled();
  });

  it("still notifies every owning team when no team label triggered the route", async () => {
    await handleLabeled(mockOctokit as any, { ...ctx, labels: ["Ready for Review"] });

    expect(slack.sendSlackNotification).toHaveBeenCalledTimes(2);
    expect(mockOctokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ team_reviewers: ["customer-engineering", "platform-team"] })
    );
  });
});

describe("isHumanTeamLabel", () => {
  it("accepts a team label added by a user", () => {
    expect(isHumanTeamLabel("Needs Review: Platform", "User", "Needs Review")).toBe(true);
  });

  it("rejects a team label added by a bot", () => {
    expect(isHumanTeamLabel("Needs Review: Platform", "Bot", "Needs Review")).toBe(false);
  });

  it("rejects a team label when the sender is unknown", () => {
    expect(isHumanTeamLabel("Needs Review: Platform", undefined, "Needs Review")).toBe(false);
  });

  it("rejects a label without the team prefix", () => {
    expect(isHumanTeamLabel("bug", "User", "Needs Review")).toBe(false);
  });

  it("rejects a label that has the prefix but no team separator", () => {
    expect(isHumanTeamLabel("Needs Reviewers", "User", "Needs Review")).toBe(false);
  });
});

describe("classifyLabel", () => {
  const classify = (label: string | undefined, sender: string | undefined, aliases?: string[]) =>
    classifyLabel(label, sender, "Ready for Review", aliases, "Needs Review");

  it("routes the ready label whoever added it", () => {
    expect(classify("Ready for Review", "Bot")).toEqual({ kind: "ready" });
  });

  it("routes a ready label alias", () => {
    expect(classify("Please Review", "User", ["Please Review"])).toEqual({ kind: "ready" });
  });

  it("routes one team for a team label added by a user", () => {
    expect(classify("Needs Review: Platform", "User")).toEqual({
      kind: "team",
      teamLabel: "Needs Review: Platform",
    });
  });

  it("ignores a team label added by a bot", () => {
    expect(classify("Needs Review: Platform", "Bot")).toEqual({ kind: "ignore" });
  });

  it("prefers the ready route when an alias also looks like a team label", () => {
    expect(classify("Needs Review: Now", "User", ["Needs Review: Now"])).toEqual({
      kind: "ready",
    });
  });

  it("ignores an unrelated label", () => {
    expect(classify("bug", "User")).toEqual({ kind: "ignore" });
  });

  it("ignores an event without a label", () => {
    expect(classify(undefined, "User")).toEqual({ kind: "ignore" });
  });
});

describe("handleReviewSubmitted", () => {
  const baseCtx = {
    owner: "datarobot-oss",
    repo: "test-repo",
    prNumber: 1,
    prBody: "",
    prUrl: "https://github.com/datarobot-oss/test-repo/pull/1",
    author: "alice",
    reviewer: "bob",
    inputs: {
      githubToken: "token",
      slackToken: "",
      configRepo: "",
      configToken: "",
      configPath: "config.yml",
      configS3: "",
      readyLabel: "Ready for Review",
      needsReviewPrefix: "Needs Review",
      needsReviewLabelColor: "fbca04",
      jiraToken: "",
      aiToken: "",
    },
    teamsConfig,
  };

  it("skips when no org access", async () => {
    await handleReviewSubmitted(mockOctokit as any, {
      ...baseCtx,
      capabilities: { hasOrgAccess: false },
    });

    expect(mockOctokit.rest.issues.listLabelsOnIssue).not.toHaveBeenCalled();
  });

  it("removes label when reviewer is a team member", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockResolvedValue({});
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);

    await handleReviewSubmitted(mockOctokit as any, {
      ...baseCtx,
      capabilities: { hasOrgAccess: true },
    });

    expect(mockOctokit.rest.teams.getMembershipForUserInOrg).toHaveBeenCalledWith({
      org: "datarobot-oss",
      team_slug: "customer-engineering",
      username: "bob",
    });
    expect(labels.removeLabel).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "Needs Review: Customer Engineering"
    );
  });

  it("keeps label when reviewer is not a team member", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockRejectedValue({ status: 404 });

    await handleReviewSubmitted(mockOctokit as any, {
      ...baseCtx,
      capabilities: { hasOrgAccess: true },
    });

    expect(labels.removeLabel).not.toHaveBeenCalled();
  });

  it("warns on non-404 team membership errors", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockRejectedValue(new Error("Server Error"));

    await expect(
      handleReviewSubmitted(mockOctokit as any, {
        ...baseCtx,
        capabilities: { hasOrgAccess: true },
      })
    ).resolves.not.toThrow();

    expect(labels.removeLabel).not.toHaveBeenCalled();
  });

  it("does nothing when no needs-review labels exist", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "bug" }, { name: "Ready for Review" }],
    });

    await handleReviewSubmitted(mockOctokit as any, {
      ...baseCtx,
      capabilities: { hasOrgAccess: true },
    });

    expect(mockOctokit.rest.teams.getMembershipForUserInOrg).not.toHaveBeenCalled();
    expect(labels.removeLabel).not.toHaveBeenCalled();
  });
});

describe("resolveTeamSlugFromLabel", () => {
  it("returns slug from config when label matches", () => {
    expect(
      resolveTeamSlugFromLabel("Needs Review: Customer Engineering", teamsConfig, "Needs Review")
    ).toBe("customer-engineering");
  });

  it("derives slug from label suffix when not in config", () => {
    expect(
      resolveTeamSlugFromLabel("Needs Review: Some New Team", teamsConfig, "Needs Review")
    ).toBe("some-new-team");
  });

  it("returns undefined for empty suffix", () => {
    expect(resolveTeamSlugFromLabel("Needs Review: ", teamsConfig, "Needs Review")).toBeUndefined();
  });
});

describe("isReadyLabel", () => {
  it("matches the canonical ready label", () => {
    expect(isReadyLabel("Ready for Review", "Ready for Review", ["00 - Ready for Review"])).toBe(
      true
    );
  });

  it("matches an alias", () => {
    expect(
      isReadyLabel("00 - Ready for Review", "Ready for Review", ["00 - Ready for Review"])
    ).toBe(true);
  });

  it("rejects an unrelated label", () => {
    expect(
      isReadyLabel("Needs Review: Applications", "Ready for Review", ["00 - Ready for Review"])
    ).toBe(false);
  });

  it("returns false when aliases is empty and label does not match canonical", () => {
    expect(isReadyLabel("00 - Ready for Review", "Ready for Review", [])).toBe(false);
  });

  it("defaults aliases to empty when not provided", () => {
    expect(isReadyLabel("Ready for Review", "Ready for Review")).toBe(true);
    expect(isReadyLabel("00 - Ready for Review", "Ready for Review")).toBe(false);
  });
});

describe("shouldSkipDuplicateRouting", () => {
  const primary = "Ready for Review";
  const aliases = ["00 - Ready for Review"];

  it("returns null when no other ready labels exist", () => {
    expect(shouldSkipDuplicateRouting(primary, [primary, "bug"], primary, aliases)).toBeNull();
  });

  it("skips alias when primary is also present", () => {
    const labels = [primary, "00 - Ready for Review", "bug"];
    expect(shouldSkipDuplicateRouting("00 - Ready for Review", labels, primary, aliases)).toBe(
      primary
    );
  });

  it("processes primary when alias is also present", () => {
    const labels = [primary, "00 - Ready for Review", "bug"];
    expect(shouldSkipDuplicateRouting(primary, labels, primary, aliases)).toBeNull();
  });

  it("picks alphabetically first alias when primary is absent", () => {
    const twoAliases = ["00 - Ready for Review", "01 - Ready for Review"];
    const labels = [...twoAliases, "bug"];
    expect(shouldSkipDuplicateRouting("01 - Ready for Review", labels, primary, twoAliases)).toBe(
      "00 - Ready for Review"
    );
    expect(
      shouldSkipDuplicateRouting("00 - Ready for Review", labels, primary, twoAliases)
    ).toBeNull();
  });

  it("returns null when only non-ready labels exist alongside the trigger", () => {
    expect(
      shouldSkipDuplicateRouting(primary, [primary, "enhancement", "bug"], primary, aliases)
    ).toBeNull();
  });
});

describe("handleOpened", () => {
  const baseInputs = {
    githubToken: "token",
    slackToken: "",
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

  it("skips when dependabot config is absent", async () => {
    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prTitle: "Test PR",
      author: "dependabot[bot]",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig,
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("skips when auto_label is false", async () => {
    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prTitle: "Test PR",
      author: "dependabot[bot]",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, dependabot: { auto_label: false } },
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("skips non-dependabot authors", async () => {
    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prTitle: "Test PR",
      author: "alice",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, dependabot: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("adds ready label for dependabot PRs", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 42,
      prTitle: "Test PR",
      author: "dependabot[bot]",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, dependabot: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 42,
      labels: ["Ready for Review"],
    });
  });

  it("adds external-contribution and ready labels for non-draft fork PRs", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "external-user",
      isFork: true,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        external_contributors: { auto_label: true, message: "Welcome!" },
      },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      labels: ["external-contribution", "Ready for Review"],
    });
    expect(mockPostExternalComment).toHaveBeenCalledWith(
      mockOctokit,
      "org",
      "repo",
      10,
      "Welcome!"
    );
  });

  it("skips comment when no message configured", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "external-user",
      isFork: true,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, external_contributors: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalled();
    expect(mockPostExternalComment).not.toHaveBeenCalled();
  });

  it("skips fork PRs when external_contributors is disabled", async () => {
    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "external-user",
      isFork: true,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig,
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("adds only external-contribution label for draft fork PRs", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "external-user",
      isFork: true,
      isDraft: true,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        external_contributors: { auto_label: true, message: "Welcome!" },
      },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      labels: ["external-contribution"],
    });
    expect(mockPostExternalComment).toHaveBeenCalledWith(
      mockOctokit,
      "org",
      "repo",
      10,
      "Welcome!"
    );
  });

  it("skips non-fork PRs even when external_contributors is enabled", async () => {
    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "internal-user",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, external_contributors: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("posts a Jira comment when the org has jira enabled and the title has a ticket", async () => {
    mockOctokit.paginate.mockResolvedValue([]);
    mockOctokit.rest.issues.createComment.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      prTitle: "[PROJ-6235] Migrate logs",
      author: "alice",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        jira: { enabled: true, base_url: "https://acme.atlassian.net" },
      },
    });

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "**[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)**"
        ),
      })
    );
  });

  it("does not post a Jira comment when the org has no jira config", async () => {
    await handleOpened(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      prTitle: "[PROJ-6235] Migrate logs",
      author: "alice",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig,
    });

    expect(mockOctokit.paginate).not.toHaveBeenCalledWith(
      mockOctokit.rest.issues.listComments,
      expect.anything()
    );
    expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("still posts a Jira comment for dependabot PRs before the early return", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});
    mockOctokit.paginate.mockResolvedValue([]);
    mockOctokit.rest.issues.createComment.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      prTitle: "[PROJ-6235] Migrate logs",
      author: "dependabot[bot]",
      isFork: false,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        dependabot: { auto_label: true },
        jira: { enabled: true, base_url: "https://acme.atlassian.net" },
      },
    });

    expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "**[PROJ-6235](https://acme.atlassian.net/browse/PROJ-6235)**"
        ),
      })
    );
  });

  it("skips labels for fork PR opened by admin maintainer", async () => {
    mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "admin" },
    });

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "maintainer",
      isFork: true,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        external_contributors: { auto_label: true, message: "Welcome!" },
      },
    });

    expect(mockOctokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      username: "maintainer",
    });
    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(mockPostExternalComment).not.toHaveBeenCalled();
  });

  it("skips labels for fork PR opened by write-permission maintainer", async () => {
    mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "write" },
    });

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "maintainer",
      isFork: true,
      isDraft: true,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        external_contributors: { auto_label: true, message: "Welcome!" },
      },
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(mockPostExternalComment).not.toHaveBeenCalled();
  });

  it("still labels fork PR when permission API fails", async () => {
    mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValue(new Error("API error"));

    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      prTitle: "Test PR",
      author: "someone",
      isFork: true,
      isDraft: false,
      inputs: baseInputs,
      teamsConfig: {
        ...teamsConfig,
        external_contributors: { auto_label: true, message: "Welcome!" },
      },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      labels: ["external-contribution", "Ready for Review"],
    });
    expect(mockPostExternalComment).toHaveBeenCalledWith(
      mockOctokit,
      "org",
      "repo",
      10,
      "Welcome!"
    );
  });
});

describe("handleReadyForReview", () => {
  const baseInputs = {
    githubToken: "token",
    slackToken: "",
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

  it("adds ready label for fork PRs marked ready", async () => {
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleReadyForReview(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      author: "external-user",
      isFork: true,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, external_contributors: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      labels: ["Ready for Review"],
    });
  });

  it("skips when external_contributors is disabled", async () => {
    await handleReadyForReview(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      author: "external-user",
      isFork: true,
      inputs: baseInputs,
      teamsConfig,
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("skips non-fork PRs", async () => {
    await handleReadyForReview(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      author: "internal-user",
      isFork: false,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, external_contributors: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("skips ready label for fork PR opened by maintainer", async () => {
    mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: "admin" },
    });

    await handleReadyForReview(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      author: "maintainer",
      isFork: true,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, external_contributors: { auto_label: true } },
    });

    expect(mockOctokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      username: "maintainer",
    });
    expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("still adds ready label when permission API fails", async () => {
    mockOctokit.rest.repos.getCollaboratorPermissionLevel.mockRejectedValue(new Error("API error"));
    mockOctokit.rest.issues.addLabels.mockResolvedValue({});

    await handleReadyForReview(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 10,
      author: "someone",
      isFork: true,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, external_contributors: { auto_label: true } },
    });

    expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 10,
      labels: ["Ready for Review"],
    });
  });
});

describe("handleClosed", () => {
  const baseInputs = {
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

  it("skips when PR was closed without merging", async () => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([]);

    await handleClosed(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody: "",
      merged: false,
      inputs: baseInputs,
      teamsConfig,
    });

    expect(mockOctokit.rest.issues.listLabelsOnIssue).not.toHaveBeenCalled();
  });

  it("removes review labels on merge", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }, { name: "bug" }],
    });
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([]);

    await handleClosed(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody: "",
      merged: true,
      inputs: baseInputs,
      teamsConfig,
    });

    expect(labels.removeLabel).toHaveBeenCalledTimes(2);
    expect(labels.removeLabel).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      "repo",
      1,
      "Ready for Review"
    );
    expect(labels.removeLabel).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      "repo",
      1,
      "Needs Review: Frontend"
    );
  });

  it("adds merged reaction to Slack messages", async () => {
    const prBody =
      "PR description\n<!-- rr:slack:start -->\n<!-- rr:slack:C123:1234.5678 -->\n<!-- rr:slack:end -->";
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Ready for Review" }],
    });
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C123", ts: "1234.5678" },
    ]);
    (slack.addSlackReactions as jest.Mock).mockResolvedValue(undefined);

    await handleClosed(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody,
      merged: true,
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, reactions: { enabled: true } },
    });

    expect(slack.addSlackReactions).toHaveBeenCalledWith(
      "xoxb-slack-token",
      { channel: "C123", ts: "1234.5678" },
      ["heavy_check_mark"]
    );
  });
});

describe("handleComment", () => {
  const baseInputs = {
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

  const configWithUsers: OrgConfig = {
    ...teamsConfig,
    notifications: { dm: { enabled: false } },
    users: { alice: "U12345" },
  };

  it("posts thread reply to all Slack refs", async () => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
      { channel: "C222", ts: "2222.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(false);
    (slack.postSlackThreadReply as jest.Mock).mockResolvedValue(undefined);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:C222:2222.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: [],
      kind: "comment",
      inputs: baseInputs,
      teamsConfig: configWithUsers,
    });

    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(2);
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("new comment from *bob*")
    );
  });

  it("skips when message is muted", async () => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(true);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: [],
      kind: "comment",
      inputs: baseInputs,
      teamsConfig: configWithUsers,
    });

    expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
  });

  it("skips when no Slack ID for author", async () => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "unknown-user",
      commenter: "bob",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: [],
      kind: "comment",
      inputs: baseInputs,
      teamsConfig: configWithUsers,
    });

    expect(slack.isSlackMessageMuted).not.toHaveBeenCalled();
    expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
  });

  it("skips when no Slack token", async () => {
    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: [],
      kind: "comment",
      inputs: { ...baseInputs, slackToken: "" },
      teamsConfig: configWithUsers,
    });

    expect(comment.extractSlackRefsFromDescription).not.toHaveBeenCalled();
    expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
  });

  it("sends approval message for review kind with empty commentUrl", async () => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(false);
    (slack.postSlackThreadReply as jest.Mock).mockResolvedValue(undefined);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "",
      assignees: [],
      kind: "review",
      inputs: baseInputs,
      teamsConfig: configWithUsers,
    });

    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("your PR was approved by *bob*")
    );
  });
  it("notifies assignees on comments", async () => {
    const configWithMultipleUsers: OrgConfig = {
      ...teamsConfig,
      notifications: { dm: { enabled: false } },
      users: { alice: "U_ALICE", charlie: "U_CHARLIE" },
    };

    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(false);
    (slack.postSlackThreadReply as jest.Mock).mockResolvedValue(undefined);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: ["charlie"],
      kind: "comment",
      inputs: baseInputs,
      teamsConfig: configWithMultipleUsers,
    });

    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(2);
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("<@U_ALICE>")
    );
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("<@U_CHARLIE>")
    );
  });

  it("skips assignee who is the commenter", async () => {
    const configWithMultipleUsers: OrgConfig = {
      ...teamsConfig,
      notifications: { dm: { enabled: false } },
      users: { alice: "U_ALICE", bob: "U_BOB" },
    };

    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(false);
    (slack.postSlackThreadReply as jest.Mock).mockResolvedValue(undefined);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: ["bob"],
      kind: "comment",
      inputs: baseInputs,
      teamsConfig: configWithMultipleUsers,
    });

    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(1);
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("<@U_ALICE>")
    );
  });

  it("skips assignees on approval (review kind)", async () => {
    const configWithMultipleUsers: OrgConfig = {
      ...teamsConfig,
      notifications: { dm: { enabled: false } },
      users: { alice: "U_ALICE", charlie: "U_CHARLIE" },
    };

    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(false);
    (slack.postSlackThreadReply as jest.Mock).mockResolvedValue(undefined);

    await handleComment(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody:
        "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->",
      prUrl: "https://github.com/org/repo/pull/1",
      author: "alice",
      commenter: "bob",
      commentUrl: "",
      assignees: ["charlie"],
      kind: "review",
      inputs: baseInputs,
      teamsConfig: configWithMultipleUsers,
    });

    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(1);
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("your PR was approved by *bob*")
    );
  });
});

describe("handleComment DMs", () => {
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

  const slackBody =
    "body\n<!-- rr:slack:start -->\n<!-- rr:slack:C111:1111.0000 -->\n<!-- rr:slack:end -->";

  const approval = {
    owner: "org",
    repo: "repo",
    prNumber: 1,
    prBody: slackBody,
    prUrl: "https://github.com/org/repo/pull/1",
    author: "alice",
    commenter: "bob",
    commentUrl: "",
    assignees: [] as string[],
    kind: "review" as const,
    inputs,
  };

  const config: OrgConfig = { ...teamsConfig, users: { alice: "U12345" } };

  beforeEach(() => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([
      { channel: "C111", ts: "1111.0000" },
    ]);
    (slack.isSlackMessageMuted as jest.Mock).mockResolvedValue(false);
    (slack.postSlackThreadReply as jest.Mock).mockResolvedValue(undefined);
  });

  it("sends a DM to the author and no thread reply", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);

    await handleComment(mockOctokit as any, { ...approval, teamsConfig: config });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U12345",
      expect.stringContaining("approved by *bob*")
    );
    expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
    expect(slack.isSlackMessageMuted).not.toHaveBeenCalled();
  });

  it("sends a DM when the PR has no Slack refs", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);

    await handleComment(mockOctokit as any, { ...approval, prBody: "body", teamsConfig: config });

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    expect(comment.extractSlackRefsFromDescription).not.toHaveBeenCalled();
  });

  it("falls back to a thread reply when the DM fails", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(false);

    await handleComment(mockOctokit as any, { ...approval, teamsConfig: config });

    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(1);
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("<@U12345>, your PR was approved by *bob*")
    );
  });

  it("skips the DM when DMs are disabled and uses the thread reply", async () => {
    const disabled: OrgConfig = {
      ...config,
      notifications: { dm: { enabled: false } },
    };

    await handleComment(mockOctokit as any, { ...approval, teamsConfig: disabled });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(1);
  });

  it("continues with the next recipient when one DM fails", async () => {
    (slack.sendSlackDm as jest.Mock).mockImplementation(
      async (_client: unknown, slackId: string) => slackId !== "U_ALICE"
    );
    const twoUsers: OrgConfig = {
      ...teamsConfig,
      users: { alice: "U_ALICE", charlie: "U_CHARLIE" },
    };

    await handleComment(mockOctokit as any, {
      ...approval,
      kind: "comment",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: ["charlie"],
      teamsConfig: twoUsers,
    });

    expect(slack.sendSlackDm).toHaveBeenCalledTimes(2);
    expect(slack.postSlackThreadReply).toHaveBeenCalledTimes(1);
    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      expect.stringContaining("<@U_ALICE>")
    );
  });

  it("does nothing without a Slack token", async () => {
    await handleComment(mockOctokit as any, {
      ...approval,
      inputs: { ...inputs, slackToken: "" },
      teamsConfig: config,
    });

    expect(slack.sendSlackDm).not.toHaveBeenCalled();
    expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
  });
});

describe("review check wiring", () => {
  const inputs = {
    githubToken: "token",
    slackToken: "",
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

  const reviewCtx = {
    owner: "datarobot-oss",
    repo: "test-repo",
    prNumber: 1,
    prBody: "",
    prUrl: "https://github.com/datarobot-oss/test-repo/pull/1",
    author: "alice",
    reviewer: "bob",
    inputs,
    teamsConfig,
    capabilities: { hasOrgAccess: true },
  };

  const closedCtx = {
    owner: "org",
    repo: "repo",
    prNumber: 1,
    prBody: "",
    inputs,
    teamsConfig,
  };

  it("handleLabeled upserts the check with the routed team slugs", async () => {
    mockOctokit.paginate.mockResolvedValue([
      { filename: "src/app.py" },
      { filename: "infra/main.tf" },
    ]);
    jest
      .spyOn(codeowners, "fetchCodeownersContent")
      .mockResolvedValue(
        "* @datarobot-community/customer-engineering\ninfra/ @datarobot-community/platform-team\n"
      );
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);

    await handleLabeled(mockOctokit as any, {
      owner: "datarobot-community",
      repo: "test-repo",
      prNumber: 1,
      baseBranch: "main",
      prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
      prTitle: "Test PR",
      author: "alice",
      additions: 10,
      deletions: 5,
      commits: 1,
      labels: [],
      inputs,
      capabilities: { hasOrgAccess: false },
      teamsConfig,
      headSha: "sha123",
    });

    expect(checks.upsertReviewCheck).toHaveBeenCalledTimes(1);
    const args = (checks.upsertReviewCheck as jest.Mock).mock.calls[0];
    expect(args.slice(1, 5)).toEqual(["datarobot-community", "test-repo", 1, "sha123"]);
    expect([...args[5]].sort()).toEqual(["customer-engineering", "platform-team"]);
  });

  const labeledCtx = {
    owner: "datarobot-community",
    repo: "test-repo",
    prNumber: 1,
    baseBranch: "main",
    prUrl: "https://github.com/datarobot-community/test-repo/pull/1",
    prTitle: "Test PR",
    author: "alice",
    additions: 10,
    deletions: 5,
    commits: 1,
    inputs,
    capabilities: { hasOrgAccess: false },
    teamsConfig,
    headSha: "sha123",
  };

  function routeWith(codeownersContent: string) {
    mockOctokit.paginate.mockResolvedValue([{ filename: "src/app.py" }]);
    jest.spyOn(codeowners, "fetchCodeownersContent").mockResolvedValue(codeownersContent);
    (labels.ensureLabel as jest.Mock).mockResolvedValue(undefined);
    (labels.applyLabels as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
    (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
  }

  it("handleLabeled counts Needs Review labels already on the PR as pending", async () => {
    routeWith("* @datarobot-community/customer-engineering\n");

    await handleLabeled(mockOctokit as any, {
      ...labeledCtx,
      labels: ["Needs Review: Platform", "bug"],
    });

    const pending = (checks.upsertReviewCheck as jest.Mock).mock.calls[0][5] as string[];
    expect([...pending].sort()).toEqual(["customer-engineering", "platform-team"]);
  });

  it("handleLabeled skips the check when no team is pending", async () => {
    routeWith("docs/ @datarobot-community/customer-engineering\n");

    await handleLabeled(mockOctokit as any, { ...labeledCtx, labels: ["bug"] });

    expect(checks.upsertReviewCheck).not.toHaveBeenCalled();
  });

  it("handleReviewSubmitted upserts the check with the remaining pending teams", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }, { name: "Needs Review: Platform" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockImplementation(
      async ({ team_slug }: { team_slug: string }) => {
        if (team_slug === "customer-engineering") return {};
        throw { status: 404 };
      }
    );
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);

    await handleReviewSubmitted(mockOctokit as any, { ...reviewCtx, headSha: "sha123" });

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      ["platform-team"]
    );
  });

  it("handleReviewSubmitted upserts an empty pending list when the last label is removed", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockResolvedValue({});
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);

    await handleReviewSubmitted(mockOctokit as any, { ...reviewCtx, headSha: "sha123" });

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      []
    );
  });

  it("handleClosed upserts a closed check for merged and unmerged PRs", async () => {
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([]);
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({ data: [] });

    await handleClosed(mockOctokit as any, { ...closedCtx, merged: false, headSha: "sha123" });
    await handleClosed(mockOctokit as any, { ...closedCtx, merged: true, headSha: "sha123" });

    expect(checks.upsertReviewCheck).toHaveBeenCalledTimes(2);
    expect(checks.upsertReviewCheck).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "org",
      "repo",
      1,
      "sha123",
      [],
      true
    );
    expect(checks.upsertReviewCheck).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "org",
      "repo",
      1,
      "sha123",
      [],
      true
    );
  });

  const syncCtx = {
    owner: "datarobot-oss",
    repo: "test-repo",
    prNumber: 1,
    headSha: "sha123",
    inputs,
    teamsConfig,
  };

  it("syncReviewCheck upserts the check on the head with the teams still pending", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Platform" }, { name: "bug" }],
    });

    await syncReviewCheck(mockOctokit as any, syncCtx);

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      ["platform-team"]
    );
  });

  it("syncReviewCheck passes no pending teams when no Needs Review label remains", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({ data: [{ name: "bug" }] });

    await syncReviewCheck(mockOctokit as any, syncCtx);

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      []
    );
  });

  it("handleReviewSubmitted settles the check when no Needs Review label is left", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({ data: [{ name: "bug" }] });

    await handleReviewSubmitted(mockOctokit as any, { ...reviewCtx, headSha: "sha123" });

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      []
    );
  });

  it("handlers skip the check when headSha is undefined", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockResolvedValue({});
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([]);

    await handleReviewSubmitted(mockOctokit as any, reviewCtx);
    await handleClosed(mockOctokit as any, { ...closedCtx, merged: false });

    expect(checks.upsertReviewCheck).not.toHaveBeenCalled();
  });
});

describe("getFileTypeEmojis", () => {
  const config = {
    enabled: true,
    file_types: {
      py: "python",
      ts: "typescript",
      tsx: "typescript",
      yml: "yaml",
      dockerfile: "docker",
      "github-actions": "github-actions",
    },
  };

  it("returns empty when reactions disabled", () => {
    expect(getFileTypeEmojis(["src/app.py"])).toEqual([]);
    expect(getFileTypeEmojis(["src/app.py"], { enabled: false })).toEqual([]);
  });

  it("returns empty when file_types not configured", () => {
    expect(getFileTypeEmojis(["src/app.py"], { enabled: true })).toEqual([]);
  });

  it("maps Python files", () => {
    expect(getFileTypeEmojis(["src/app.py"], config)).toContain("python");
  });

  it("maps TypeScript files", () => {
    expect(getFileTypeEmojis(["src/index.ts", "src/types.tsx"], config)).toEqual(["typescript"]);
  });

  it("maps GitHub Actions workflows", () => {
    expect(getFileTypeEmojis([".github/workflows/ci.yml"], config)).toContain("github-actions");
  });

  it("maps Dockerfile", () => {
    expect(getFileTypeEmojis(["Dockerfile"], config)).toContain("docker");
  });

  it("deduplicates emojis", () => {
    const emojis = getFileTypeEmojis(["a.py", "b.py", "c.ts"], config);
    expect(emojis).toEqual(["python", "typescript"]);
  });

  it("returns empty for unknown extensions", () => {
    expect(getFileTypeEmojis(["file.xyz", "data.bin"], config)).toEqual([]);
  });
});
