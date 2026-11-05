import { handleSchedule } from "../src/reminders";
import * as slack from "../src/slack";

jest.mock("../src/slack");

const mockOctokit = {
  rest: {
    issues: {
      listEvents: jest.fn(),
      listComments: jest.fn(),
      updateComment: jest.fn(),
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
  aiToken: "",
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

  describe("with a reminder interval", () => {
    const HOUR = 60 * 60 * 1000;
    const MINUTE = 60 * 1000;
    const intervalConfig = {
      reminders: { enabled: true, stale_hours: 24, interval_hours: 6 },
      teams: teamsConfig.teams,
    };
    const COMMENT = { id: 900, body: "<!-- review-router-ownership -->\n## Code Ownership" };
    const marker = (readyAt: string, number: number) => `<!-- rr:reminder:${readyAt}:${number} -->`;

    /**
     * One PR that turned ready `sinceStale` after the 24 hour stale mark. `recorded` is the
     * number of the last reminder stored in its ownership comment, `null` for none, and
     * `comments` replaces the comments of the PR. Returns the time the PR turned ready.
     */
    function stalePr(
      sinceStale: number,
      { recorded = null, comments }: { recorded?: number | null; comments?: object[] } = {}
    ): string {
      const readyAt = new Date(Date.now() - 24 * HOUR - sinceStale).toISOString();
      const withMarker =
        recorded === null
          ? COMMENT
          : { ...COMMENT, body: `${COMMENT.body}\n${marker(readyAt, recorded)}` };
      mockOctokit.paginate
        .mockResolvedValueOnce([
          {
            number: 30,
            pull_request: {},
            labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
            html_url: "https://github.com/org/repo/pull/30",
            title: "Stale PR",
            created_at: readyAt,
          },
        ])
        .mockResolvedValueOnce([
          { event: "labeled", label: { name: "Ready for Review" }, created_at: readyAt },
        ])
        .mockResolvedValueOnce(comments ?? [withMarker]);
      (slack.sendSlackReminder as jest.Mock).mockResolvedValue(undefined);
      mockOctokit.rest.issues.updateComment.mockResolvedValue(undefined);
      return readyAt;
    }

    const run = (config: object = intervalConfig, repoReminders?: object) =>
      handleSchedule(mockOctokit as any, {
        owner: "org",
        repo: "repo",
        inputs: baseInputs,
        teamsConfig: config as any,
        repoReminders,
      });

    it("sends the first reminder and records its number in the ownership comment", async () => {
      const readyAt = stalePr(6 * HOUR + 30 * MINUTE);
      await run();
      expect(slack.sendSlackReminder).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: "org",
        repo: "repo",
        comment_id: 900,
        body: expect.stringContaining(marker(readyAt, 1)),
      });
    });

    it("sends nothing while the recorded number is current", async () => {
      stalePr(3 * HOUR, { recorded: 0 });
      await run();
      expect(slack.sendSlackReminder).not.toHaveBeenCalled();
      expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    });

    it("sends once when the number advances, even if the run is hours late", async () => {
      stalePr(8 * HOUR, { recorded: 0 });
      await run();
      expect(slack.sendSlackReminder).toHaveBeenCalledTimes(1);
    });

    it("sends nothing on a second run in the same interval", async () => {
      stalePr(7 * HOUR, { recorded: 1 });
      await run();
      expect(slack.sendSlackReminder).not.toHaveBeenCalled();
    });

    it("starts over when the PR was marked ready again after the recorded reminder", async () => {
      const oldReadyAt = new Date(Date.now() - 20 * 24 * HOUR).toISOString();
      stalePr(1 * HOUR, {
        comments: [{ id: 900, body: `${COMMENT.body}\n${marker(oldReadyAt, 40)}` }],
      });
      await run();
      expect(slack.sendSlackReminder).toHaveBeenCalledTimes(1);
    });

    it("uses the repo interval over the org interval", async () => {
      stalePr(6 * HOUR + 30 * MINUTE, { recorded: 0 });
      await run(intervalConfig, { interval_hours: 12 });
      expect(slack.sendSlackReminder).not.toHaveBeenCalled();
    });

    it("sends nothing when the PR has no ownership comment to record the number in", async () => {
      stalePr(6 * HOUR + 30 * MINUTE, { comments: [] });
      await run();
      expect(slack.sendSlackReminder).not.toHaveBeenCalled();
    });

    it("sends nothing when the number can't be recorded, so a failing write can't repeat it", async () => {
      stalePr(6 * HOUR + 30 * MINUTE);
      mockOctokit.rest.issues.updateComment.mockRejectedValue(new Error("403"));
      await run();
      expect(slack.sendSlackReminder).not.toHaveBeenCalled();
    });

    it("lets the repo turn reminders off without listing any PR", async () => {
      await run(intervalConfig, { enabled: false });
      expect(mockOctokit.paginate).not.toHaveBeenCalled();
    });

    it("sends on every run when no interval is set, without touching comments", async () => {
      mockOctokit.paginate.mockReset();
      const readyAt = new Date(Date.now() - 24 * HOUR - 3 * HOUR).toISOString();
      mockOctokit.paginate
        .mockResolvedValueOnce([
          {
            number: 30,
            pull_request: {},
            labels: [{ name: "Ready for Review" }, { name: "Needs Review: Frontend" }],
            html_url: "https://github.com/org/repo/pull/30",
            title: "Stale PR",
            created_at: readyAt,
          },
        ])
        .mockResolvedValueOnce([
          { event: "labeled", label: { name: "Ready for Review" }, created_at: readyAt },
        ]);
      (slack.sendSlackReminder as jest.Mock).mockResolvedValue(undefined);
      await run(teamsConfig);
      expect(slack.sendSlackReminder).toHaveBeenCalledTimes(1);
      expect(mockOctokit.rest.issues.updateComment).not.toHaveBeenCalled();
    });
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
