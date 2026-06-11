import { handleSchedule } from "../src/reminders";
import * as slack from "../src/slack";

jest.mock("../src/slack");

const mockOctokit = {
  rest: {
    issues: {
      listEvents: jest.fn(),
    },
  },
  paginate: jest.fn(),
};

const baseInputs = {
  githubToken: "token",
  slackToken: "xoxb-slack-token",
  configRepo: "",
  configToken: "",
  configS3: "",
  readyLabel: "Ready for Review",
  needsReviewPrefix: "Needs Review",
  needsReviewLabelColor: "fbca04",
};

const teamsConfig = {
  reminders: { enabled: true, stale_hours: 24 },
  teams: {
    frontend: {
      label: "Needs Review: Frontend",
      slack_channel: "C_FRONTEND",
    },
    backend: {
      label: "Needs Review: Backend",
      slack_channel: "C_BACKEND",
    },
  },
};

beforeEach(() => jest.clearAllMocks());

describe("handleSchedule", () => {
  it("skips when reminders are disabled", async () => {
    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig: { teams: teamsConfig.teams },
    });

    expect(mockOctokit.paginate).not.toHaveBeenCalled();
  });

  it("skips when reminders.enabled is false", async () => {
    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig: {
        reminders: { enabled: false },
        teams: teamsConfig.teams,
      },
    });

    expect(mockOctokit.paginate).not.toHaveBeenCalled();
  });

  it("sends no reminders when no open PRs have Needs Review labels", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 1,
        pull_request: {},
        labels: [{ name: "bug" }],
        html_url: "https://github.com/org/repo/pull/1",
        title: "Fix bug",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig,
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });

  it("skips PRs with fresh labels", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 1,
          pull_request: {},
          labels: [{ name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/1",
          title: "Fresh PR",
          created_at: oneHourAgo.toISOString(),
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Needs Review: Frontend" },
          created_at: oneHourAgo.toISOString(),
        },
      ]);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig,
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });

  it("sends reminder for stale PRs", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 10,
          pull_request: {},
          labels: [{ name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/10",
          title: "Stale PR",
          created_at: twoDaysAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Needs Review: Frontend" },
          created_at: twoDaysAgo,
        },
      ]);

    (slack.sendSlackReminder as jest.Mock).mockResolvedValue(undefined);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig,
    });

    expect(slack.sendSlackReminder).toHaveBeenCalledWith(
      "xoxb-slack-token",
      "C_FRONTEND",
      expect.objectContaining({
        prNumber: 10,
        prTitle: "Stale PR",
        teamName: "Frontend",
        ageDisplay: expect.stringContaining("day"),
      })
    );
  });

  it("deduplicates channels across labels", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const sameChannelConfig = {
      reminders: { enabled: true, stale_hours: 24 },
      teams: {
        frontend: {
          label: "Needs Review: Frontend",
          slack_channel: "C_SHARED",
        },
        backend: {
          label: "Needs Review: Backend",
          slack_channel: "C_SHARED",
        },
      },
    };

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 5,
          pull_request: {},
          labels: [{ name: "Needs Review: Frontend" }, { name: "Needs Review: Backend" }],
          html_url: "https://github.com/org/repo/pull/5",
          title: "Multi-team PR",
          created_at: threeDaysAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Needs Review: Frontend" },
          created_at: threeDaysAgo,
        },
        {
          event: "labeled",
          label: { name: "Needs Review: Backend" },
          created_at: threeDaysAgo,
        },
      ]);

    (slack.sendSlackReminder as jest.Mock).mockResolvedValue(undefined);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig: sameChannelConfig,
    });

    expect(slack.sendSlackReminder).toHaveBeenCalledTimes(1);
  });

  it("handles timeline API failure gracefully", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 7,
          pull_request: {},
          labels: [{ name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/7",
          title: "Timeline fail PR",
          created_at: threeDaysAgo,
        },
      ])
      .mockRejectedValueOnce(new Error("API error"));

    (slack.sendSlackReminder as jest.Mock).mockResolvedValue(undefined);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig,
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });

  it("skips non-PR issues", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 1,
        labels: [{ name: "Needs Review: Frontend" }],
        html_url: "https://github.com/org/repo/issues/1",
        title: "Just an issue",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig,
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });
});
