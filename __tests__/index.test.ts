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
