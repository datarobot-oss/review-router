import {
  handleLabeled,
  handleReviewSubmitted,
  handleOpened,
  handleDependabotPush,
  handleReadyForReview,
  handleClosed,
  syncReviewCheck,
  handleComment,
  handleReviewRequested,
  formatGitHubUser,
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

  describe("the reminder marker of the ownership comment", () => {
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
      (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
      (comment.mergeSlackRefs as jest.Mock).mockReturnValue([]);
      (comment.extractSlackRefs as jest.Mock).mockReturnValue([]);
      (comment.buildOwnershipComment as jest.Mock).mockReturnValue("BODY");
      (comment.embedSlackRefs as jest.Mock).mockImplementation((body: string) => body);
      (comment.embedReminderMarker as jest.Mock).mockImplementation(
        (body: string, readyAt: string, number: number) => `${body}|${readyAt}|${number}`
      );
    });

    it("keeps the stored marker when the router rewrites the comment", async () => {
      const readyAt = "2026-11-05T10:00:00.000Z";
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 7, body: "old" });
      (comment.extractReminderMarker as jest.Mock).mockReturnValue({ readyAt, number: 2 });
      await handleLabeled(mockOctokit as any, ctx);
      expect(comment.upsertComment).toHaveBeenCalledWith(
        expect.anything(),
        "datarobot-community",
        "test-repo",
        1,
        `BODY|${readyAt}|2`,
        { id: 7, body: "old" }
      );
    });

    it("adds no marker to a comment that never had one", async () => {
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 7, body: "old" });
      (comment.extractReminderMarker as jest.Mock).mockReturnValue(null);
      await handleLabeled(mockOctokit as any, ctx);
      expect(comment.embedReminderMarker).not.toHaveBeenCalled();
    });

    it("keeps the DM cursor when the router rewrites the comment", async () => {
      const cursor = "2026-11-05T10:00:00.000Z";
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 7, body: "old" });
      (comment.extractReminderMarker as jest.Mock).mockReturnValue(null);
      (comment.extractDmCursor as jest.Mock).mockReturnValue(cursor);
      (comment.embedDmCursor as jest.Mock).mockImplementation(
        (body: string, iso: string) => `${body}|cursor|${iso}`
      );
      await handleLabeled(mockOctokit as any, ctx);
      expect(comment.upsertComment).toHaveBeenCalledWith(
        expect.anything(),
        "datarobot-community",
        "test-repo",
        1,
        `BODY|cursor|${cursor}`,
        { id: 7, body: "old" }
      );
    });

    it("adds no cursor to a comment that never had one", async () => {
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 7, body: "old" });
      (comment.extractReminderMarker as jest.Mock).mockReturnValue(null);
      (comment.extractDmCursor as jest.Mock).mockReturnValue(null);
      await handleLabeled(mockOctokit as any, ctx);
      expect(comment.embedDmCursor).not.toHaveBeenCalled();
    });

    it("adds no cursor when the PR has no ownership comment yet", async () => {
      (comment.findExistingComment as jest.Mock).mockResolvedValue(null);
      await handleLabeled(mockOctokit as any, ctx);
      expect(comment.extractDmCursor).not.toHaveBeenCalled();
      expect(comment.embedDmCursor).not.toHaveBeenCalled();
    });
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
    (comment.findExistingComment as jest.Mock).mockResolvedValue(null);

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
      expect.stringContaining("CODEOWNERS"),
      null
    );
  });

  describe("when CODEOWNERS is missing and the PR has an ownership comment", () => {
    const warningCtx = {
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
        configPath: "config.yml",
        configToken: "",
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
      jest.spyOn(codeowners, "fetchCodeownersContent").mockResolvedValue(null);
      (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
      (comment.embedReminderMarker as jest.Mock).mockImplementation(
        (body: string, readyAt: string, number: number) => `${body}|reminder|${readyAt}|${number}`
      );
      (comment.embedDmCursor as jest.Mock).mockImplementation(
        (body: string, iso: string) => `${body}|cursor|${iso}`
      );
    });

    it("keeps the DM cursor and the reminder marker in the warning", async () => {
      const readyAt = "2026-11-05T10:00:00.000Z";
      const cursor = "2026-11-05T11:00:00.000Z";
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 7, body: "old" });
      (comment.extractReminderMarker as jest.Mock).mockReturnValue({ readyAt, number: 2 });
      (comment.extractDmCursor as jest.Mock).mockReturnValue(cursor);

      await handleLabeled(mockOctokit as any, warningCtx);

      const [, , , , body, existing] = (comment.upsertComment as jest.Mock).mock.calls[0];
      expect(body).toContain("CODEOWNERS");
      expect(body).toContain(`|reminder|${readyAt}|2`);
      expect(body).toContain(`|cursor|${cursor}`);
      expect(existing).toEqual({ id: 7, body: "old" });
    });

    it("adds no markers to a warning for a PR that had none", async () => {
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 7, body: "old" });
      (comment.extractReminderMarker as jest.Mock).mockReturnValue(null);
      (comment.extractDmCursor as jest.Mock).mockReturnValue(null);

      await handleLabeled(mockOctokit as any, warningCtx);

      expect(comment.embedReminderMarker).not.toHaveBeenCalled();
      expect(comment.embedDmCursor).not.toHaveBeenCalled();
    });

    it("creates the warning when the PR has no ownership comment yet", async () => {
      (comment.findExistingComment as jest.Mock).mockResolvedValue(null);

      await handleLabeled(mockOctokit as any, warningCtx);

      const [, , , , body, existing] = (comment.upsertComment as jest.Mock).mock.calls[0];
      expect(body).toContain("CODEOWNERS");
      expect(existing).toBeNull();
      expect(comment.embedReminderMarker).not.toHaveBeenCalled();
      expect(comment.embedDmCursor).not.toHaveBeenCalled();
    });
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
      prTitle: "Add retry",
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
      ":speech_balloon: <@U12345>, <https://github.com/bob|bob> commented on your pull request. " +
        "<https://github.com/org/repo/pull/1#issuecomment-1|Read the comment>."
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
      prTitle: "Add retry",
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
      prTitle: "Add retry",
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
      prTitle: "Add retry",
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
      prTitle: "Add retry",
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
      expect.stringContaining("<https://github.com/bob|bob> approved your pull request.")
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
      prTitle: "Add retry",
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
      prTitle: "Add retry",
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
      prTitle: "Add retry",
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
      expect.stringContaining("<https://github.com/bob|bob> approved your pull request.")
    );
  });
});

