import { GATE_CHECK_NAME, hasGateCheck, postGateCheck } from "../../src/gate/check";
import { GateDecision } from "../../src/gate/decide";
import { Octokit } from "../../src/types";

const pass: GateDecision = {
  conclusion: "success",
  reason: "dependabot",
  title: "Dependabot update",
  summary: "ok",
};
const block: GateDecision = {
  conclusion: "action_required",
  reason: "needs-approval",
  title: "Waiting for an approval",
  summary: "needs a person",
};

function fakeOctokit(latest: object[] = []) {
  const create = jest.fn().mockResolvedValue({});
  const listForRef = jest.fn().mockResolvedValue({ data: { check_runs: latest } });
  const octokit = { rest: { checks: { listForRef, create } } } as unknown as Octokit;
  return { octokit, create, listForRef };
}

const run = (conclusion: string, reason: string, status = "completed") => ({
  status,
  conclusion,
  external_id: `rr-gate:${reason}`,
});

describe("postGateCheck", () => {
  it("posts a completed check named for the gate when none exists", async () => {
    const { octokit, create } = fakeOctokit();
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass, "https://run")).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: GATE_CHECK_NAME,
        head_sha: "sha1",
        status: "completed",
        conclusion: "success",
        external_id: "rr-gate:dependabot",
        details_url: "https://run",
        output: { title: "Dependabot update", summary: "ok" },
      })
    );
  });

  it("posts action_required for a decision that waits for a person", async () => {
    const { octokit, create } = fakeOctokit();
    await postGateCheck(octokit, "o", "r", "sha1", block);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ conclusion: "action_required" }));
  });

  it("asks for the latest run of that name only", async () => {
    const { octokit, listForRef } = fakeOctokit();
    await postGateCheck(octokit, "o", "r", "sha1", pass);
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({ check_name: GATE_CHECK_NAME, filter: "latest", ref: "sha1" })
    );
  });

  it("posts nothing when the latest run already shows the same state", async () => {
    const { octokit, create } = fakeOctokit([run("success", "dependabot")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("posts a new run when the conclusion changed", async () => {
    const { octokit, create } = fakeOctokit([run("action_required", "needs-approval")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("posts a new run when the reason changed under the same conclusion", async () => {
    const { octokit, create } = fakeOctokit([run("success", "approved")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("posts a new run over a latest run from another source with the same conclusion", async () => {
    const { octokit, create } = fakeOctokit([
      { status: "completed", conclusion: "success", external_id: "something-else" },
    ]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("posts a new run when a run with the same external id has another conclusion", async () => {
    const { octokit, create } = fakeOctokit([run("failure", "dependabot")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("posts a new run when the latest run is not completed", async () => {
    const { octokit, create } = fakeOctokit([run("success", "dependabot", "in_progress")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("lets a failing GitHub call surface to the caller", async () => {
    const { octokit, create } = fakeOctokit();
    create.mockRejectedValue(new Error("403"));
    await expect(postGateCheck(octokit, "o", "r", "sha1", pass)).rejects.toThrow("403");
  });
});

describe("hasGateCheck", () => {
  it("is true when a gate result exists on the commit", async () => {
    const { octokit } = fakeOctokit([run("success", "approved")]);
    expect(await hasGateCheck(octokit, "o", "r", "sha1")).toBe(true);
  });

  it("is false when the commit has no gate result", async () => {
    const { octokit, listForRef } = fakeOctokit();
    expect(await hasGateCheck(octokit, "o", "r", "sha1")).toBe(false);
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({ check_name: GATE_CHECK_NAME })
    );
  });
});
