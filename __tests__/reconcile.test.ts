import { latestApprovers, reconcileOpenPulls } from "../src/reconcile";
import { handleReviewSubmitted, handleComment, syncReviewCheck } from "../src/router";
import { COMMENT_MARKER } from "../src/comment";
import { JIRA_COMMENT_MARKER, WELCOME_MARKER } from "../src/welcome";
import { OrgConfig } from "../src/types";

jest.mock("@actions/core");
jest.mock("../src/router");

const CURSOR = "2026-10-23T10:00:00Z";
const bodyWithCursor = `body\n<!-- rr:dm-cursor:${CURSOR} -->`;

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
const teamsConfig: OrgConfig = { teams: {}, users: { alice: "U1" } };
const ctx = {
  owner: "org",
  repo: "repo",
  inputs,
  capabilities: { hasOrgAccess: true },
  teamsConfig,
};

const forkPr = (number: number, body = "") => ({
  number,
  body,
  html_url: `https://github.com/org/repo/pull/${number}`,
  user: { login: "alice" },
  assignees: [],
  labels: [] as { name: string }[],
  head: { sha: `sha${number}`, repo: { full_name: "fork/repo" } },
  base: { repo: { full_name: "org/repo" } },
});

const human = (login: string) => ({ login, type: "User" });

