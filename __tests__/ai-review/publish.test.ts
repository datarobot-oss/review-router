import {
  buildReview,
  hasReviewForSha,
  postReview,
  react,
  ReviewMeta,
  reviewMarker,
  rightSideLines,
  sanitize,
} from "../../src/ai-review/publish";
import { ScoredFinding } from "../../src/ai-review/pipeline";
import { Octokit } from "../../src/types";

jest.mock("@actions/core");

const meta: ReviewMeta = {
  headSha: "abc123",
  reviewerModel: "sonnet",
  scorerModel: "sonnet",
  seconds: 312,
  costUsd: 1.234,
  failedPasses: [],
  skippedCandidates: 0,
  failedCandidates: 0,
  timedOut: false,
};

function scored(overrides: Partial<ScoredFinding> = {}): ScoredFinding {
  return {
    id: "claims-0",
    pass: "claims",
    path: "a.go",
    line: 11,
    severity: "high",
    title: "Race on wait",
    body: "Details",
    score: 85,
    reason: "",
    ...overrides,
  };
}

describe("rightSideLines", () => {
  it("counts context and added lines, not removed ones", () => {
    const patch = "@@ -10,3 +10,4 @@ func X() {\n ctx\n-old\n+new1\n+new2\n ctx2";
    expect([...rightSideLines(patch)]).toEqual([10, 11, 12, 13]);
  });

  it("handles several hunks and an empty patch", () => {
    expect([...rightSideLines("@@ -1 +1 @@\n+a\n@@ -50,2 +60,2 @@\n x\n+y")]).toEqual([1, 60, 61]);
    expect(rightSideLines("").size).toBe(0);
  });
});

describe("sanitize", () => {
  it("breaks mentions and escapes HTML comments", () => {
    expect(sanitize("ping @acme/team and <!-- ai-review sha=x -->")).toBe(
      "ping @​acme/team and &lt;!-- ai-review sha=x -->"
    );
  });

  it("leaves code spans and fences as written", () => {
    expect(sanitize("use `@property` or\n```\n@decorator <!-- x -->\n```\nnot @team")).toBe(
      "use `@property` or\n```\n@decorator <!-- x -->\n```\nnot @\u200bteam"
    );
  });
});

describe("buildReview", () => {
  const files = [{ filename: "a.go", status: "modified", patch: "@@ -10,2 +10,3 @@\n x\n+y\n z" }];

  it("puts diff-line findings inline and the rest in the body", () => {
    const review = buildReview(
      [scored(), scored({ id: "c1", path: "cmd/get.go", line: 105 })],
      files,
      meta
    );
    expect(review.comments).toEqual([
      { path: "a.go", line: 11, side: "RIGHT", body: "**high** · Race on wait\n\nDetails" },
    ]);
    expect(review.body).toContain("#### `cmd/get.go:105`");
    expect(review.body).toContain("Found 2 issues.");
  });

  it("ends with the footer and the head-SHA marker", () => {
    const review = buildReview([], files, {
      ...meta,
      failedPasses: ["rules"],
      timedOut: true,
      skippedCandidates: 2,
    });
    expect(review.body).toContain("No issues found above the confidence threshold.");
    expect(review.body).toContain(
      "sonnet · 5m 12s · $1.23 at list price · rules pass failed · 2 candidates not scored (budget) · stopped at the time limit"
    );
    expect(review.body.endsWith(reviewMarker("abc123"))).toBe(true);
  });

  it("notes candidates whose scoring failed", () => {
    expect(buildReview([], files, { ...meta, failedCandidates: 1 }).body).toContain(
      "1 candidates failed scoring"
    );
  });

  it("keeps a model-written path inside its code span", () => {
    const review = buildReview([scored({ path: "x` @acme/team `y", line: 1 })], files, meta);
    expect(review.body).toContain("#### `x @acme/team y:1`");
  });

  it("names the scorer model when it differs", () => {
    expect(buildReview([], files, { ...meta, scorerModel: "haiku" }).body).toContain(
      "sonnet, scorer haiku"
    );
  });

  it("sanitizes model text", () => {
    const review = buildReview([scored({ title: "@here", body: "<!-- x -->" })], files, meta);
    expect(review.comments[0].body).toBe("**high** · @​here\n\n&lt;!-- x -->");
  });
});

describe("postReview", () => {
  it("posts a COMMENT review on the head commit", async () => {
    const createReview = jest.fn(async () => ({}));
    const octokit = { rest: { pulls: { createReview } } } as unknown as Octokit;
    await postReview(octokit, "acme", "api", 7, "abc123", { body: "b", comments: [] });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "COMMENT",
        commit_id: "abc123",
        pull_number: 7,
        body: "b",
        comments: [],
      })
    );
  });

  it("retries with every finding in the body when GitHub rejects the inline comments", async () => {
    const createReview = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 }))
      .mockResolvedValueOnce({});
    const octokit = { rest: { pulls: { createReview } } } as unknown as Octokit;
    await postReview(octokit, "acme", "api", 7, "abc", {
      body: "summary",
      comments: [{ path: "a.go", line: 3, side: "RIGHT", body: "text" }],
    });
    expect(createReview).toHaveBeenCalledTimes(2);
    const retry = createReview.mock.calls[1][0];
    expect(retry.comments).toBeUndefined();
    expect(retry.body).toBe("#### `a.go:3`\n\ntext\n\nsummary");
  });

  it("rethrows other errors", async () => {
    const createReview = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const octokit = { rest: { pulls: { createReview } } } as unknown as Octokit;
    await expect(
      postReview(octokit, "acme", "api", 7, "abc", {
        body: "b",
        comments: [{ path: "a", line: 1, side: "RIGHT", body: "x" }],
      })
    ).rejects.toThrow("boom");
  });
});

describe("hasReviewForSha", () => {
  it("finds the marker for this SHA only", async () => {
    const octokit = {
      paginate: jest.fn(async () => [
        { body: `x ${reviewMarker("old")}`, user: { type: "Bot" } },
        { body: null, user: { type: "Bot" } },
      ]),
      rest: { pulls: { listReviews: jest.fn() } },
    } as unknown as Octokit;
    expect(await hasReviewForSha(octokit, "acme", "api", 7, "old")).toBe(true);
    expect(await hasReviewForSha(octokit, "acme", "api", 7, "new")).toBe(false);
  });

  it("ignores a marker posted by a person", async () => {
    const octokit = {
      paginate: jest.fn(async () => [{ body: reviewMarker("abc"), user: { type: "User" } }]),
      rest: { pulls: { listReviews: jest.fn() } },
    } as unknown as Octokit;
    expect(await hasReviewForSha(octokit, "acme", "api", 7, "abc")).toBe(false);
  });
});

describe("react", () => {
  it("never throws, because reactions are cosmetic", async () => {
    const octokit = {
      rest: {
        reactions: { createForIssueComment: jest.fn().mockRejectedValue(new Error("nope")) },
      },
    } as unknown as Octokit;
    await expect(react(octokit, "acme", "api", 1, "eyes")).resolves.toBeUndefined();
  });
});
