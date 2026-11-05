import * as core from "@actions/core";

jest.mock("@actions/core");
jest.mock("@actions/github", () => ({
  context: mockContext,
  getOctokit: jest.fn(() => ({})),
}));
jest.mock("../src/router");
jest.mock("../src/config");
jest.mock("../src/auth");
jest.mock("../src/reminders");
jest.mock("../src/reconcile");
jest.mock("../src/ai-review");
jest.mock("../src/gate/run");

const mockContext = {
  eventName: "pull_request_target",
  repo: { owner: "acme", repo: "api" },
  serverUrl: "https://github.com",
  runId: 1,
  payload: {} as Record<string, unknown>,
};

const teamsConfig = { teams: {} };

/** Loads the action entry point, which runs on import, and waits for it to finish. */
async function runAction(
  action: string,
  options: { token?: string } = {}
): Promise<jest.Mocked<typeof import("../src/router")>> {
  jest.resetModules();
  const coreMock = jest.requireMock<jest.Mocked<typeof core>>("@actions/core");
  coreMock.getInput.mockImplementation((name: string) =>
    name === "github-token" ? (options.token ?? "tok") : ""
  );
  mockContext.payload = {
    action,
    pull_request: { number: 7, head: { sha: "newhead" }, base: { ref: "main" } },
  };
  const router = jest.requireMock<jest.Mocked<typeof import("../src/router")>>("../src/router");
  jest
    .requireMock<jest.Mocked<typeof import("../src/config")>>("../src/config")
    .loadTeamsConfigForOrg.mockResolvedValue(teamsConfig as never);
  await import("../src/index");
  await new Promise((resolve) => setImmediate(resolve));
  return router;
}

describe("pull request events that change the head commit", () => {
  it.each(["synchronize", "reopened"])(
    "refreshes the Review Router check on the new head after %s",
    async (action) => {
      const router = await runAction(action);
      expect(router.syncReviewCheck).toHaveBeenCalledTimes(1);
      expect(router.syncReviewCheck).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          owner: "acme",
          repo: "api",
          prNumber: 7,
          headSha: "newhead",
          teamsConfig,
        })
      );
    }
  );

  it("still reaches the existing handlers, so the harness is not vacuous", async () => {
    const router = await runAction("ready_for_review");
    expect(router.handleReadyForReview).toHaveBeenCalledTimes(1);
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });

  it("leaves the check alone for an unrelated PR action", async () => {
    const router = await runAction("edited");
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });

  it("does nothing without a token, as on a fork PR run with no secrets", async () => {
    const router = await runAction("synchronize", { token: "" });
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });
});

describe("the gate", () => {
  async function runEvent(eventName: string, action: string) {
    mockContext.eventName = eventName;
    try {
      const router = await runAction(action);
      const gate =
        jest.requireMock<jest.Mocked<typeof import("../src/gate/run")>>("../src/gate/run");
      return { router, gate };
    } finally {
      mockContext.eventName = "pull_request_target";
    }
  }

  it("runs on a pull request event, before the Review Router handles it", async () => {
    const { router, gate } = await runEvent("pull_request_target", "synchronize");
    expect(gate.runGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventName: "pull_request_target", action: "synchronize" }),
      expect.objectContaining({ owner: "acme", repo: "api" })
    );
    expect(router.syncReviewCheck).toHaveBeenCalledTimes(1);
  });

  it("is the only work for a merge queue event", async () => {
    const { router, gate } = await runEvent("merge_group", "checks_requested");
    expect(gate.runGate).toHaveBeenCalledTimes(1);
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });
});

describe("scheduled runs", () => {
  function octokitWith(quota?: { remaining: number; limit: number }, policy?: string) {
    return {
      rest: {
        ...(quota
          ? { rateLimit: { get: jest.fn(async () => ({ data: { resources: { core: quota } } })) } }
          : {}),
        repos: {
          getContent: jest.fn(async () => {
            if (policy === undefined) throw Object.assign(new Error("none"), { status: 404 });
            return { data: { type: "file", content: Buffer.from(policy).toString("base64") } };
          }),
        },
      },
    };
  }

  async function runSchedule(octokit: ReturnType<typeof octokitWith>) {
    mockContext.eventName = "schedule";
    try {
      jest.resetModules();
      const coreMock = jest.requireMock<jest.Mocked<typeof core>>("@actions/core");
      coreMock.getInput.mockImplementation((name: string) =>
        name === "github-token" ? "tok" : ""
      );
      mockContext.payload = { repository: { default_branch: "trunk" } };
      jest
        .requireMock<jest.Mocked<typeof import("../src/config")>>("../src/config")
        .loadTeamsConfigForOrg.mockResolvedValue(teamsConfig as never);
      jest
        .requireMock<{ getOctokit: jest.Mock }>("@actions/github")
        .getOctokit.mockReturnValue(octokit);
      await import("../src/index");
      await new Promise((resolve) => setImmediate(resolve));
      return {
        core: coreMock,
        gate: jest.requireMock<jest.Mocked<typeof import("../src/gate/run")>>("../src/gate/run"),
        reconcile:
          jest.requireMock<jest.Mocked<typeof import("../src/reconcile")>>("../src/reconcile"),
        reminders:
          jest.requireMock<jest.Mocked<typeof import("../src/reminders")>>("../src/reminders"),
      };
    } finally {
      mockContext.eventName = "pull_request_target";
    }
  }

  it("does no work when less than 20 percent of the API budget remains", async () => {
    const {
      core: coreMock,
      gate,
      reconcile,
      reminders,
    } = await runSchedule(octokitWith({ remaining: 900, limit: 5000 }));
    expect(gate.runGate).not.toHaveBeenCalled();
    expect(reconcile.reconcileOpenPulls).not.toHaveBeenCalled();
    expect(reminders.handleSchedule).not.toHaveBeenCalled();
    expect(coreMock.warning).toHaveBeenCalledWith(expect.stringContaining("API budget"));
  });

  it("runs the gate, the reconcile and the reminders with enough budget", async () => {
    const { gate, reconcile, reminders } = await runSchedule(
      octokitWith({ remaining: 4000, limit: 5000 })
    );
    expect(gate.runGate).toHaveBeenCalledTimes(1);
    expect(reconcile.reconcileOpenPulls).toHaveBeenCalledTimes(1);
    expect(reminders.handleSchedule).toHaveBeenCalledTimes(1);
  });

  it("runs when the budget can't be read", async () => {
    const { gate, reminders } = await runSchedule(octokitWith(undefined));
    expect(gate.runGate).toHaveBeenCalledTimes(1);
    expect(reminders.handleSchedule).toHaveBeenCalledTimes(1);
  });

  it("passes the reminders block of the repo policy file to the reminders", async () => {
    const { reminders } = await runSchedule(
      octokitWith({ remaining: 4000, limit: 5000 }, "reminders:\n  interval_hours: 6\n")
    );
    expect(reminders.handleSchedule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repoReminders: { interval_hours: 6 } })
    );
  });

  it("logs the API calls the run used", async () => {
    const octokit = octokitWith({ remaining: 4000, limit: 5000 });
    octokit.rest
      .rateLimit!.get.mockResolvedValueOnce({
        data: { resources: { core: { remaining: 4000, limit: 5000 } } },
      })
      .mockResolvedValueOnce({ data: { resources: { core: { remaining: 3970, limit: 5000 } } } });
    const { core: coreMock } = await runSchedule(octokit);
    expect(coreMock.info).toHaveBeenCalledWith(expect.stringContaining("about 30 API calls"));
  });
});