function octokitFor(opts: {
  pulls: object[];
  reviews?: object[];
  reviewComments?: object[];
  issueComments?: object[];
  freshBody?: string;
  /** The ownership comment as GitHub returns it when the cursor is written, which can be newer than the list. */
  freshComment?: string;
}) {
  const list = jest.fn();
  const listReviews = jest.fn();
  const listReviewComments = jest.fn();
  const listComments = jest.fn();
  const paginate = jest.fn(async (fn: unknown) => {
    if (fn === list) return opts.pulls;
    if (fn === listReviews) return opts.reviews ?? [];
    if (fn === listReviewComments) return opts.reviewComments ?? [];
    if (fn === listComments) return opts.issueComments ?? [];
    return [];
  });
  const get = jest.fn().mockResolvedValue({ data: { body: opts.freshBody ?? "" } });
  const update = jest.fn().mockResolvedValue({});
  const getComment = jest.fn().mockResolvedValue({ data: { body: opts.freshComment ?? "" } });
  const updateComment = jest.fn().mockResolvedValue({});
  return {
    rest: {
      pulls: { list, listReviews, listReviewComments, get, update },
      issues: { listComments, getComment, updateComment },
    },
    paginate,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("latestApprovers", () => {
  const review = (login: string, state: string) => ({ user: { login }, state });

  it("returns reviewers whose latest review is an approval", () => {
    expect(latestApprovers([review("bob", "APPROVED"), review("carol", "APPROVED")])).toEqual([
      "bob",
      "carol",
    ]);
  });

  it("drops an approval superseded by CHANGES_REQUESTED", () => {
    expect(
      latestApprovers([review("bob", "APPROVED"), review("bob", "CHANGES_REQUESTED")])
    ).toEqual([]);
  });

  it("drops an approval followed by DISMISSED", () => {
    expect(latestApprovers([review("bob", "APPROVED"), review("bob", "DISMISSED")])).toEqual([]);
  });

  it("keeps an approval followed by a COMMENTED review", () => {
    expect(latestApprovers([review("bob", "APPROVED"), review("bob", "COMMENTED")])).toEqual([
      "bob",
    ]);
  });
});

describe("reconcileOpenPulls", () => {
  it("skips same-repo PRs", async () => {
    const sameRepo = { ...forkPr(1), head: { sha: "s", repo: { full_name: "org/repo" } } };
    const octokit = octokitFor({
      pulls: [sameRepo],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleReviewSubmitted).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("treats a PR with a null head repo as a fork", async () => {
    const orphan = { ...forkPr(1), head: { sha: "s1", repo: null } };
    const octokit = octokitFor({
      pulls: [orphan],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleReviewSubmitted).toHaveBeenCalledTimes(1);
  });

  it("calls handleReviewSubmitted once per current approver", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1)],
      reviews: [
        { user: human("bob"), state: "APPROVED" },
        { user: human("carol"), state: "APPROVED" },
        { user: human("dave"), state: "CHANGES_REQUESTED" },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleReviewSubmitted).toHaveBeenCalledTimes(2);
    expect(handleReviewSubmitted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prNumber: 1, reviewer: "bob", headSha: "sha1", author: "alice" })
    );
    expect(handleReviewSubmitted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reviewer: "carol" })
    );
  });

  it("writes the cursor and sends no DMs on first sight", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body")],
      freshBody: "body",
      reviews: [{ user: human("bob"), state: "APPROVED", submitted_at: "2026-10-22T09:00:00Z" }],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 1,
        body: expect.stringMatching(/<!-- rr:dm-cursor:\d{4}-\d{2}-\d{2}T[\d:.]+Z -->/),
      })
    );
    expect(handleComment).not.toHaveBeenCalled();
  });

  it("does not touch the description of a PR whose author and assignees have no Slack ID", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body")],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileOpenPulls(octokit as any, { ...ctx, teamsConfig: { teams: {}, users: {} } });

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(handleReviewSubmitted).toHaveBeenCalledTimes(1);
  });

  it("writes the cursor when only an assignee has a Slack ID", async () => {
    const withAssignee = { ...forkPr(1, "body"), assignees: [{ login: "carol" }] };
    const octokit = octokitFor({ pulls: [withAssignee], freshBody: "body" });

    await reconcileOpenPulls(octokit as any, {
      ...ctx,
      teamsConfig: { teams: {}, users: { carol: "U2" } },
    });

    expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
  });

  it("does not touch the description without a Slack token", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, "body")] });

    await reconcileOpenPulls(octokit as any, { ...ctx, inputs: { ...inputs, slackToken: "" } });

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("treats a deleted cursor marker as first sight and does not DM old comments", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body without marker")],
      issueComments: [
        {
          user: human("bob"),
          body: "old comment",
          created_at: "2026-01-01T00:00:00Z",
          html_url: "u",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).not.toHaveBeenCalled();
  });

  describe("first sight of a PR", () => {
    const NOW = new Date("2026-10-23T12:00:00Z");
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const youngPr = (createdHoursAgo: number) => ({
      ...forkPr(1, "body"),
      created_at: hoursAgo(createdHoursAgo),
    });
    const cursorWritten = (octokit: ReturnType<typeof octokitFor>) =>
      octokit.rest.pulls.update.mock.calls.at(-1)?.[0].body;

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("sends the DM for an approval that arrived after a young PR was opened", async () => {
      const octokit = octokitFor({
        pulls: [youngPr(3)],
        freshBody: "body",
        reviews: [{ user: human("bob"), state: "APPROVED", submitted_at: hoursAgo(1) }],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(handleComment).toHaveBeenCalledTimes(1);
      expect((handleComment as jest.Mock).mock.calls[0][1]).toMatchObject({
        kind: "review",
        commenter: "bob",
      });
      expect(cursorWritten(octokit)).toContain(`rr:dm-cursor:${hoursAgo(1)}`);
    });

    it("replays a review that arrived over a weekend, before the first Monday run of a weekday schedule", async () => {
      const octokit = octokitFor({
        pulls: [youngPr(54)],
        freshBody: "body",
        reviews: [{ user: human("bob"), state: "APPROVED", submitted_at: hoursAgo(40) }],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(handleComment).toHaveBeenCalledTimes(1);
    });

    it("starts the cursor at the PR creation time when nothing has happened yet", async () => {
      const octokit = octokitFor({ pulls: [youngPr(3)], freshBody: "body" });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(handleComment).not.toHaveBeenCalled();
      expect(cursorWritten(octokit)).toContain(`rr:dm-cursor:${hoursAgo(3)}`);
    });

    it("replays a PR opened just under a week ago", async () => {
      const octokit = octokitFor({
        pulls: [youngPr(167)],
        freshBody: "body",
        issueComments: [
          { user: human("bob"), body: "hi", created_at: hoursAgo(166), html_url: "u" },
        ],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(handleComment).toHaveBeenCalledTimes(1);
    });

    it.each([168, 169])(
      "sends no DM for events on a PR opened %i hours ago, and starts the cursor now",
      async (hours) => {
        const octokit = octokitFor({
          pulls: [youngPr(hours)],
          freshBody: "body",
          issueComments: [
            { user: human("bob"), body: "hi", created_at: hoursAgo(1), html_url: "u" },
          ],
        });

        await reconcileOpenPulls(octokit as any, ctx);

        expect(handleComment).not.toHaveBeenCalled();
        expect(cursorWritten(octokit)).toContain(`rr:dm-cursor:${NOW.toISOString()}`);
      }
    );

    it("replays a PR whose creation time is a few seconds ahead of the runner clock", async () => {
      const octokit = octokitFor({
        pulls: [{ ...forkPr(1, "body"), created_at: new Date(NOW.getTime() + 5000).toISOString() }],
        freshBody: "body",
        issueComments: [
          {
            user: human("bob"),
            body: "hi",
            created_at: new Date(NOW.getTime() + 6000).toISOString(),
            html_url: "u",
          },
        ],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(handleComment).toHaveBeenCalledTimes(1);
    });
  });

  it("sends events newer than the cursor through handleComment with the right kinds", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      reviews: [
        { user: human("bob"), state: "APPROVED", submitted_at: "2026-10-23T10:05:00Z" },
        { user: human("eve"), state: "APPROVED", submitted_at: "2026-10-23T09:00:00Z" },
      ],
      reviewComments: [
        {
          user: human("bob"),
          body: "nit",
          created_at: "2026-10-23T10:10:00Z",
          html_url: "https://github.com/org/repo/pull/1#discussion_r1",
        },
      ],
      issueComments: [
        {
          user: human("carol"),
          body: "looks good",
          created_at: "2026-10-23T10:15:00Z",
          html_url: "https://github.com/org/repo/pull/1#issuecomment-1",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    const calls = (handleComment as jest.Mock).mock.calls.map(([, c]) => [
      c.kind,
      c.commenter,
      c.commentUrl,
    ]);
    expect(calls).toEqual([
      ["review", "bob", ""],
      ["review_comment", "bob", "https://github.com/org/repo/pull/1#discussion_r1"],
      ["comment", "carol", "https://github.com/org/repo/pull/1#issuecomment-1"],
    ]);
  });

  it("sends no approval DM for an approval that a later review superseded", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      reviews: [
        { user: human("bob"), state: "APPROVED", submitted_at: "2026-10-23T10:05:00Z" },
        { user: human("bob"), state: "CHANGES_REQUESTED", submitted_at: "2026-10-23T10:20:00Z" },
        { user: human("carol"), state: "APPROVED", submitted_at: "2026-10-23T10:06:00Z" },
        { user: human("dave"), state: "APPROVED", submitted_at: "2026-10-23T10:07:00Z" },
        { user: human("dave"), state: "DISMISSED", submitted_at: "2026-10-23T10:21:00Z" },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    const commenters = (handleComment as jest.Mock).mock.calls.map(([, c]) => c.commenter);
    expect(commenters).toEqual(["carol"]);
  });

  it("sends one DM for a burst of inline comments from the same reviewer and links the first", async () => {
    const at = (m: number) => `2026-10-23T10:${String(m).padStart(2, "0")}:00Z`;
    const inline = (id: number, user: string, minute: number) => ({
      user: human(user),
      body: "nit",
      created_at: at(minute),
      html_url: `https://github.com/org/repo/pull/1#discussion_r${id}`,
    });
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      reviewComments: [
        inline(1, "bob", 5),
        inline(2, "bob", 6),
        inline(3, "carol", 7),
        inline(4, "bob", 8),
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    const calls = (handleComment as jest.Mock).mock.calls.map(([, c]) => [
      c.commenter,
      c.commentUrl,
    ]);
    expect(calls).toEqual([
      ["bob", "https://github.com/org/repo/pull/1#discussion_r1"],
      ["carol", "https://github.com/org/repo/pull/1#discussion_r3"],
    ]);
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(`rr:dm-cursor:${at(8)}`) })
    );
  });

  it("does not merge an approval with a review comment from the same reviewer", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      reviews: [
        {
          user: human("bob"),
          state: "COMMENTED",
          body: "see inline",
          html_url: "https://github.com/org/repo/pull/1#pullrequestreview-1",
          submitted_at: "2026-10-23T10:05:00Z",
        },
        { user: human("bob"), state: "APPROVED", submitted_at: "2026-10-23T10:06:00Z" },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(2);
  });

  it("sends inline comments drafted before the cursor once their review is submitted after it", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      reviews: [
        {
          id: 77,
          user: human("bob"),
          state: "COMMENTED",
          body: "",
          submitted_at: "2026-10-23T10:20:00Z",
        },
      ],
      reviewComments: [
        {
          user: human("bob"),
          pull_request_review_id: 77,
          body: "nit",
          created_at: "2026-10-23T09:50:00Z",
          html_url: "https://github.com/org/repo/pull/1#discussion_r1",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("rr:dm-cursor:2026-10-23T10:20:00Z"),
      })
    );
  });

  it("skips inline comments whose review was submitted before the cursor", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      reviews: [
        {
          id: 77,
          user: human("bob"),
          state: "COMMENTED",
          body: "",
          submitted_at: "2026-10-23T09:55:00Z",
        },
      ],
      reviewComments: [
        {
          user: human("bob"),
          pull_request_review_id: 77,
          body: "nit",
          created_at: "2026-10-23T09:50:00Z",
          html_url: "https://github.com/org/repo/pull/1#discussion_r1",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).not.toHaveBeenCalled();
  });

  it("moves the cursor to the last handled event when a later event fails, so handled ones are not re-sent", async () => {
    (handleComment as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));
    const issueComment = (user: string, minute: number) => ({
      user: human(user),
      body: "hi",
      created_at: `2026-10-23T10:0${minute}:00Z`,
      html_url: `https://github.com/org/repo/pull/1#issuecomment-${minute}`,
    });
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      issueComments: [issueComment("bob", 5), issueComment("carol", 6), issueComment("dave", 7)],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(2);
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("rr:dm-cursor:2026-10-23T10:05:00Z"),
      })
    );
  });

  it("leaves the cursor alone when the first event fails", async () => {
    (handleComment as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      issueComments: [
        {
          user: human("bob"),
          body: "hi",
          created_at: "2026-10-23T10:05:00Z",
          html_url: "https://github.com/org/repo/pull/1#issuecomment-1",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("ignores bot comments, the router's own comments and the author's own comments", async () => {
    const created = "2026-10-23T10:05:00Z";
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      issueComments: [
        {
          user: { login: "dependabot[bot]", type: "Bot" },
          body: "bump",
          created_at: created,
          html_url: "a",
        },
        { user: human("alice"), body: "my own comment", created_at: created, html_url: "b" },
        {
          user: human("bob"),
          body: `${COMMENT_MARKER}\nownership`,
          created_at: created,
          html_url: "c",
        },
        { user: human("carol"), body: "real feedback", created_at: created, html_url: "d" },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(handleComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commenter: "carol", kind: "comment" })
    );
  });

  it("ignores the welcome comment and a legacy Jira comment even from a user account", async () => {
    const created = "2026-10-23T10:05:00Z";
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      issueComments: [
        {
          user: human("bob"),
          body: `${WELCOME_MARKER}\nwelcome`,
          created_at: created,
          html_url: "a",
        },
        {
          user: human("bob"),
          body: `${JIRA_COMMENT_MARKER}\ncard`,
          created_at: created,
          html_url: "b",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).not.toHaveBeenCalled();
  });

  it("ignores /review and /ai-review slash commands, as the live comment path does", async () => {
    const created = "2026-10-23T10:05:00Z";
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      issueComments: [
        { user: human("bob"), body: "/review", created_at: created, html_url: "a" },
        { user: human("bob"), body: "/ai-review", created_at: created, html_url: "b" },
        {
          user: human("bob"),
          body: "/ai-review focus on tests",
          created_at: created,
          html_url: "c",
        },
        {
          user: human("carol"),
          body: "please review the new tests",
          created_at: created,
          html_url: "d",
        },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(handleComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commenter: "carol" })
    );
  });

  it("advances the cursor to the newest handled event", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: bodyWithCursor,
      issueComments: [
        { user: human("carol"), body: "a", created_at: "2026-10-23T10:05:00Z", html_url: "x" },
        { user: human("carol"), body: "b", created_at: "2026-10-23T10:15:00Z", html_url: "y" },
      ],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    const body = octokit.rest.pulls.update.mock.calls[0][0].body as string;
    expect(body).toContain("<!-- rr:dm-cursor:2026-10-23T10:15:00Z -->");
    expect(body).not.toContain(CURSOR);
  });

  it("does not rewrite the description when there are no new events", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, bodyWithCursor)], freshBody: bodyWithCursor });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("continues with the next PR after one throws", async () => {
    (handleReviewSubmitted as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    const octokit = octokitFor({
      pulls: [forkPr(1), forkPr(2)],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleReviewSubmitted).toHaveBeenCalledTimes(2);
    expect(handleReviewSubmitted).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ prNumber: 2 })
    );
  });

  describe("review check refresh", () => {
    const needsReview = [{ name: "Needs Review: Platform" }];

    it("refreshes the check on the current head of a fork PR with a Needs Review label", async () => {
      const octokit = octokitFor({ pulls: [{ ...forkPr(1), labels: needsReview }] });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(syncReviewCheck).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ owner: "org", repo: "repo", prNumber: 1, headSha: "sha1" })
      );
    });

    it("refreshes after the approvals are replayed", async () => {
      const octokit = octokitFor({
        pulls: [{ ...forkPr(1), labels: needsReview }],
        reviews: [{ user: human("bob"), state: "APPROVED" }],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      const replayed = (handleReviewSubmitted as jest.Mock).mock.invocationCallOrder[0];
      const refreshed = (syncReviewCheck as jest.Mock).mock.invocationCallOrder[0];
      expect(replayed).toBeLessThan(refreshed);
    });

    it("refreshes the check on a PR whose team labels are gone, so a running check can settle", async () => {
      const octokit = octokitFor({ pulls: [{ ...forkPr(1), labels: [{ name: "bug" }] }] });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(syncReviewCheck).toHaveBeenCalledTimes(1);
    });

    it("refreshes the check on a same-repo PR and does nothing else", async () => {
      const sameRepo = {
        ...forkPr(1),
        labels: needsReview,
        head: { sha: "s1", repo: { full_name: "org/repo" } },
      };
      const octokit = octokitFor({
        pulls: [sameRepo],
        reviews: [{ user: human("bob"), state: "APPROVED" }],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(syncReviewCheck).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ prNumber: 1, headSha: "s1" })
      );
      expect(handleReviewSubmitted).not.toHaveBeenCalled();
      expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    });

    it("refreshes the check even when replaying the PR's approvals throws", async () => {
      (handleReviewSubmitted as jest.Mock).mockRejectedValueOnce(new Error("boom"));
      const octokit = octokitFor({
        pulls: [{ ...forkPr(1), labels: needsReview }],
        reviews: [{ user: human("bob"), state: "APPROVED" }],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(syncReviewCheck).toHaveBeenCalledTimes(1);
    });

    it("continues with the next PR after a refresh throws", async () => {
      (syncReviewCheck as jest.Mock).mockRejectedValueOnce(new Error("boom"));
      const octokit = octokitFor({
        pulls: [
          { ...forkPr(1), labels: needsReview },
          { ...forkPr(2), labels: needsReview },
        ],
      });

      await reconcileOpenPulls(octokit as any, ctx);

      expect(syncReviewCheck).toHaveBeenCalledTimes(2);
    });
  });
});

