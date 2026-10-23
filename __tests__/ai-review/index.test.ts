import * as core from "@actions/core";
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
      checks: {
        create: jest.fn(async () => ({ data: { id: 55 } })),
        update: jest.fn(async () => ({})),
      },
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

/** A person asked with /ai-review, so a failure also gets a comment. */
const commandRequest: AiReviewRequest = {
  ...request,
  kind: "comment",
  commentId: 9,
  commenterAssociation: "MEMBER",
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
    precedentFiles: [],
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
    expect(body).toContain("· 1m 5s</sub>");
    expect(d.tools.startProxy).toHaveBeenCalledWith("https://x/api/v2", "tok");
    expect(d.tools.stop).toHaveBeenCalled();
  });

  it("logs the model and effort each role runs at", async () => {
    const withEffort = {
      ...orgConfig,
      ai_review: {
        ...orgConfig.ai_review,
        models: { reviewer: "rev", scorer: "sco" },
        effort: { reviewer: "high" as const },
      },
    };
    await runAiReview(
      octokit() as unknown as Octokit,
      { ...request, orgConfig: withEffort },
      deps()
    );
    expect(core.info).toHaveBeenCalledWith(
      "AI review settings: reviewer rev at high effort, scorer sco at medium effort"
    );
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
    await runAiReview(gh as unknown as Octokit, commandRequest, deps());
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
    await runAiReview(gh as unknown as Octokit, commandRequest, deps());
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
    await runAiReview(gh as unknown as Octokit, commandRequest, deps());
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "AI review couldn't finish: stopped at the time limit." })
    );
  });

  it("reports the time limit when it cut off scoring and nothing was confirmed", async () => {
    (runPipeline as jest.Mock).mockResolvedValue({
      findings: [],
      costUsd: 0.9,
      passes: ["claims"],
      failedPasses: [],
      skippedCandidates: 2,
      scoredCandidates: 0,
      failedCandidates: 0,
      timedOut: true,
    });
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, commandRequest, deps());
    expect(gh.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "AI review couldn't finish: stopped at the time limit." })
    );
  });

  it.each([
    [
      { skippedCandidates: 2, scoredCandidates: 0, failedCandidates: 0 },
      "ran out of budget before scoring every candidate",
    ],
    [
      { skippedCandidates: 0, scoredCandidates: 3, failedCandidates: 1 },
      "a scoring session failed",
    ],
  ])("won't call a review clean when a candidate went unscored (%o)", async (counts, reason) => {
    (runPipeline as jest.Mock).mockResolvedValue({
      findings: [],
      costUsd: 2.8,
      passes: ["claims"],
      failedPasses: [],
      timedOut: false,
      ...counts,
    });
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, commandRequest, deps());
    expect(gh.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(gh.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: `AI review couldn't finish: ${reason}.` })
    );
  });

  it("puts download and install under the time limit", async () => {
    const d = deps();
    await runAiReview(octokit() as unknown as Octokit, request, d);
    expect((prepareWorkspace as jest.Mock).mock.calls[0][5]).toBeInstanceOf(AbortSignal);
    expect((d.tools.install as jest.Mock).mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it("links the workflow run in the review and in a failure comment", async () => {
    const runUrl = "https://github.com/acme/api/actions/runs/42";
    const gh = octokit();
    await runAiReview(gh as unknown as Octokit, { ...request, runUrl }, deps());
    const body = (gh.rest.pulls.createReview.mock.calls[0] as unknown as [{ body: string }])[0]
      .body;
    expect(body).toContain(`[workflow run](${runUrl})`);

    const failing = deps();
    (failing.tools.install as jest.Mock).mockRejectedValue(new Error("boom"));
    const gh2 = octokit();
    await runAiReview(gh2 as unknown as Octokit, { ...commandRequest, runUrl }, failing);
    expect(gh2.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(`[workflow run](${runUrl})`) })
    );
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

  describe("Review Router AI review check", () => {
    const runUrl = "https://github.com/acme/api/actions/runs/42";
    const oneFinding = {
      findings: [{ path: "a.ts", line: 1, severity: "high", title: "t", body: "b" }],
      costUsd: 0.5,
      passes: ["claims"],
      failedPasses: [],
      skippedCandidates: 0,
      scoredCandidates: 1,
      failedCandidates: 0,
      timedOut: false,
    };

    function updateArgs(gh: ReturnType<typeof octokit>) {
      return gh.rest.checks.update.mock.calls[0] as unknown as [
        {
          check_run_id: number;
          conclusion: string;
          output: { title: string; summary: string };
        },
      ];
    }

    it("opens the check on the head commit before the pipeline starts", async () => {
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, { ...request, runUrl }, deps());
      expect(gh.rest.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Review Router AI review",
          head_sha: "abc123",
          status: "in_progress",
          details_url: runUrl,
        })
      );
      expect(gh.rest.checks.create.mock.invocationCallOrder[0]).toBeLessThan(
        (runPipeline as jest.Mock).mock.invocationCallOrder[0]
      );
    });

    it("completes it with success and says so when nothing was found", async () => {
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, request, deps());
      const [args] = updateArgs(gh);
      expect(args.check_run_id).toBe(55);
      expect(args.conclusion).toBe("success");
      expect(args.output.title).toBe("No issues found");
    });

    it("puts the run link first in the completed summary, where the check page shows it", async () => {
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, { ...request, runUrl }, deps());
      expect(updateArgs(gh)[0].output.summary).toBe(
        `[View the workflow run](${runUrl})\n\nThe review is posted on the pull request.`
      );
    });

    it("names the number of findings it posted", async () => {
      (runPipeline as jest.Mock).mockResolvedValue(oneFinding);
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, request, deps());
      expect(updateArgs(gh)[0].output.title).toBe("Found 1 issue");
    });

    it("settles as neutral with the reason when the review could not finish", async () => {
      const failing = deps();
      (failing.tools.install as jest.Mock).mockRejectedValue(new Error("boom"));
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, { ...request, runUrl }, failing);
      const [args] = updateArgs(gh);
      expect(args.conclusion).toBe("neutral");
      expect(args.output.title).toBe("Could not finish");
      expect(args.output.summary).toContain("could not install the review tools");
      expect(args.output.summary.startsWith(`[View the workflow run](${runUrl})`)).toBe(true);
    });

    it("leaves out the failure comment for an automatic run the check already reports", async () => {
      const failing = deps();
      (failing.tools.install as jest.Mock).mockRejectedValue(new Error("boom"));
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, request, failing);
      expect(gh.rest.issues.createComment).not.toHaveBeenCalled();
    });

    it("still posts the failure comment when the person asked with /ai-review", async () => {
      const failing = deps();
      (failing.tools.install as jest.Mock).mockRejectedValue(new Error("boom"));
      const gh = octokit();
      await runAiReview(
        gh as unknown as Octokit,
        { ...request, kind: "comment", commentId: 9, commenterAssociation: "MEMBER" },
        failing
      );
      expect(gh.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(gh.rest.checks.update).toHaveBeenCalledTimes(1);
    });

    it("posts the failure comment when the check could not be opened", async () => {
      const failing = deps();
      (failing.tools.install as jest.Mock).mockRejectedValue(new Error("boom"));
      const gh = octokit();
      gh.rest.checks.create.mockRejectedValue({ status: 403, message: "denied" });
      await runAiReview(gh as unknown as Octokit, request, failing);
      expect(gh.rest.issues.createComment).toHaveBeenCalledTimes(1);
      expect(gh.rest.checks.update).not.toHaveBeenCalled();
    });

    it("still posts the review when the check could not be opened", async () => {
      const gh = octokit();
      gh.rest.checks.create.mockRejectedValue({ status: 403, message: "denied" });
      await runAiReview(gh as unknown as Octokit, request, deps());
      expect(gh.rest.pulls.createReview).toHaveBeenCalledTimes(1);
      expect(gh.rest.checks.update).not.toHaveBeenCalled();
    });

    it("opens no check when the run is skipped by a gate", async () => {
      const gh = octokit();
      await runAiReview(gh as unknown as Octokit, { ...request, aiToken: "" }, deps());
      expect(gh.rest.checks.create).not.toHaveBeenCalled();
    });
  });
});
