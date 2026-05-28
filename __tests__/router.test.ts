import { handleLabeled } from "../src/router";
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
    issues: {
      listLabelsOnIssue: jest.fn(),
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