describe("the DM cursor in the ownership comment", () => {
  const ownership = (extra = "") => ({
    id: 77,
    body: `${COMMENT_MARKER}\n## Code Ownership\n<!-- rr:slack:C1:1.2 -->\n<!-- rr:reminder:2026-10-23T09:00:00Z:2 -->${extra}`,
    user: { login: "datarobot-pr-review-router", type: "Bot" },
    created_at: "2026-10-20T00:00:00Z",
  });
  const withCursor = `\n<!-- rr:dm-cursor:${CURSOR} -->`;
  const bobComment = (created_at: string) => ({
    user: human("bob"),
    body: "please rename this",
    created_at,
    html_url: "https://github.com/org/repo/pull/1#issuecomment-1",
  });

  it("sends the events after the cursor that the ownership comment holds", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body")],
      issueComments: [ownership(withCursor), bobComment("2026-10-23T10:05:00Z")],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(handleComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commenter: "bob", kind: "comment" })
    );
  });

  it("trusts the ownership comment over an older cursor in the description", async () => {
    const staleDescription = "body\n<!-- rr:dm-cursor:2026-10-01T00:00:00Z -->";
    const octokit = octokitFor({
      pulls: [forkPr(1, staleDescription)],
      issueComments: [ownership(withCursor), bobComment("2026-10-10T00:00:00Z")],
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(handleComment).not.toHaveBeenCalled();
  });

  it("writes the first cursor into the ownership comment and leaves the description alone", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body")],
      issueComments: [ownership()],
      freshComment: ownership().body,
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 77,
        body: expect.stringMatching(/<!-- rr:dm-cursor:\d{4}-\d{2}-\d{2}T[\d:.]+Z -->/),
      })
    );
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(handleComment).not.toHaveBeenCalled();
  });

  it("builds the stored comment from its fresh text, so a marker written meanwhile survives", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body")],
      issueComments: [ownership()],
      freshComment: ownership().body.replace(":2 -->", ":3 -->"),
    });

    await reconcileOpenPulls(octokit as any, ctx);

    const { body } = octokit.rest.issues.updateComment.mock.calls[0][0];
    expect(body).toContain("rr:reminder:2026-10-23T09:00:00Z:3");
    expect(body).not.toContain("rr:reminder:2026-10-23T09:00:00Z:2");
    expect(body).toContain("rr:slack:C1:1.2");
  });

  it("moves the cursor to the newest handled event in the ownership comment", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, "body")],
      issueComments: [ownership(withCursor), bobComment("2026-10-23T10:05:00Z")],
      freshComment: ownership(withCursor).body,
    });

    await reconcileOpenPulls(octokit as any, ctx);

    const { body } = octokit.rest.issues.updateComment.mock.calls[0][0];
    expect(body).toContain("<!-- rr:dm-cursor:2026-10-23T10:05:00Z -->");
    expect(body.match(/rr:dm-cursor/g)).toHaveLength(1);
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("moves a cursor an older version left in the description into the comment", async () => {
    const octokit = octokitFor({
      pulls: [forkPr(1, bodyWithCursor)],
      freshBody: `${bodyWithCursor}\nmore text`,
      issueComments: [ownership(), bobComment("2026-10-23T10:05:00Z")],
      freshComment: ownership().body,
    });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 77,
        body: expect.stringContaining("rr:dm-cursor:2026-10-23T10:05:00Z"),
      })
    );
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 1, body: "body\nmore text" })
    );
  });

  it("keeps the cursor in the description while the PR has no ownership comment", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, "body")], freshBody: "body" });

    await reconcileOpenPulls(octokit as any, ctx);

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("rr:dm-cursor:") })
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("does not look for the ownership comment when nobody on the PR can be messaged", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, "body")] });

    await reconcileOpenPulls(octokit as any, { ...ctx, teamsConfig: { teams: {}, users: {} } });

    expect(octokit.paginate).not.toHaveBeenCalledWith(
      octokit.rest.issues.listComments,
      expect.anything()
    );
  });

  it("does not throw when the ownership comment can't be read for the write", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, "body")], issueComments: [ownership()] });
    octokit.rest.issues.getComment.mockRejectedValue(new Error("404"));

    await expect(reconcileOpenPulls(octokit as any, ctx)).resolves.toBeUndefined();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});
