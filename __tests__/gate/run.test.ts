import { GateEvent, gateTarget, runGate } from "../../src/gate/run";
import { GateAppMismatchError } from "../../src/gate/errors";
import { hasGateCheck, postGateCheck } from "../../src/gate/check";
import { collectFacts, currentHead } from "../../src/gate/facts";
import { loadEnrollment } from "../../src/gate/enroll";
import { GateFacts } from "../../src/gate/decide";
import * as core from "@actions/core";
import { Octokit } from "../../src/types";

jest.mock("@actions/core");
jest.mock("../../src/gate/check");
jest.mock("../../src/gate/facts");
jest.mock("../../src/gate/enroll");

const REF = { owner: "o", repo: "r", runUrl: "https://run" };
const repository = { default_branch: "main" };
const pr = (number = 7) => ({ number, head: { sha: "evt-sha" } });

describe("gateTarget", () => {
  it.each(["opened", "reopened", "synchronize", "ready_for_review"])(
    "evaluates the pull request on %s",
    (action) => {
      const event = { eventName: "pull_request_target", action, payload: { pull_request: pr() } };
      expect(gateTarget(event)).toEqual({ kind: "pull", number: 7, headSha: "evt-sha" });
    }
  );

  it.each(["labeled", "closed", "assigned", "edited"])("ignores a pull request %s", (action) => {
    const event = { eventName: "pull_request", action, payload: { pull_request: pr() } };
    expect(gateTarget(event)).toBeNull();
  });

  it.each(["submitted", "dismissed"])("evaluates the pull request on review %s", (action) => {
    const event = { eventName: "pull_request_review", action, payload: { pull_request: pr() } };
    expect(gateTarget(event)?.kind).toBe("pull");
  });

  it("ignores an edited review, which never changes an approval or a change request", () => {
    const event = {
      eventName: "pull_request_review",
      action: "edited",
      payload: { pull_request: pr() },
    };
    expect(gateTarget(event)).toBeNull();
  });

  describe("a workflow_run of the trigger workflow", () => {
    const workflowRun = (
      run: NonNullable<GateEvent["payload"]["workflow_run"]>,
      action = "completed"
    ) => ({
      eventName: "workflow_run",
      action,
      payload: { workflow_run: run },
    });

    it("evaluates the merge queue commit and reads the pull request from the queue branch", () => {
      const event = workflowRun({
        event: "merge_group",
        head_sha: "q1",
        head_branch: "gh-readonly-queue/main/pr-44-abc123",
      });
      expect(gateTarget(event)).toEqual({ kind: "queue", number: 44, sha: "q1" });
    });

    it("reads no number from a queue branch it can't parse, so the entry fails closed", () => {
      const event = workflowRun({ event: "merge_group", head_sha: "q1", head_branch: "feature" });
      expect(gateTarget(event)).toEqual({ kind: "queue", number: undefined, sha: "q1" });
    });

    it("evaluates the pull requests at the head commit after a review, and ignores the branch name", () => {
      const event = workflowRun({
        event: "pull_request_review",
        head_sha: "s1",
        head_branch: "gh-readonly-queue/main/pr-1-abc",
      });
      expect(gateTarget(event)).toEqual({ kind: "commit", sha: "s1" });
    });

    it.each(["push", "pull_request", "workflow_dispatch"])(
      "ignores a run started by %s, which a writer can make on a branch",
      (runEvent) => {
        const event = workflowRun({ event: runEvent, head_sha: "s1", head_branch: "x" });
        expect(gateTarget(event)).toBeNull();
      }
    );

    it("ignores a run that hasn't completed", () => {
      const event = workflowRun({ event: "pull_request_review", head_sha: "s1" }, "requested");
      expect(gateTarget(event)).toBeNull();
    });

    it("ignores an event with no run in the payload", () => {
      expect(
        gateTarget({ eventName: "workflow_run", action: "completed", payload: {} })
      ).toBeNull();
    });
  });

  it("sweeps every open pull request on a schedule", () => {
    expect(gateTarget({ eventName: "schedule", payload: {} })).toEqual({ kind: "sweep" });
  });

  it("reads the pull request number from a merge queue branch", () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        merge_group: { head_sha: "q1", head_ref: "refs/heads/gh-readonly-queue/main/pr-44-abc123" },
      },
    };
    expect(gateTarget(event)).toEqual({ kind: "queue", number: 44, sha: "q1" });
  });

  it("reads a pull request number from a base branch that contains slashes", () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        merge_group: {
          head_sha: "q1",
          head_ref: "refs/heads/gh-readonly-queue/release/1.x/pr-9-def456",
        },
      },
    };
    expect(gateTarget(event)).toMatchObject({ number: 9 });
  });

  it("keeps a queue entry with an unreadable branch name, with no pull request number", () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: { merge_group: { head_sha: "q1", head_ref: "refs/heads/other" } },
    };
    expect(gateTarget(event)).toEqual({ kind: "queue", number: undefined, sha: "q1" });
  });

  it("ignores a merge group that was destroyed", () => {
    const event = {
      eventName: "merge_group",
      action: "destroyed",
      payload: { merge_group: { head_sha: "q1", head_ref: "refs/heads/x" } },
    };
    expect(gateTarget(event)).toBeNull();
  });

  it("ignores events it does not know", () => {
    expect(gateTarget({ eventName: "issue_comment", action: "created", payload: {} })).toBeNull();
  });
});

