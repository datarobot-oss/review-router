import * as core from "@actions/core";
import { buildReviewCheck, parseRoutedTeams, upsertReviewCheck } from "../src/checks";

jest.mock("@actions/core");

function checksOctokit(existing: object[] = []) {
  return {
    rest: {
      checks: {
        listForRef: jest.fn().mockResolvedValue({ data: { check_runs: existing } }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      pulls: { listCommits: jest.fn() },
    },
    paginate: jest.fn().mockResolvedValue([]),
  };
}

/** Check runs per ref; any ref not listed has none. */
function checksByRef(octokit: ReturnType<typeof checksOctokit>, byRef: Record<string, object[]>) {
  octokit.rest.checks.listForRef.mockImplementation(async ({ ref }: { ref: string }) => ({
    data: { check_runs: byRef[ref] ?? [] },
  }));
}

const commit = (sha: string) => ({ sha });

describe("buildReviewCheck", () => {
  it("is queued while teams are pending, so it does not read as a running job", () => {
    const check = buildReviewCheck(["a", "b"], ["b"], false);
    expect(check.status).toBe("queued");
    expect(check.conclusion).toBeUndefined();
  });

  it("names one pending team in the singular", () => {
    expect(buildReviewCheck(["a"], ["a"], false).title).toBe("Waiting for approval from 1 team");
  });

  it("names several pending teams in the plural", () => {
    expect(buildReviewCheck(["a", "b"], ["a", "b"], false).title).toBe(
      "Waiting for approval from 2 teams"
    );
  });

  it("completes with success when no team is pending", () => {
    const check = buildReviewCheck(["a", "b"], [], false);
    expect(check.status).toBe("completed");
    expect(check.conclusion).toBe("success");
  });

  it("completes with neutral when the PR is closed", () => {
    const check = buildReviewCheck(["a"], ["a"], true);
    expect(check.status).toBe("completed");
    expect(check.conclusion).toBe("neutral");
  });

  it("makes no approval claim when the PR is closed", () => {
    const { summary } = buildReviewCheck(["a", "b"], ["b"], true);
    expect(summary).not.toContain("Approved");
    expect(summary).toContain("closed");
  });

  it("lists approved and pending teams", () => {
    const { summary } = buildReviewCheck(["a", "b"], ["b"], false);
    expect(summary).toContain("**Approved:** `a`");
    expect(summary).toContain("**Pending:** `b`");
  });
});

describe("parseRoutedTeams", () => {
  it("round-trips the external id", () => {
    expect(parseRoutedTeams(buildReviewCheck(["a", "b"], [], false).externalId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns [] for null, undefined and malformed input", () => {
    expect(parseRoutedTeams(null)).toEqual([]);
    expect(parseRoutedTeams(undefined)).toEqual([]);
    expect(parseRoutedTeams("garbage")).toEqual([]);
  });
});

describe("upsertReviewCheck", () => {
  it("creates a run when none exists", async () => {
    const octokit = checksOctokit();

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["a"]);

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        name: "Review Router",
        head_sha: "abc123",
        status: "queued",
        external_id: "rr:teams=a",
      })
    );
    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });

  it("updates the existing run and keeps previously routed teams", async () => {
    const octokit = checksOctokit([{ id: 7, external_id: "rr:teams=a,b" }]);

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["b"]);

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 7,
        external_id: "rr:teams=a,b",
        output: expect.objectContaining({ summary: expect.stringContaining("**Approved:** `a`") }),
      })
    );
    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
  });

  it("does not throw when the Checks permission is missing (403)", async () => {
    const octokit = checksOctokit();
    octokit.rest.checks.listForRef.mockRejectedValue({ status: 403 });

    await expect(
      upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["a"])
    ).resolves.toBeUndefined();
    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
  });

  it("does not throw when the check run is not found (404)", async () => {
    const octokit = checksOctokit();
    octokit.rest.checks.listForRef.mockRejectedValue({ status: 404 });

    await expect(
      upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["a"])
    ).resolves.toBeUndefined();
  });

  it("logs the API message when it skips on a 403, so a rate limit is not read as a missing permission", async () => {
    const octokit = checksOctokit();
    octokit.rest.checks.listForRef.mockRejectedValue({
      status: 403,
      message: "You have exceeded a secondary rate limit",
    });

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["a"]);

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("You have exceeded a secondary rate limit")
    );
  });

  it("does not throw on a generic error", async () => {
    const octokit = checksOctokit();
    octokit.rest.checks.create.mockRejectedValue(new Error("boom"));

    await expect(
      upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["a"])
    ).resolves.toBeUndefined();
  });

  it("seeds routed teams from the latest earlier commit's check when the head has none", async () => {
    const octokit = checksOctokit();
    octokit.paginate.mockResolvedValue([commit("c1"), commit("c2"), commit("abc123")]);
    checksByRef(octokit, { c1: [{ id: 3, external_id: "rr:teams=a,b" }] });

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["b"]);

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        head_sha: "abc123",
        external_id: "rr:teams=a,b",
        output: expect.objectContaining({ summary: expect.stringContaining("**Approved:** `a`") }),
      })
    );
  });

  it("does not look at earlier commits when the head already has a check", async () => {
    const octokit = checksOctokit([{ id: 7, external_id: "rr:teams=a" }]);

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["a"]);

    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it("routes only the pending teams when no earlier commit has a check", async () => {
    const octokit = checksOctokit();
    octokit.paginate.mockResolvedValue([commit("c1"), commit("abc123")]);

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["b"]);

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: "rr:teams=b" })
    );
  });

  it("still creates the check when listing the PR commits fails", async () => {
    const octokit = checksOctokit();
    octokit.paginate.mockRejectedValue(new Error("boom"));

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["b"]);

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: "rr:teams=b" })
    );
  });

  it("looks back at no more than 10 earlier commits", async () => {
    const octokit = checksOctokit();
    const shas = Array.from({ length: 30 }, (_, i) => `c${i}`);
    octokit.paginate.mockResolvedValue([...shas.map(commit), commit("abc123")]);

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", ["b"]);

    // One lookup for the head plus at most 10 earlier commits.
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledTimes(11);
  });

  it("creates no check for a closed PR that has none", async () => {
    const octokit = checksOctokit();

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", [], true);

    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it("closes an existing check when the PR is closed", async () => {
    const octokit = checksOctokit([{ id: 7, external_id: "rr:teams=a" }]);

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", [], true);

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 7, status: "completed", conclusion: "neutral" })
    );
  });

  it("completes a running check when no team is pending any more", async () => {
    const octokit = checksOctokit([{ id: 7, external_id: "rr:teams=a" }]);

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", []);

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: 7, status: "completed", conclusion: "success" })
    );
  });

  it("creates no check when no team is pending and none exists", async () => {
    const octokit = checksOctokit();

    await upsertReviewCheck(octokit as any, "org", "repo", 5, "abc123", []);

    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
    expect(octokit.paginate).not.toHaveBeenCalled();
  });
});
