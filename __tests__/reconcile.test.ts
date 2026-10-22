import { latestApprovers, reconcileForkPulls } from "../src/reconcile";
import { handleReviewSubmitted, handleComment } from "../src/router";
import { COMMENT_MARKER } from "../src/comment";
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
  return {
    rest: {
      pulls: { list, listReviews, listReviewComments, get, update },
      issues: { listComments },
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

describe("reconcileForkPulls", () => {
  it("skips same-repo PRs", async () => {
    const sameRepo = { ...forkPr(1), head: { sha: "s", repo: { full_name: "org/repo" } } };
    const octokit = octokitFor({
      pulls: [sameRepo],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileForkPulls(octokit as any, ctx);

    expect(handleReviewSubmitted).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("treats a PR with a null head repo as a fork", async () => {
    const orphan = { ...forkPr(1), head: { sha: "s1", repo: null } };
    const octokit = octokitFor({
      pulls: [orphan],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileForkPulls(octokit as any, ctx);

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

    await reconcileForkPulls(octokit as any, ctx);

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

    await reconcileForkPulls(octokit as any, ctx);

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

    await reconcileForkPulls(octokit as any, { ...ctx, teamsConfig: { teams: {}, users: {} } });

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(handleReviewSubmitted).toHaveBeenCalledTimes(1);
  });

  it("writes the cursor when only an assignee has a Slack ID", async () => {
    const withAssignee = { ...forkPr(1, "body"), assignees: [{ login: "carol" }] };
    const octokit = octokitFor({ pulls: [withAssignee], freshBody: "body" });

    await reconcileForkPulls(octokit as any, {
      ...ctx,
      teamsConfig: { teams: {}, users: { carol: "U2" } },
    });

    expect(octokit.rest.pulls.update).toHaveBeenCalledTimes(1);
  });

  it("does not touch the description without a Slack token", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, "body")] });

    await reconcileForkPulls(octokit as any, { ...ctx, inputs: { ...inputs, slackToken: "" } });

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

    await reconcileForkPulls(octokit as any, ctx);

    expect(handleComment).not.toHaveBeenCalled();
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

    await reconcileForkPulls(octokit as any, ctx);

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

    await reconcileForkPulls(octokit as any, ctx);

    expect(handleComment).toHaveBeenCalledTimes(1);
    expect(handleComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ commenter: "carol", kind: "comment" })
    );
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

    await reconcileForkPulls(octokit as any, ctx);

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

    await reconcileForkPulls(octokit as any, ctx);

    const body = octokit.rest.pulls.update.mock.calls[0][0].body as string;
    expect(body).toContain("<!-- rr:dm-cursor:2026-10-23T10:15:00Z -->");
    expect(body).not.toContain(CURSOR);
  });

  it("does not rewrite the description when there are no new events", async () => {
    const octokit = octokitFor({ pulls: [forkPr(1, bodyWithCursor)], freshBody: bodyWithCursor });

    await reconcileForkPulls(octokit as any, ctx);

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("continues with the next PR after one throws", async () => {
    (handleReviewSubmitted as jest.Mock).mockRejectedValueOnce(new Error("boom"));
    const octokit = octokitFor({
      pulls: [forkPr(1), forkPr(2)],
      reviews: [{ user: human("bob"), state: "APPROVED" }],
    });

    await reconcileForkPulls(octokit as any, ctx);

    expect(handleReviewSubmitted).toHaveBeenCalledTimes(2);
    expect(handleReviewSubmitted).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ prNumber: 2 })
    );
  });
});
