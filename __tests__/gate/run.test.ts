import { gateTarget, runGate } from "../../src/gate/run";
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
  it.each(["opened", "reopened", "synchronize", "ready_for_review", "edited"])(
    "evaluates the pull request on %s",
    (action) => {
      const event = { eventName: "pull_request_target", action, payload: { pull_request: pr() } };
      expect(gateTarget(event)).toEqual({ kind: "pull", number: 7, headSha: "evt-sha" });
    }
  );

  it.each(["labeled", "closed", "assigned"])("ignores a pull request %s", (action) => {
    const event = { eventName: "pull_request", action, payload: { pull_request: pr() } };
    expect(gateTarget(event)).toBeNull();
  });

  it.each(["submitted", "dismissed", "edited"])(
    "evaluates the pull request on review %s",
    (action) => {
      const event = { eventName: "pull_request_review", action, payload: { pull_request: pr() } };
      expect(gateTarget(event)?.kind).toBe("pull");
    }
  );

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
      "https://run"
    );
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
      "https://run"
    );
  });

  it("never throws, also when the failure result can't be posted", async () => {
    jest.mocked(collectFacts).mockRejectedValue(new Error("boom"));
    jest.mocked(postGateCheck).mockRejectedValue(new Error("403"));
    await expect(
      runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF)
    ).resolves.toBeUndefined();
  });

  it("never throws when the enrollment can't be read", async () => {
    jest.mocked(loadEnrollment).mockRejectedValue(new Error("server"));
    await expect(
      runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF)
    ).resolves.toBeUndefined();
    expect(postGateCheck).not.toHaveBeenCalled();
  });

  it("replaces an earlier result with a blocking one when the enrollment can't be read", async () => {
    jest.mocked(loadEnrollment).mockRejectedValue(new Error("502"));
    jest.mocked(hasGateCheck).mockResolvedValue(true);
    await runGate(fakeOctokit() as unknown as Octokit, pullEvent(), REF);
    expect(hasGateCheck).toHaveBeenCalledWith(expect.anything(), "o", "r", "evt-sha");
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
      "https://run"
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
      "https://run"
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
      "https://run"
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
      "https://run"
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
      "https://run"
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
      "https://run"
    );
    expect(postGateCheck).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      "h1",
      expect.objectContaining({ conclusion: "action_required" }),
      "https://run"
    );
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
      "https://run"
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
      "https://run"
    );
  });
});