const humanFacts: GateFacts = {
  author: "alice",
  authorType: "User",
  isFork: false,
  headRef: "alice/x",
  headSha: "h1",
  files: ["a.txt"],
  changedFileCount: 1,
  pushers: ["alice"],
  commits: [],
  dependencies: [],
  reviews: [],
};

function fakeOctokit(pulls: object[] = []) {
  return {
    rest: {
      pulls: { list: Symbol("list") },
      repos: { get: jest.fn().mockResolvedValue({ data: { default_branch: "main" } }) },
    },
    paginate: jest.fn().mockResolvedValue(pulls),
  };
}

const found = (over: object = {}) => ({
  facts: humanFacts,
  baseRef: "main",
  state: "open",
  ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(loadEnrollment).mockResolvedValue({ policy: {} });
  jest.mocked(collectFacts).mockResolvedValue(found());
  jest.mocked(currentHead).mockResolvedValue("h1");
  jest.mocked(postGateCheck).mockResolvedValue(true);
});

const pullEvent = (action = "opened") => ({
  eventName: "pull_request_target",
  action,
  payload: { pull_request: pr(), repository },
});

describe("runGate", () => {
  it("posts a blocking result for a pull request nobody approved", async () => {
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "h1",
      expect.objectContaining({ conclusion: "action_required" }),
      "https://run",
      undefined
    );
  });

  it("posts a pull request that waits for an approval as pending", async () => {
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "h1",
      expect.objectContaining({ reason: "needs-approval", pending: true }),
      "https://run",
      undefined
    );
  });

  it("posts the same wait on a queue entry as action_required, so the queue fails it at once", async () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        repository,
        merge_group: { head_sha: "q1", head_ref: "refs/heads/gh-readonly-queue/main/pr-44-abc" },
      },
    };
    await runGate(fakeOctokit() as unknown as Octokit, event, REF);
    const decision = jest.mocked(postGateCheck).mock.calls[0][4];
    expect(decision).toEqual(expect.objectContaining({ conclusion: "action_required" }));
    expect(decision).not.toHaveProperty("pending");
  });

  it("does not mark a failure to read the pull request as pending", async () => {
    jest.mocked(collectFacts).mockRejectedValue(new Error("rate limited"));
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    const decision = jest.mocked(postGateCheck).mock.calls[0][4];
    expect(decision).toEqual(
      expect.objectContaining({ conclusion: "action_required", reason: "error" })
    );
    expect(decision).not.toHaveProperty("pending");
  });

  it("does nothing for a repository that is not enrolled", async () => {
    jest.mocked(loadEnrollment).mockResolvedValue(null);
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(collectFacts).not.toHaveBeenCalled();
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("does nothing for an event it ignores, and reads nothing", async () => {
    const event = { eventName: "issue_comment", action: "created", payload: {} };
    await runGate(fakeOctokit() as unknown as Octokit, event, REF);
    expect(loadEnrollment).not.toHaveBeenCalled();
  });

  it("asks for compatibility scores only when the policy uses them", async () => {
    const withScores = { policy: { dependabot: { usesCompatibility: true } } };
    jest.mocked(loadEnrollment).mockResolvedValue(withScores as never);
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(collectFacts).toHaveBeenLastCalledWith(expect.anything(), "o", "r", 7, {
      fetchCompatibility: true,
    });

    const withoutScores = { policy: { dependabot: { usesCompatibility: false } } };
    jest.mocked(loadEnrollment).mockResolvedValue(withoutScores as never);
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(collectFacts).toHaveBeenLastCalledWith(expect.anything(), "o", "r", 7, {
      fetchCompatibility: false,
    });

    jest.mocked(loadEnrollment).mockResolvedValue({ policy: {} });
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(collectFacts).toHaveBeenLastCalledWith(expect.anything(), "o", "r", 7, {
      fetchCompatibility: false,
    });
  });

  it("skips a pull request for another base branch", async () => {
    jest.mocked(collectFacts).mockResolvedValue(found({ baseRef: "release" }));
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("skips a pull request that is no longer open", async () => {
    jest.mocked(collectFacts).mockResolvedValue(found({ state: "closed" }));
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("posts nothing when the head moved during the evaluation", async () => {
    jest.mocked(currentHead).mockResolvedValue("newer");
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("fails closed on the event's commit when reading the pull request fails", async () => {
    jest.mocked(collectFacts).mockRejectedValue(new Error("rate limited"));
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "evt-sha",
      expect.objectContaining({
        conclusion: "action_required",
        summary: expect.stringContaining("rate limited"),
      }),
      "https://run",
      undefined
    );
  });

  it("never throws, also when the failure result can't be posted", async () => {
    jest.mocked(collectFacts).mockRejectedValue(new Error("boom"));
    jest.mocked(postGateCheck).mockRejectedValue(new Error("403"));
    await expect(
      runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF)
    ).resolves.toBeNull();
  });

  it("never throws when the enrollment can't be read", async () => {
    jest.mocked(loadEnrollment).mockRejectedValue(new Error("server"));
    await expect(
      runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF)
    ).resolves.toBeNull();
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("replaces an earlier result with a blocking one when the enrollment can't be read", async () => {
    jest.mocked(loadEnrollment).mockRejectedValue(new Error("502"));
    jest.mocked(hasGateCheck).mockResolvedValue(true);
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(hasGateCheck).toHaveBeenCalledWith(expect.anything(), "o", "r", "evt-sha", undefined);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("502"));
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "evt-sha",
      expect.objectContaining({
        conclusion: "action_required",
        summary: expect.stringContaining("502"),
      }),
      "https://run",
      undefined
    );
  });

  it("opens no result in a repository that never had one when the enrollment can't be read", async () => {
    jest.mocked(loadEnrollment).mockRejectedValue(new Error("502"));
    jest.mocked(hasGateCheck).mockResolvedValue(false);
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).not.toHaveBeenCalled();

    expect(core.warning).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("502"));
  });

  it("replaces an earlier result when the default branch can't be read", async () => {
    const octokit = fakeOctokit();
    octokit.rest.repos.get.mockRejectedValue(new Error("502"));
    jest.mocked(hasGateCheck).mockResolvedValue(true);
    const event = { ...pullEvent(), payload: { pull_request: pr() } };
    await runGate(octokit as unknown as Octokit, event, REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "evt-sha",
      expect.objectContaining({ conclusion: "action_required" }),
      "https://run",
      undefined
    );
  });

  it("replaces an earlier result on a queue entry when the enrollment can't be read", async () => {
    jest.mocked(loadEnrollment).mockRejectedValue(new Error("502"));
    jest.mocked(hasGateCheck).mockResolvedValue(true);
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        repository,
        merge_group: { head_sha: "q1", head_ref: "refs/heads/gh-readonly-queue/main/pr-44-abc" },
      },
    };
    await runGate(fakeOctokit() as unknown as Octokit, event, REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "q1",
      expect.objectContaining({ conclusion: "action_required" }),
      "https://run",
      undefined
    );
  });

  it("posts nothing for a queue entry whose pull request targets another branch", async () => {
    jest.mocked(collectFacts).mockResolvedValue(found({ baseRef: "release" }));
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        repository,
        merge_group: { head_sha: "q1", head_ref: "refs/heads/gh-readonly-queue/release/pr-44-abc" },
      },
    };
    await runGate(fakeOctokit() as unknown as Octokit, event, REF);
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("falls back to the repository's default branch when the payload has none", async () => {
    const octokit = fakeOctokit();
    const event = { ...pullEvent(), payload: { pull_request: pr() } };
    await runGate(octokit as unknown as Octokit, event, REF);
    expect(octokit.rest.repos.get).toHaveBeenCalled();
    expect(postGateCheck).toHaveBeenCalled();
  });

  it("posts a queue entry's result on the queue's commit", async () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        repository,
        merge_group: { head_sha: "q1", head_ref: "refs/heads/gh-readonly-queue/main/pr-44-abc" },
      },
    };
    await runGate(fakeOctokit() as unknown as Octokit, event, REF);
    expect(collectFacts).toHaveBeenCalledWith(expect.anything(), "o", "r", 44, expect.anything());
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "q1",
      expect.anything(),
      "https://run",
      undefined
    );
    expect(currentHead).not.toHaveBeenCalled();
  });

  it("blocks a queue entry whose pull request can't be identified", async () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: { repository, merge_group: { head_sha: "q1", head_ref: "refs/heads/other" } },
    };
    await runGate(fakeOctokit() as unknown as Octokit, event, REF);
    expect(collectFacts).not.toHaveBeenCalled();
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "q1",
      expect.objectContaining({ conclusion: "action_required" }),
      "https://run",
      undefined
    );
  });

  it("sweeps every open pull request on a schedule and isolates a failing one", async () => {
    const octokit = fakeOctokit([
      { number: 1, head: { sha: "s1" } },
      { number: 2, head: { sha: "s2" } },
    ]);
    jest
      .mocked(collectFacts)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(found());
    await runGate(
      octokit as unknown as Octokit,
      { eventName: "schedule", payload: { repository } },
      REF
    );
    expect(collectFacts).toHaveBeenCalledTimes(2);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "s1",
      expect.objectContaining({ title: "The gate could not decide" }),
      "https://run",
      undefined
    );
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "h1",
      expect.objectContaining({ conclusion: "action_required" }),
      "https://run",
      undefined
    );
  });

  it("logs how many open pull requests a sweep covers", async () => {
    const octokit = fakeOctokit([
      { number: 1, head: { sha: "s1" } },
      { number: 2, head: { sha: "s2" } },
      { number: 3, head: { sha: "s3" } },
    ]);
    await runGate(
      octokit as unknown as Octokit,
      { eventName: "schedule", payload: { repository } },
      REF
    );
    expect(core.info).toHaveBeenCalledWith("Gate sweep: 3 open pull requests.");
  });

  describe("reporting what a sweep decided", () => {
    const sweepEvent = { eventName: "schedule", payload: { repository } };
    const dependabotPull = {
      number: 1,
      head: { sha: "s1" },
      user: { login: "dependabot[bot]" },
      labels: [{ name: "dependencies" }],
    };

    it("hands each decision to the caller with the pull request's author and labels", async () => {
      const seen: unknown[] = [];
      await runGate(fakeOctokit([dependabotPull]) as unknown as Octokit, sweepEvent, REF, (swept) =>
        seen.push(swept)
      );
      expect(seen).toEqual([
        {
          number: 1,
          author: "dependabot[bot]",
          labels: ["dependencies"],
          decision: expect.objectContaining({ reason: "needs-approval" }),
        },
      ]);
    });

    it("hands over nothing for a pull request the gate could not decide", async () => {
      jest.mocked(collectFacts).mockRejectedValueOnce(new Error("boom"));
      const seen: unknown[] = [];
      await runGate(fakeOctokit([dependabotPull]) as unknown as Octokit, sweepEvent, REF, (swept) =>
        seen.push(swept)
      );
      expect(seen).toEqual([]);
    });

    it("reports an empty author for a pull request whose account is gone", async () => {
      const seen: Array<{ author: string }> = [];
      await runGate(
        fakeOctokit([{ ...dependabotPull, user: null }]) as unknown as Octokit,
        sweepEvent,
        REF,
        (swept) => seen.push(swept)
      );
      expect(seen[0].author).toBe("");
    });
  });

  describe("after a review reaches the gate through workflow_run", () => {
    const reviewRun = {
      eventName: "workflow_run",
      action: "completed",
      payload: {
        repository,
        workflow_run: { event: "pull_request_review", head_sha: "s1", head_branch: "feature" },
      },
    };
    const open = (number: number, over: object = {}) => ({
      number,
      state: "open",
      base: { ref: "main" },
      head: { sha: "s1" },
      ...over,
    });
    const octokitFinding = (associated: object[], scanned: object[] = []) => {
      const octokit = fakeOctokit();
      octokit.rest.pulls.list = Symbol("pulls.list") as never;
      (octokit.rest as Record<string, unknown>).repos = {
        ...octokit.rest.repos,
        listPullRequestsAssociatedWithCommit: Symbol("associated"),
      };
      octokit.paginate.mockResolvedValueOnce(associated).mockResolvedValueOnce(scanned);
      return octokit;
    };
    const evaluated = () => jest.mocked(collectFacts).mock.calls.map((call) => call[3]);

    it("evaluates an open pull request whose head is the reviewed commit", async () => {
      await runGate(octokitFinding([open(7)]) as unknown as Octokit, reviewRun, REF);
      expect(evaluated()).toEqual([7]);
      expect(postGateCheck).toHaveBeenCalledTimes(1);
    });

    it("skips a pull request that is closed, targets another branch, or whose head moved", async () => {
      const associated = [
        open(7),
        open(8, { state: "closed" }),
        open(9, { base: { ref: "release" } }),
        open(10, { head: { sha: "newer" } }),
      ];
      await runGate(octokitFinding(associated) as unknown as Octokit, reviewRun, REF);
      expect(evaluated()).toEqual([7]);
    });

    it("evaluates each pull request that shares the commit", async () => {
      await runGate(octokitFinding([open(7), open(11)]) as unknown as Octokit, reviewRun, REF);
      expect(evaluated()).toEqual([7, 11]);
    });

    it("scans the open pull requests when the commit has no association, as for a fork", async () => {
      await runGate(octokitFinding([], [open(12)]) as unknown as Octokit, reviewRun, REF);
      expect(evaluated()).toEqual([12]);
    });

    it("evaluates nothing when no open pull request has that head", async () => {
      await runGate(
        octokitFinding([], [open(13, { head: { sha: "other" } })]) as unknown as Octokit,
        reviewRun,
        REF
      );
      expect(collectFacts).not.toHaveBeenCalled();
      expect(postGateCheck).not.toHaveBeenCalled();
    });

    it("replaces an earlier result with a blocking one when the pull requests can't be listed", async () => {
      const octokit = octokitFinding([]);
      octokit.paginate.mockReset().mockRejectedValue(new Error("502"));
      jest.mocked(hasGateCheck).mockResolvedValue(true);
      await runGate(octokit as unknown as Octokit, reviewRun, REF);
      expect(postGateCheck).toHaveBeenCalledWith(
        expect.anything(),
        "o",
        "r",
        "s1",
        expect.objectContaining({
          conclusion: "action_required",
          summary: expect.stringContaining("502"),
        }),
        "https://run",
        undefined
      );
    });
  });

  describe("under the gate's own App", () => {
    const ownRef = { ...REF, appId: 4242 };

    it("posts only against that App's earlier results", async () => {
      await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), ownRef);
      expect(postGateCheck).toHaveBeenCalledWith(
        expect.anything(),
        "o",
        "r",
        "h1",
        expect.anything(),
        "https://run",
        4242
      );
    });

    it("fails the job when the token's App is not the one named, and posts nothing more", async () => {
      jest.mocked(postGateCheck).mockRejectedValue(new GateAppMismatchError(4242, 999));
      await expect(
        runGate(fakeOctokit() as unknown as Octokit, pullEvent(), ownRef)
      ).resolves.toBeNull();
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("App 999"));
      expect(postGateCheck).toHaveBeenCalledTimes(1);
    });

    it("leaves the job green when the gate fails for another reason", async () => {
      jest.mocked(collectFacts).mockRejectedValue(new Error("boom"));
      await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), ownRef);
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    it("looks for an earlier result of that App only, when it fails closed", async () => {
      jest.mocked(loadEnrollment).mockRejectedValue(new Error("502"));
      jest.mocked(hasGateCheck).mockResolvedValue(true);
      await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), ownRef);
      expect(hasGateCheck).toHaveBeenCalledWith(expect.anything(), "o", "r", "evt-sha", 4242);
      expect(postGateCheck).toHaveBeenCalledWith(
        expect.anything(),
        "o",
        "r",
        "evt-sha",
        expect.objectContaining({ conclusion: "action_required" }),
        "https://run",
        4242
      );
    });
  });

  describe("sweep budget", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const manyPulls = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        number: index + 1,
        head: { sha: `s${index + 1}` },
      }));
    const sweepEvent = { eventName: "schedule", payload: { repository } };
    const withQuota = (pulls: object[], get: jest.Mock) => {
      const base = fakeOctokit(pulls);
      return {
        ...base,
        rest: { ...base.rest, rateLimit: { get } },
      } as unknown as Octokit;
    };
    const quota = (remaining: number) =>
      jest.fn().mockResolvedValue({ data: { resources: { core: { remaining, limit: 1000 } } } });
    const evaluated = () =>
      jest.mocked(collectFacts).mock.calls.map((call) => call[3] as unknown as number);

    afterEach(() => jest.useRealTimers());

    it("stops after a batch when the budget runs low and says how far it got", async () => {
      const get = quota(100);
      await runGate(withQuota(manyPulls(60), get), sweepEvent, REF);
      expect(collectFacts).toHaveBeenCalledTimes(25);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("stopped after 25 of 60 open pull requests")
      );
    });

    it("sweeps every pull request while the budget holds", async () => {
      await runGate(withQuota(manyPulls(60), quota(900)), sweepEvent, REF);
      expect(collectFacts).toHaveBeenCalledTimes(60);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it("sweeps on when the budget can't be read", async () => {
      const get = jest.fn().mockRejectedValue(new Error("403"));
      await runGate(withQuota(manyPulls(60), get), sweepEvent, REF);
      expect(collectFacts).toHaveBeenCalledTimes(60);
    });

    it("starts each hour one batch further along, so a stopped sweep does not starve the tail", async () => {
      jest.useFakeTimers({ now: HOUR_MS });
      await runGate(withQuota(manyPulls(60), quota(900)), sweepEvent, REF);
      expect(evaluated().slice(0, 3)).toEqual([26, 27, 28]);
      expect(evaluated()).toHaveLength(60);
      expect(new Set(evaluated()).size).toBe(60);
    });
  });

  it("explains an invalid policy file on a blocking result", async () => {
    jest.mocked(loadEnrollment).mockResolvedValue({ policy: {}, policyError: "bad yaml" });
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "h1",
      expect.objectContaining({ summary: expect.stringContaining("bad yaml") }),
      "https://run",
      undefined
    );
  });

  it("passes an approved pull request even when the policy file is invalid", async () => {
    jest.mocked(loadEnrollment).mockResolvedValue({ policy: {}, policyError: "bad yaml" });
    jest.mocked(collectFacts).mockResolvedValue(
      found({
        facts: {
          ...humanFacts,
          reviews: [
            { user: "bob", userType: "User", state: "APPROVED", commitId: "h1", canWrite: true },
          ],
        },
      })
    );
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "h1",
      expect.objectContaining({
        conclusion: "success",
        summary: "@bob approved the current commit.",
      }),
      "https://run",
      undefined
    );
  });
});

