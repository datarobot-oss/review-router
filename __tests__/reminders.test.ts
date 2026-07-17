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
  configPath: "config.yml",
  configS3: "",
  readyLabel: "Ready for Review",
  needsReviewPrefix: "Needs Review",
  needsReviewLabelColor: "fbca04",
  jiraToken: "",
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

beforeEach(() => {
  jest.clearAllMocks();
  mockOctokit.paginate.mockReset();
});

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

  it("warns and returns when no Slack token", async () => {
    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: { ...baseInputs, slackToken: "" },
      teamsConfig,
    });

    expect(mockOctokit.paginate).not.toHaveBeenCalled();
  });

  it("sends no reminders when no open PRs have Ready for Review label", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 1,
        pull_request: {},
        labels: [{ name: "Needs Review: Frontend" }],
        html_url: "https://github.com/org/repo/pull/1",
        title: "No ready label",
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

  it("skips PRs without Needs Review labels even if Ready for Review is present", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 1,
        pull_request: {},
        labels: [{ name: "Ready for Review" }, { name: "bug" }],
        html_url: "https://github.com/org/repo/pull/1",
        title: "No team labels",
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

  it("skips PRs with fresh Ready for Review label", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 1,
          pull_request: {},
          labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/1",
          title: "Fresh PR",
          created_at: oneHourAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Ready for Review" },
          created_at: oneHourAgo,
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
          labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/10",
          title: "Stale PR",
          created_at: twoDaysAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Ready for Review" },
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

  it("uses most recent Ready for Review event when label was re-added", async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 20,
          pull_request: {},
          labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/20",
          title: "Re-triggered PR",
          created_at: fiveDaysAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Ready for Review" },
          created_at: fiveDaysAgo,
        },
        {
          event: "unlabeled",
          label: { name: "Ready for Review" },
          created_at: fiveDaysAgo,
        },
        {
          event: "labeled",
          label: { name: "Ready for Review" },
          created_at: oneHourAgo,
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
          labels: [
            { name: "Ready for Review" },
            { name: "Needs Review: Frontend" },
            { name: "Needs Review: Backend" },
          ],
          html_url: "https://github.com/org/repo/pull/5",
          title: "Multi-team PR",
          created_at: threeDaysAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "Ready for Review" },
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
          labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/7",
          title: "Timeline fail PR",
          created_at: threeDaysAgo,
        },
      ])
      .mockRejectedValueOnce(new Error("API error"));

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig,
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });

  it("skips PRs with external-contribution label", async () => {
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 1,
          pull_request: {},
          html_url: "https://github.com/org/repo/pull/1",
          title: "External fix",
          user: { login: "external-user" },
          labels: [
            { name: "Ready for Review" },
            { name: "Needs Review: Frontend" },
            { name: "external-contribution" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        { event: "labeled", label: { name: "Ready for Review" }, created_at: staleDate },
      ]);

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
        labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
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

  it("sends reminder for PR with alias ready label", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 30,
          pull_request: {},
          labels: [{ name: "00 - Ready for Review" }, { name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/30",
          title: "Alias label PR",
          created_at: twoDaysAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "00 - Ready for Review" },
          created_at: twoDaysAgo,
        },
      ]);

    (slack.sendSlackReminder as jest.Mock).mockResolvedValue(undefined);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, ready_label_aliases: ["00 - Ready for Review"] },
    });

    expect(slack.sendSlackReminder).toHaveBeenCalledWith(
      "xoxb-slack-token",
      "C_FRONTEND",
      expect.objectContaining({ prNumber: 30 })
    );
  });

  it("skips PR with alias ready label that was recently added", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    mockOctokit.paginate
      .mockResolvedValueOnce([
        {
          number: 31,
          pull_request: {},
          labels: [{ name: "00 - Ready for Review" }, { name: "Needs Review: Frontend" }],
          html_url: "https://github.com/org/repo/pull/31",
          title: "Fresh alias PR",
          created_at: oneHourAgo,
        },
      ])
      .mockResolvedValueOnce([
        {
          event: "labeled",
          label: { name: "00 - Ready for Review" },
          created_at: oneHourAgo,
        },
      ]);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig: { ...teamsConfig, ready_label_aliases: ["00 - Ready for Review"] },
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });

  it("ignores alias ready label when not configured in ready_label_aliases", async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 32,
        pull_request: {},
        labels: [{ name: "00 - Ready for Review" }, { name: "Needs Review: Frontend" }],
        html_url: "https://github.com/org/repo/pull/32",
        title: "Unconfigured alias PR",
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    await handleSchedule(mockOctokit as any, {
      owner: "org",
      repo: "repo",
      inputs: baseInputs,
      teamsConfig, // no ready_label_aliases configured
    });

    expect(slack.sendSlackReminder).not.toHaveBeenCalled();
  });
});
