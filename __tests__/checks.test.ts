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
    },
  };
}

describe("buildReviewCheck", () => {
  it("is in_progress while teams are pending", () => {
    const check = buildReviewCheck(["a", "b"], ["b"], false);
    expect(check.status).toBe("in_progress");
    expect(check.conclusion).toBeUndefined();
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

    await upsertReviewCheck(octokit as any, "org", "repo", "abc123", ["a"]);

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        name: "Review Router",
        head_sha: "abc123",
        status: "in_progress",
        external_id: "rr:teams=a",
      })
    );
    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });

  it("updates the existing run and keeps previously routed teams", async () => {
    const octokit = checksOctokit([{ id: 7, external_id: "rr:teams=a,b" }]);

    await upsertReviewCheck(octokit as any, "org", "repo", "abc123", ["b"]);

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
      upsertReviewCheck(octokit as any, "org", "repo", "abc123", ["a"])
    ).resolves.toBeUndefined();
    expect(octokit.rest.checks.create).not.toHaveBeenCalled();
  });

  it("does not throw on a generic error", async () => {
    const octokit = checksOctokit();
    octokit.rest.checks.create.mockRejectedValue(new Error("boom"));

    await expect(
      upsertReviewCheck(octokit as any, "org", "repo", "abc123", ["a"])
    ).resolves.toBeUndefined();
  });
});
