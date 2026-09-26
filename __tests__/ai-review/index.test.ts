import { runAiReview, AiReviewDeps, AiReviewRequest } from "../../src/ai-review";
import { prepareWorkspace } from "../../src/ai-review/inputs";
import { runPipeline } from "../../src/ai-review/pipeline";
import { reviewMarker } from "../../src/ai-review/publish";
import { Octokit } from "../../src/types";

jest.mock("@actions/core");
jest.mock("../../src/ai-review/inputs");
jest.mock("../../src/ai-review/pipeline");

const orgConfig = {
  teams: {},
  ai_review: {
    enabled: true,
    repos: ["api"],
    endpoint: "https://x/api/v2",
    models: { reviewer: "rev", scorer: "rev" },
  },
};

const pr = {
  number: 7,
  state: "open",
  title: "T",
  body: "B",
  user: { type: "User" },
  head: { sha: "abc123", repo: { full_name: "acme/api" } },
  base: { sha: "base1", ref: "main", repo: { full_name: "acme/api" } },
};

function octokit(reviews: { body: string; user: { type: string } }[] = []) {
  return {
    paginate: jest.fn(async () => reviews),
    rest: {
      pulls: {
        get: jest.fn(async () => ({ data: pr })),
        createReview: jest.fn(async () => ({})),
        listReviews: jest.fn(),
      },
      issues: { createComment: jest.fn(async () => ({})) },
      reactions: { createForIssueComment: jest.fn(async () => ({})) },
    },
  };
}

function deps(): AiReviewDeps {
  return {
    runner: { run: jest.fn() },
    tools: {
      install: jest.fn(async () => "/bin/claude"),
      startProxy: jest.fn(async () => ({ url: "http://127.0.0.1:1", key: "k" })),
      stop: jest.fn(),
    },
    now: jest.fn().mockReturnValueOnce(0).mockReturnValue(65_000),
  };
}

function reactionsOf(gh: ReturnType<typeof octokit>): string[] {
  return gh.rest.reactions.createForIssueComment.mock.calls.map(
    (c) => (c as unknown as [{ content: string }])[0].content
  );
}

const request: AiReviewRequest = {
  owner: "acme",
  repo: "api",
  prNumber: 7,
  kind: "label",
  orgConfig,
  aiToken: "tok",
};

beforeEach(() => {
  jest.clearAllMocks();
  (prepareWorkspace as jest.Mock).mockResolvedValue({
    root: "/tmp/nonexistent-ai-review",
    repoDir: "/r",
    contextDir: "/c",
    files: [],
    diffPatch: "",
    guidance: "",
    ruleFiles: [],
  });
  (runPipeline as jest.Mock).mockResolvedValue({
    findings: [],
    costUsd: 0.9,
    passes: ["claims"],
    failedPasses: [],
    skippedCandidates: 0,
    scoredCandidates: 0,
    failedCandidates: 0,
    timedOut: false,
  });
});

describe("runAiReview", () => {
  it("does nothing, not even an API call, without a token", async () => {
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, { ...request, aiToken: "" }, deps());
    expect(gh.rest.pulls.get).not.toHaveBeenCalled();
  });

  it("posts a review and stops the proxy on the happy path", async () => {
    const gh = octokit();
    const d = deps();
    await runAiReview(gh as unknown as Octokit, request, d);
    expect(gh.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    const body = (gh.rest.pulls.createReview.mock.calls[0] as unknown as [{ body: string }])[0]
      .body;
    expect(body).toContain("1m 5s · $0.90 at list price");
    expect(d.tools.startProxy).toHaveBeenCalledWith("https://x/api/v2", "tok");
    expect(d.tools.stop).toHaveBeenCalled();
  });

  it("skips a label trigger when this SHA was already reviewed", async () => {
    const gh = octokit([{ body: reviewMarker("abc123"), user: { type: "Bot" } }]);
    await runAiReview(gh as unknown as Octokit, request, deps());
    expect(prepareWorkspace).not.toHaveBeenCalled();
  });

  it("reruns on a comment trigger even when this SHA was reviewed", async () => {
    const gh = octokit([{ body: reviewMarker("abc123"), user: { type: "Bot" } }]);
    await runAiReview(
      gh as unknown as Octokit,
      { ...request, kind: "comment", commentId: 9, commenterAssociation: "MEMBER" },
      deps()
    );
    expect(gh.rest.pulls.createReview).toHaveBeenCalled();
    expect(reactionsOf(gh)).toEqual(["eyes", "hooray"]);
  });

  it("posts a failure comment instead of 'no issues' when every pass failed", async () => {
    (runPipeline as jest.Mock).mockResolvedValue({
      findings: [],
      costUsd: 0.1,
      passes: ["claims", "rules"],
      failedPasses: ["claims", "rules"],
      skippedCandidates: 0,
      timedOut: false,
    });
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, request, deps());
    expect(gh.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "AI review couldn't finish: every review pass failed." })
    );
  });

  it("posts a failure comment instead of 'no issues' when every scorer failed", async () => {
    (runPipeline as jest.Mock).mockResolvedValue({
      findings: [],
      costUsd: 0.8,
      passes: ["claims"],
      failedPasses: [],
      skippedCandidates: 0,
      scoredCandidates: 3,
      failedCandidates: 3,
      timedOut: false,
    });
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, request, deps());
    expect(gh.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "AI review couldn't finish: every scoring session failed." })
    );
  });

  it("reports the time limit when it stopped every pass", async () => {
    (runPipeline as jest.Mock).mockResolvedValue({
      findings: [],
      costUsd: 0.5,
      passes: ["claims"],
      failedPasses: ["claims"],
      skippedCandidates: 0,
      scoredCandidates: 0,
      failedCandidates: 0,
      timedOut: true,
    });
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, request, deps());
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "AI review couldn't finish: stopped at the time limit." })
    );
  });

  it("puts download and install under the time limit", async () => {
    const d = deps();
    await runAiReview(octokit() as unknown as Octokit, request, d);
    expect((prepareWorkspace as jest.Mock).mock.calls[0][5]).toBeInstanceOf(AbortSignal);
    expect((d.tools.install as jest.Mock).mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it("reports a stage failure with its user-facing reason and still stops the proxy", async () => {
    const d = deps();
    (d.tools.install as jest.Mock).mockRejectedValue(new Error("pip exploded with details"));
    const gh = octokit();
    await runAiReview(
      gh as unknown as Octokit,
      { ...request, kind: "comment", commentId: 9, commenterAssociation: "OWNER" },
      d
    );
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "AI review couldn't finish: could not install the review tools.",
      })
    );
    expect(reactionsOf(gh)).toEqual(["eyes", "confused"]);
    expect(d.tools.stop).toHaveBeenCalled();
  });

  it("skips fork PRs", async () => {
    const gh = octokit();
    gh.rest.pulls.get.mockResolvedValue({
      data: { ...pr, head: { ...pr.head, repo: { full_name: "evil/api" } } },
    });
    await runAiReview(gh as unknown as Octokit, request, deps());
    expect(prepareWorkspace).not.toHaveBeenCalled();
  });
});
