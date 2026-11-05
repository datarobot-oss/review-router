import {
  GATE_CHECK_NAME,
  GATE_DOCS_URL,
  hasGateCheck,
  postGateCheck,
  postPendingGateCheck,
} from "../../src/gate/check";
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
        details_url: GATE_DOCS_URL,
        output: {
          title: "Dependabot update",
          summary: `[View the workflow run](https://run)\n\nok\n\n[How the Bouncer works](${GATE_DOCS_URL})`,
        },
      })
    );
  });

  it("links the docs even when there is no workflow run to link", async () => {
    const { octokit, create } = fakeOctokit();
    await postGateCheck(octokit, "o", "r", "sha1", block);
    const args = create.mock.calls[0][0];
    expect(args.details_url).toBe(GATE_DOCS_URL);
    expect(args.output.summary).toBe(`needs a person\n\n[How the Bouncer works](${GATE_DOCS_URL})`);
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

describe("postPendingGateCheck", () => {
  it("posts an in_progress run that links the docs on a commit with no run", async () => {
    const { octokit, create } = fakeOctokit();
    expect(await postPendingGateCheck(octokit, "o", "r", "sha1", "https://run")).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: GATE_CHECK_NAME,
        head_sha: "sha1",
        status: "in_progress",
        details_url: GATE_DOCS_URL,
        output: expect.objectContaining({
          summary: expect.stringContaining(`[How the Bouncer works](${GATE_DOCS_URL})`),
        }),
      })
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty("conclusion");
  });

  it("posts nothing when the commit already has a result, so it never reopens a passing check", async () => {
    const { octokit, create } = fakeOctokit([run("success", "approved")]);
    expect(await postPendingGateCheck(octokit, "o", "r", "sha1")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("posts nothing when a pending run already exists", async () => {
    const { octokit, create } = fakeOctokit([{ status: "in_progress", external_id: "" }]);
    expect(await postPendingGateCheck(octokit, "o", "r", "sha1")).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("hasGateCheck", () => {
  it("is true when a gate result exists on the commit", async () => {
    const { octokit } = fakeOctokit([run("success", "approved")]);
    expect(await hasGateCheck(octokit, "o", "r", "sha1")).toBe(true);
  });

  it("is false when the only run is still pending, because no result stands", async () => {
    const { octokit } = fakeOctokit([{ status: "in_progress", external_id: "" }]);
    expect(await hasGateCheck(octokit, "o", "r", "sha1")).toBe(false);
  });

  it("is false when the commit has no gate result", async () => {
    const { octokit, listForRef } = fakeOctokit();
    expect(await hasGateCheck(octokit, "o", "r", "sha1")).toBe(false);
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({ check_name: GATE_CHECK_NAME })
    );
  });
});
