import { handleLabeled, handleReviewSubmitted, resolveTeamSlugFromLabel } from "../src/router";
import * as codeowners from "../src/codeowners";
import * as labels from "../src/labels";
import * as comment from "../src/comment";
import * as slack from "../src/slack";
import { OrgConfig } from "../src/types";

jest.mock("../src/labels");
jest.mock("../src/comment");
jest.mock("../src/slack");

const mockOctokit = {
  rest: {
    pulls: {
      listFiles: jest.fn(),
      requestReviewers: jest.fn(),
    },
    repos: {
      getContent: jest.fn(),
    },
    orgs: {
      checkMembershipForUser: jest.fn(),
    },
    teams: {
      getMembershipForUserInOrg: jest.fn(),
    },
    issues: {
      listLabelsOnIssue: jest.fn(),
      removeLabel: jest.fn(),
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

beforeEach(() => jest.clearAllMocks());

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
    (labels.applyLabel as jest.Mock).mockResolvedValue(undefined);
    (comment.upsertComment as jest.Mock).mockResolvedValue(undefined);
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
        readyLabel: "Ready for Review",
        needsReviewPrefix: "Needs Review",
        needsReviewLabelColor: "fbca04",
      },
      capabilities: { hasOrgAccess: false },
      teamsConfig,
    });

    expect(labels.ensureLabel).toHaveBeenCalled();
    expect(labels.applyLabel).toHaveBeenCalled();
    expect(comment.upsertComment).toHaveBeenCalled();
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
        readyLabel: "Ready for Review",
        needsReviewPrefix: "Needs Review",
        needsReviewLabelColor: "fbca04",
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

describe("handleReviewSubmitted", () => {
  const baseCtx = {
    owner: "datarobot-oss",
    repo: "test-repo",
    prNumber: 1,
    reviewer: "bob",
    inputs: {
      githubToken: "token",
      slackToken: "",
      readyLabel: "Ready for Review",
      needsReviewPrefix: "Needs Review",
      needsReviewLabelColor: "fbca04",
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
    expect(resolveTeamSlugFromLabel(
      "Needs Review: Customer Engineering", teamsConfig, "Needs Review"
    )).toBe("customer-engineering");
  });

  it("derives slug from label suffix when not in config", () => {
    expect(resolveTeamSlugFromLabel(
      "Needs Review: Some New Team", teamsConfig, "Needs Review"
    )).toBe("some-new-team");
  });

  it("returns undefined for empty suffix", () => {
    expect(resolveTeamSlugFromLabel(
      "Needs Review: ", teamsConfig, "Needs Review"
    )).toBeUndefined();
  });
});