describe("the decision runGate returns", () => {
  const approval = {
    user: "bob",
    userType: "User",
    state: "APPROVED",
    commitId: "h1",
    canWrite: true,
  };
  const octokit = () => fakeOctokit() as unknown as Octokit;

  it("returns the success of a pull request an independent writer approved", async () => {
    jest
      .mocked(collectFacts)
      .mockResolvedValue(found({ facts: { ...humanFacts, reviews: [approval] } }));
    const decision = await runGate(octokit(), pullEvent(), REF);
    expect(decision).toEqual(
      expect.objectContaining({ conclusion: "success", reason: "approved" })
    );
  });

  it("returns the pending wait of a pull request nobody approved", async () => {
    const decision = await runGate(octokit(), pullEvent(), REF);
    expect(decision).toEqual(
      expect.objectContaining({
        conclusion: "action_required",
        reason: "needs-approval",
        pending: true,
      })
    );
  });

  it("returns nothing for a repository that is not enrolled", async () => {
    jest.mocked(loadEnrollment).mockResolvedValue(null);
    expect(await runGate(octokit(), pullEvent(), REF)).toBeNull();
  });

  it("returns nothing for an event it ignores", async () => {
    const event = { eventName: "issue_comment", action: "created", payload: {} };
    expect(await runGate(octokit(), event, REF)).toBeNull();
  });

  it("returns nothing when reading the pull request fails, so the caller keeps its default", async () => {
    jest.mocked(collectFacts).mockRejectedValue(new Error("rate limited"));
    expect(await runGate(octokit(), pullEvent(), REF)).toBeNull();
  });

  it("returns nothing when the head moved during the evaluation", async () => {
    jest.mocked(currentHead).mockResolvedValue("newer");
    expect(await runGate(octokit(), pullEvent(), REF)).toBeNull();
  });

  it("returns nothing for a pull request that is no longer open", async () => {
    jest.mocked(collectFacts).mockResolvedValue(found({ state: "closed" }));
    expect(await runGate(octokit(), pullEvent(), REF)).toBeNull();
  });

  it("returns nothing for a merge queue entry, which no event handler uses", async () => {
    const event = {
      eventName: "merge_group",
      action: "checks_requested",
      payload: {
        repository,
        merge_group: { head_sha: "q1", head_ref: "refs/heads/gh-readonly-queue/main/pr-44-abc" },
      },
    };
    expect(await runGate(octokit(), event, REF)).toBeNull();
  });
});
