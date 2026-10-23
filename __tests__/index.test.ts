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