describe("formatGitHubUser", () => {
  it("mentions a login that has a Slack user", () => {
    expect(formatGitHubUser("bob", { bob: "U_BOB" })).toBe("<@U_BOB>");
  });

  it("links the GitHub profile of a login without a Slack user", () => {
    expect(formatGitHubUser("bob", { alice: "U12345" })).toBe("<https://github.com/bob|bob>");
  });

  it("links the GitHub profile when there is no users mapping", () => {
    expect(formatGitHubUser("bob", undefined)).toBe("<https://github.com/bob|bob>");
  });

  it("links the app page of a bot login", () => {
    expect(formatGitHubUser("cursor[bot]", {})).toBe(
      "<https://github.com/apps/cursor|cursor[bot]>"
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
    prTitle: "Add retry",
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
      expect.objectContaining({
        headline: ":white_check_mark: *Approved* by <https://github.com/bob|bob>",
      })
    );
    expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
    expect(slack.isSlackMessageMuted).not.toHaveBeenCalled();
  });

  it("mentions the commenter when the commenter has a Slack user", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);
    const mapped: OrgConfig = { ...teamsConfig, users: { alice: "U12345", bob: "U_BOB" } };

    await handleComment(mockOctokit as any, { ...approval, teamsConfig: mapped });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U12345",
      expect.objectContaining({ headline: ":white_check_mark: *Approved* by <@U_BOB>" })
    );
  });

  it.each(["comment", "review", "review_comment"] as const)(
    "sends the same comment DM to the author for a %s",
    async (kind) => {
      (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);

      await handleComment(mockOctokit as any, {
        ...approval,
        kind,
        commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
        teamsConfig: config,
      });

      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U12345",
        expect.objectContaining({
          headline: ":speech_balloon: *Comment* from <https://github.com/bob|bob>",
          commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
        })
      );
    }
  );

  it("has no comment link when there is no comment URL", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);

    await handleComment(mockOctokit as any, {
      ...approval,
      kind: "comment",
      commentUrl: "",
      teamsConfig: config,
    });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U12345",
      expect.objectContaining({
        headline: ":speech_balloon: *Comment* from <https://github.com/bob|bob>",
        commentUrl: undefined,
      })
    );
  });

  it("tells an assignee the pull request is assigned to them", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);
    const withAssignee: OrgConfig = { ...teamsConfig, users: { charlie: "U_CHARLIE" } };

    await handleComment(mockOctokit as any, {
      ...approval,
      kind: "comment",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: ["charlie"],
      teamsConfig: withAssignee,
    });

    expect(slack.sendSlackDm).toHaveBeenCalledWith(
      expect.anything(),
      "U_CHARLIE",
      expect.objectContaining({
        headline:
          ":eyes: *Comment* from <https://github.com/bob|bob> on a pull request assigned to you",
        commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      })
    );
  });

  it("falls back to a thread reply for an assignee when the DM fails", async () => {
    (slack.sendSlackDm as jest.Mock).mockResolvedValue(false);
    const withAssignee: OrgConfig = { ...teamsConfig, users: { charlie: "U_CHARLIE" } };

    await handleComment(mockOctokit as any, {
      ...approval,
      kind: "comment",
      commentUrl: "https://github.com/org/repo/pull/1#issuecomment-1",
      assignees: ["charlie"],
      teamsConfig: withAssignee,
    });

    expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
      expect.anything(),
      "C111",
      "1111.0000",
      ":eyes: <@U_CHARLIE>, <https://github.com/bob|bob> commented on your assigned pull request. " +
        "<https://github.com/org/repo/pull/1#issuecomment-1|Read the comment>."
    );
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
      ":white_check_mark: <@U12345>, <https://github.com/bob|bob> approved your pull request."
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

  describe("handleReviewRequested", () => {
    const withReviewer: OrgConfig = { ...teamsConfig, users: { carol: "U_CAROL" } };
    const request = {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      prBody: slackBody,
      prUrl: "https://github.com/org/repo/pull/1",
      prTitle: "Add retry",
      requester: "bob",
      reviewer: "carol",
      inputs,
      teamsConfig: withReviewer,
    };

    beforeEach(() => {
      (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);
    });

    it("sends the requested reviewer a DM", async () => {
      await handleReviewRequested(mockOctokit as any, request);

      expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_CAROL",
        expect.objectContaining({
          headline: ":eyes: *Review requested* by <https://github.com/bob|bob>",
        })
      );
    });

    it("matches the reviewer's login to the Slack user whatever its case", async () => {
      await handleReviewRequested(mockOctokit as any, { ...request, reviewer: "Carol" });

      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_CAROL",
        expect.objectContaining({ headline: expect.stringContaining("*Review requested*") })
      );
    });

    it("sends nothing to a reviewer without a Slack user", async () => {
      await handleReviewRequested(mockOctokit as any, { ...request, reviewer: "dave" });

      expect(slack.sendSlackDm).not.toHaveBeenCalled();
      expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
    });

    it("sends nothing when people request their own review", async () => {
      await handleReviewRequested(mockOctokit as any, { ...request, requester: "carol" });

      expect(slack.sendSlackDm).not.toHaveBeenCalled();
    });

    it("falls back to a thread reply when the DM fails", async () => {
      (slack.sendSlackDm as jest.Mock).mockResolvedValue(false);

      await handleReviewRequested(mockOctokit as any, request);

      expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
        expect.anything(),
        "C111",
        "1111.0000",
        ":eyes: <@U_CAROL>, <https://github.com/bob|bob> requested your review."
      );
    });

    it("does nothing without a Slack token", async () => {
      await handleReviewRequested(mockOctokit as any, {
        ...request,
        inputs: { ...inputs, slackToken: "" },
      });

      expect(slack.sendSlackDm).not.toHaveBeenCalled();
      expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
    });
  });

  describe("mentions", () => {
    const commentUrl = "https://github.com/org/repo/pull/1#issuecomment-1";
    const withUsers: OrgConfig = {
      ...teamsConfig,
      users: { alice: "U_ALICE", charlie: "U_CHARLIE" },
    };
    const mentioning = {
      ...approval,
      kind: "comment" as const,
      commentUrl,
      body: "@charlie what do you think?",
      teamsConfig: withUsers,
    };

    beforeEach(() => {
      (slack.sendSlackDm as jest.Mock).mockResolvedValue(true);
    });

    it("sends a mentioned person a DM next to the author's", async () => {
      await handleComment(mockOctokit as any, mentioning);

      expect(slack.sendSlackDm).toHaveBeenCalledTimes(2);
      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_CHARLIE",
        expect.objectContaining({
          headline: ":bell: *Mention* from <https://github.com/bob|bob>",
          commentUrl,
        })
      );
    });

    it("matches the mentioned login to the Slack user whatever its case", async () => {
      await handleComment(mockOctokit as any, { ...mentioning, body: "@Charlie ping" });

      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_CHARLIE",
        expect.objectContaining({ headline: expect.stringContaining("*Mention*") })
      );
    });

    it("sends the author one DM when the comment mentions the author", async () => {
      await handleComment(mockOctokit as any, { ...mentioning, body: "@alice please look" });

      expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_ALICE",
        expect.objectContaining({ headline: expect.stringContaining("*Comment* from") })
      );
    });

    it("sends an assignee one DM when the comment mentions the assignee", async () => {
      await handleComment(mockOctokit as any, { ...mentioning, assignees: ["charlie"] });

      const toCharlie = (slack.sendSlackDm as jest.Mock).mock.calls.filter(
        ([, id]) => id === "U_CHARLIE"
      );
      expect(toCharlie).toHaveLength(1);
      expect(toCharlie[0][2].headline).toContain("assigned to you");
    });

    it("sends the author and the mentioned person a DM for a requested-changes summary, and nobody else", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        kind: "changes_requested",
        assignees: ["dave"],
        body: "Needs a test, @charlie can you help?",
      });

      const ids = (slack.sendSlackDm as jest.Mock).mock.calls.map(([, id]) => id);
      expect(ids).toEqual(["U_ALICE", "U_CHARLIE"]);
    });

    it("sends only the mentioned person a DM when the context says mentions only", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        assignees: ["charlie"],
        mentionsOnly: true,
      });

      const ids = (slack.sendSlackDm as jest.Mock).mock.calls.map(([, id]) => id);
      expect(ids).toEqual(["U_CHARLIE"]);
    });

    it("sends the author the verdict for a requested-changes summary that mentions nobody", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        kind: "changes_requested",
        body: "Needs a test",
      });

      expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_ALICE",
        expect.objectContaining({
          headline: ":no_entry: *Changes requested* by <https://github.com/bob|bob>",
          commentUrl,
          commentLabel: "Read the review",
        })
      );
    });

    it("sends the author the verdict for a requested-changes review with no summary text", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        kind: "changes_requested",
        body: "",
      });

      const ids = (slack.sendSlackDm as jest.Mock).mock.calls.map(([, id]) => id);
      expect(ids).toEqual(["U_ALICE"]);
    });

    it("uses the configured icon for the verdict", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        kind: "changes_requested",
        body: "Needs a test",
        teamsConfig: {
          ...withUsers,
          reactions: { enabled: true, icons: { changes_requested: "git_requested_changes" } },
        },
      });

      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_ALICE",
        expect.objectContaining({
          headline: ":git_requested_changes: *Changes requested* by <https://github.com/bob|bob>",
        })
      );
    });

    it("sends no second verdict, only the mentions, for a later review of the same burst", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        kind: "changes_requested",
        mentionsOnly: true,
        body: "Still needs a test, @charlie can you help?",
      });

      const ids = (slack.sendSlackDm as jest.Mock).mock.calls.map(([, id]) => id);
      expect(ids).toEqual(["U_CHARLIE"]);
    });

    it("sends no verdict when the author requests changes on their own pull request", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        commenter: "alice",
        kind: "changes_requested",
        body: "Needs a test",
      });

      expect(slack.sendSlackDm).not.toHaveBeenCalled();
    });

    it("sends nothing to a mentioned person without a Slack user", async () => {
      await handleComment(mockOctokit as any, { ...mentioning, body: "@dave look" });

      expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_ALICE",
        expect.any(Object)
      );
    });

    it("sends nothing to the commenter who mentions themselves", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        body: "note to self @bob",
        teamsConfig: { ...withUsers, users: { ...withUsers.users, bob: "U_BOB" } },
      });

      const ids = (slack.sendSlackDm as jest.Mock).mock.calls.map(([, id]) => id);
      expect(ids).toEqual(["U_ALICE"]);
    });

    it("sends one DM to a person mentioned twice", async () => {
      await handleComment(mockOctokit as any, {
        ...mentioning,
        body: "@charlie and again @charlie",
      });

      const toCharlie = (slack.sendSlackDm as jest.Mock).mock.calls.filter(
        ([, id]) => id === "U_CHARLIE"
      );
      expect(toCharlie).toHaveLength(1);
    });

    it("sends nothing for a mention in a code block", async () => {
      await handleComment(mockOctokit as any, { ...mentioning, body: "```\n@charlie\n```" });

      const ids = (slack.sendSlackDm as jest.Mock).mock.calls.map(([, id]) => id);
      expect(ids).toEqual(["U_ALICE"]);
    });

    it("falls back to a thread reply for a mentioned person when the DM fails", async () => {
      (slack.sendSlackDm as jest.Mock).mockImplementation(
        async (_client: unknown, id: string) => id !== "U_CHARLIE"
      );

      await handleComment(mockOctokit as any, mentioning);

      expect(slack.postSlackThreadReply).toHaveBeenCalledWith(
        expect.anything(),
        "C111",
        "1111.0000",
        `:bell: <@U_CHARLIE>, <https://github.com/bob|bob> mentioned you. <${commentUrl}|Read the comment>.`
      );
    });

    it("sends a person mentioned in an approval's summary a DM without a comment link", async () => {
      await handleComment(mockOctokit as any, {
        ...approval,
        body: "LGTM, @charlie FYI",
        teamsConfig: withUsers,
      });

      expect(slack.sendSlackDm).toHaveBeenCalledWith(
        expect.anything(),
        "U_CHARLIE",
        expect.objectContaining({ headline: ":bell: *Mention* from <https://github.com/bob|bob>" })
      );
    });

    it("sends nothing for an approval, which has no body", async () => {
      await handleComment(mockOctokit as any, { ...approval, teamsConfig: withUsers });

      expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
    });

    describe("when the author is the commenter", () => {
      const own = { ...mentioning, commenter: "alice", assignees: ["charlie"] };

      it("sends the mentioned person a DM and nobody else", async () => {
        await handleComment(mockOctokit as any, own);

        expect(slack.sendSlackDm).toHaveBeenCalledTimes(1);
        expect(slack.sendSlackDm).toHaveBeenCalledWith(
          expect.anything(),
          "U_CHARLIE",
          expect.objectContaining({
            headline: expect.stringContaining("*Mention* from <@U_ALICE>"),
          })
        );
      });

      it("sends nothing when the comment mentions nobody", async () => {
        await handleComment(mockOctokit as any, { ...own, body: "pushed a fix" });

        expect(slack.sendSlackDm).not.toHaveBeenCalled();
        expect(slack.postSlackThreadReply).not.toHaveBeenCalled();
      });
    });
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

  // The check is on for the repos that subscribe to the AI review.
  const subscribed: OrgConfig = {
    ...teamsConfig,
    ai_review: {
      enabled: true,
      repos: ["test-repo", "repo"],
      endpoint: "https://x/api/v2",
      models: { reviewer: "rev", scorer: "sco" },
    },
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
    teamsConfig: subscribed,
    capabilities: { hasOrgAccess: true },
  };

  const closedCtx = {
    owner: "org",
    repo: "repo",
    prNumber: 1,
    prBody: "",
    inputs,
    teamsConfig: subscribed,
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
      teamsConfig: subscribed,
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
    teamsConfig: subscribed,
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
      ["platform-team"],
      false,
      true
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
      [],
      false,
      true
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
      true,
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
      true,
      true
    );
  });

  const syncCtx = {
    owner: "datarobot-oss",
    repo: "test-repo",
    prNumber: 1,
    headSha: "sha123",
    inputs,
    teamsConfig: subscribed,
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
      ["platform-team"],
      false,
      true
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
      [],
      false,
      true
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
      [],
      false,
      true
    );
  });

  it("handlers never create a check in a repo without an ai_review block", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({
      data: [{ name: "Needs Review: Customer Engineering" }],
    });
    mockOctokit.rest.teams.getMembershipForUserInOrg.mockResolvedValue({});
    (labels.removeLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.extractSlackRefsFromDescription as jest.Mock).mockReturnValue([]);
    routeWith("* @datarobot-community/customer-engineering\n");

    await handleLabeled(mockOctokit as any, { ...labeledCtx, teamsConfig, labels: [] });
    await handleReviewSubmitted(mockOctokit as any, {
      ...reviewCtx,
      teamsConfig,
      headSha: "sha123",
    });
    await handleClosed(mockOctokit as any, {
      ...closedCtx,
      teamsConfig,
      merged: true,
      headSha: "s",
    });
    await syncReviewCheck(mockOctokit as any, { ...syncCtx, teamsConfig });

    // The handlers still report, so a check that already exists settles. None may create one.
    const calls = (checks.upsertReviewCheck as jest.Mock).mock.calls;
    expect(calls).toHaveLength(4);
    calls.forEach((call) => expect(call[7]).toBe(false));
  });

  const offConfig: OrgConfig = {
    ...subscribed,
    ai_review: {
      ...(subscribed.ai_review as NonNullable<OrgConfig["ai_review"]>),
      enabled: false,
    },
  };
  const otherRepoConfig: OrgConfig = {
    ...subscribed,
    ai_review: {
      ...(subscribed.ai_review as NonNullable<OrgConfig["ai_review"]>),
      repos: ["another-repo"],
    },
  };

  it.each([
    ["the AI review is off", offConfig],
    ["the repo is outside ai_review.repos", otherRepoConfig],
  ])("syncReviewCheck settles but never creates a check when %s", async (_name, config) => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({ data: [{ name: "bug" }] });

    await syncReviewCheck(mockOctokit as any, { ...syncCtx, teamsConfig: config });

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      [],
      false,
      false
    );
  });

  it("handleReviewSubmitted settles but never creates a check without an ai_review block when no label is left", async () => {
    mockOctokit.rest.issues.listLabelsOnIssue.mockResolvedValue({ data: [{ name: "bug" }] });

    await handleReviewSubmitted(mockOctokit as any, {
      ...reviewCtx,
      teamsConfig,
      headSha: "sha123",
    });

    expect(checks.upsertReviewCheck).toHaveBeenCalledWith(
      expect.anything(),
      "datarobot-oss",
      "test-repo",
      1,
      "sha123",
      [],
      false,
      false
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

describe("routing a Dependabot pull request by the gate's decision", () => {
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
  const config: OrgConfig = { ...teamsConfig, dependabot: { auto_label: true } };
  const passes = {
    conclusion: "success",
    reason: "dependabot",
    title: "t",
    summary: "s",
  } as const;
  const waits = {
    conclusion: "action_required",
    reason: "needs-approval",
    title: "t",
    summary: "s",
    pending: true,
  } as const;
  const opened = (author: string, gateDecision?: typeof passes | typeof waits | null) =>
    handleOpened(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 42,
      prTitle: "Bump x",
      author,
      isFork: false,
      isDraft: false,
      gateDecision,
      inputs,
      teamsConfig: config,
    });
  const pushed = (over: object = {}) =>
    handleDependabotPush(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      prNumber: 42,
      author: "dependabot[bot]",
      labels: ["dependencies"],
      gateDecision: waits,
      inputs,
      teamsConfig: config,
      ...over,
    });
  const readyLabelAdded = {
    owner: "org",
    repo: "repo",
    issue_number: 42,
    labels: ["Ready for Review"],
  };

  beforeEach(() => mockOctokit.rest.issues.addLabels.mockResolvedValue({}));

  describe("when the pull request opens", () => {
    it("adds no label when the gate passes it", async () => {
      await opened("dependabot[bot]", passes);
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds the ready label when the gate waits for a person", async () => {
      await opened("dependabot[bot]", waits);
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(readyLabelAdded);
    });

    it("adds the ready label when the repository has no gate", async () => {
      await opened("dependabot[bot]", null);
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(readyLabelAdded);
    });

    it("adds the ready label when the gate was not consulted", async () => {
      await opened("dependabot[bot]");
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(readyLabelAdded);
    });

    it("leaves a pull request from a person to the existing rules", async () => {
      await opened("alice", passes);
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });

  describe("when a push changes the gate's decision", () => {
    it("adds the ready label once the gate waits for a person", async () => {
      await pushed();
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(readyLabelAdded);
    });

    it("adds nothing while the gate passes it", async () => {
      await pushed({ gateDecision: passes });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing when the gate decided nothing", async () => {
      await pushed({ gateDecision: null });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing when the pull request already carries the ready label", async () => {
      await pushed({ labels: ["dependencies", "Ready for Review"] });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("counts an alias of the ready label as already routed", async () => {
      const aliased = { ...config, ready_label_aliases: ["00 - Ready for Review"] };
      await pushed({ labels: ["00 - Ready for Review"], teamsConfig: aliased });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing for a pull request from a person", async () => {
      await pushed({ author: "alice" });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing when auto_label is off", async () => {
      await pushed({ teamsConfig: { ...config, dependabot: { auto_label: false } } });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("warns instead of throwing when the label can't be added", async () => {
      mockOctokit.rest.issues.addLabels.mockRejectedValue(new Error("403"));
      await expect(pushed()).resolves.toBeUndefined();
    });

    it("does not look for an ownership comment, so a stale approval is routed again", async () => {
      await pushed();
      expect(comment.findExistingComment).not.toHaveBeenCalled();
    });
  });

  describe("when the sweep finds that the gate no longer passes it", () => {
    const swept = (over: object = {}) => pushed({ unroutedOnly: true, ...over });

    beforeEach(() => (comment.findExistingComment as jest.Mock).mockResolvedValue(null));

    it("adds the ready label to a pull request that was never routed", async () => {
      await swept();
      expect(mockOctokit.rest.issues.addLabels).toHaveBeenCalledWith(readyLabelAdded);
    });

    it("adds nothing once an ownership comment shows it was routed, so a removed label stays removed", async () => {
      (comment.findExistingComment as jest.Mock).mockResolvedValue({ id: 1, body: "x" });
      await swept();
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing while a team's review label is on it", async () => {
      await swept({ labels: ["dependencies", "Needs Review: Platform"] });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing while the pull request carries the ready label", async () => {
      await swept({ labels: ["Ready for Review"] });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it("adds nothing while the gate passes it, and reads no comments", async () => {
      await swept({ gateDecision: passes });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(comment.findExistingComment).not.toHaveBeenCalled();
    });

    it("adds nothing for a pull request from a person", async () => {
      await swept({ author: "alice" });
      expect(mockOctokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });
});
