import { GATE_CHECK_NAME, GATE_DOCS_URL, hasGateCheck, postGateCheck } from "../../src/gate/check";
import { GateDecision } from "../../src/gate/decide";
import { GateAppMismatchError } from "../../src/gate/errors";
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
  const create = jest.fn().mockResolvedValue({ data: { app: { id: 4242 } } });
  const listForRef = jest.fn().mockResolvedValue({ data: { check_runs: latest } });
  const octokit = { rest: { checks: { listForRef, create } } } as unknown as Octokit;
  return { octokit, create, listForRef };
}

const run = (
  conclusion: string | null,
  reason: string,
  status = "completed",
  prefix = "rr-gate:"
) => ({
  status,
  conclusion,
  external_id: `${prefix}${reason}`,
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

describe("postGateCheck with a decision that only waits for a person", () => {
  const waiting: GateDecision = { ...block, pending: true };

  it("posts a pending run that has no conclusion, so the pull request shows a yellow dot", async () => {
    const { octokit, create } = fakeOctokit();
    expect(await postGateCheck(octokit, "o", "r", "sha1", waiting, "https://run")).toBe(true);
    const args = create.mock.calls[0][0];
    expect(args).toEqual(
      expect.objectContaining({
        name: GATE_CHECK_NAME,
        head_sha: "sha1",
        status: "in_progress",
        external_id: "rr-gate:needs-approval",
        details_url: GATE_DOCS_URL,
        output: expect.objectContaining({ title: "Waiting for an approval" }),
      })
    );
    expect(args).not.toHaveProperty("conclusion");
  });

  it("posts nothing when the latest run is the same pending run", async () => {
    const { octokit, create } = fakeOctokit([run(null, "needs-approval", "in_progress")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", waiting)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("replaces an earlier action_required of the same reason with the pending run", async () => {
    const { octokit, create } = fakeOctokit([run("action_required", "needs-approval")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", waiting)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending run of another reason", async () => {
    const { octokit, create } = fakeOctokit([run(null, "error", "in_progress")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", waiting)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending run with the result once a person approves", async () => {
    const { octokit, create } = fakeOctokit([run(null, "needs-approval", "in_progress")]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("keeps a decision that is not marked pending as a completed action_required", async () => {
    const { octokit, create } = fakeOctokit();
    await postGateCheck(octokit, "o", "r", "sha1", { ...block, reason: "changes-requested" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", conclusion: "action_required" })
    );
  });
});

describe("when the gate runs under its own App", () => {
  /** A fake that, like GitHub, hides runs of other Apps once the call names an app_id. */
  function octokitWithOtherAppRun(otherAppRun: object) {
    const create = jest.fn().mockResolvedValue({ data: { app: { id: 4242 } } });
    const listForRef = jest.fn(async (params: { app_id?: number }) => ({
      data: { check_runs: params.app_id === undefined ? [otherAppRun] : [] },
    }));
    const octokit = { rest: { checks: { listForRef, create } } } as unknown as Octokit;
    return { octokit, create, listForRef };
  }

  it("reads only runs of that App when it posts", async () => {
    const { octokit, listForRef } = fakeOctokit();
    await postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242);
    expect(listForRef).toHaveBeenCalledWith(expect.objectContaining({ app_id: 4242 }));
  });

  it("posts when another App already shows the same result, which must not count as its own", async () => {
    const { octokit, create } = octokitWithOtherAppRun(run("success", "dependabot"));
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242)).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("still skips a repeat of its own result", async () => {
    const { octokit, create } = fakeOctokit([
      run("success", "dependabot", "completed", "rr-gate-app:"),
    ]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("marks its runs as the gate App's, so a Router that names no App doesn't mistake them for its own", async () => {
    const { octokit, create } = fakeOctokit();
    await postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: "rr-gate-app:dependabot" })
    );
  });

  it("posts its own result when the latest run is the gate App's with the same state", async () => {
    const { octokit, create } = fakeOctokit([
      run("success", "dependabot", "completed", "rr-gate-app:"),
    ]);
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: "rr-gate:dependabot" })
    );
  });

  it("names no App when none is given, so the latest run of any App counts", async () => {
    const { octokit, listForRef } = octokitWithOtherAppRun(run("success", "dependabot"));
    expect(await postGateCheck(octokit, "o", "r", "sha1", pass)).toBe(false);
    expect(listForRef.mock.calls[0][0]).not.toHaveProperty("app_id");
  });

  it("throws when the check was created by another App than the one named", async () => {
    const { octokit, create } = fakeOctokit();
    create.mockResolvedValue({ data: { app: { id: 999 } } });
    await expect(postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242)).rejects.toThrow(
      /gate-app-id is 4242.*App 999/
    );
  });

  it("throws when the created check names no App, which can't be shown to match", async () => {
    const { octokit, create } = fakeOctokit();
    create.mockResolvedValue({ data: {} });
    await expect(postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242)).rejects.toThrow(
      GateAppMismatchError
    );
  });

  it("accepts a check created by the App named", async () => {
    const { octokit } = fakeOctokit();
    await expect(postGateCheck(octokit, "o", "r", "sha1", pass, undefined, 4242)).resolves.toBe(
      true
    );
  });

  it("compares nothing when no App is named", async () => {
    const { octokit, create } = fakeOctokit();
    create.mockResolvedValue({ data: { app: { id: 999 } } });
    await expect(postGateCheck(octokit, "o", "r", "sha1", pass)).resolves.toBe(true);
  });

  it("finds a result on a commit only among runs of that App", async () => {
    const { octokit } = octokitWithOtherAppRun(run("success", "approved"));
    expect(await hasGateCheck(octokit, "o", "r", "sha1", 4242)).toBe(false);
    expect(await hasGateCheck(octokit, "o", "r", "sha1")).toBe(true);
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
