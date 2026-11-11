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
  options: {
    token?: string;
    pullRequest?: object;
    gateDecision?: object | null;
    inputs?: Record<string, string>;
    payload?: object;
  } = {}
): Promise<jest.Mocked<typeof import("../src/router")>> {
  jest.resetModules();
  const coreMock = jest.requireMock<jest.Mocked<typeof core>>("@actions/core");
  coreMock.getInput.mockImplementation((name: string) =>
    name === "github-token" ? (options.token ?? "tok") : (options.inputs?.[name] ?? "")
  );
  mockContext.payload = {
    action,
    pull_request: {
      number: 7,
      head: { sha: "newhead" },
      base: { ref: "main" },
      ...options.pullRequest,
    },
    ...options.payload,
  };
  jest
    .requireMock<jest.Mocked<typeof import("../src/gate/run")>>("../src/gate/run")
    .runGate.mockResolvedValue((options.gateDecision ?? null) as never);
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

describe("review requests", () => {
  const pullRequest = { html_url: "https://github.com/acme/api/pull/7", body: "desc" };

  it("tells a requested person who asked", async () => {
    const router = await runAction("review_requested", {
      pullRequest,
      payload: {
        requested_reviewer: { login: "carol" },
        sender: { login: "bob", type: "User" },
      },
    });

    expect(router.handleReviewRequested).toHaveBeenCalledTimes(1);
    expect(router.handleReviewRequested).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        owner: "acme",
        repo: "api",
        prNumber: 7,
        prUrl: "https://github.com/acme/api/pull/7",
        requester: "bob",
        reviewer: "carol",
        teamsConfig,
      })
    );
  });

  it("ignores a request for a team, which the Router and the channel post already cover", async () => {
    const router = await runAction("review_requested", {
      pullRequest,
      payload: { requested_team: { slug: "labs" }, sender: { login: "bob", type: "User" } },
    });

    expect(router.handleReviewRequested).not.toHaveBeenCalled();
  });

  it("ignores a request that a bot made", async () => {
    const router = await runAction("review_requested", {
      pullRequest,
      payload: {
        requested_reviewer: { login: "carol" },
        sender: { login: "dependabot[bot]", type: "Bot" },
      },
    });

    expect(router.handleReviewRequested).not.toHaveBeenCalled();
  });

  it("does nothing without a token, as on a fork PR run with no secrets", async () => {
    const router = await runAction("review_requested", {
      token: "",
      pullRequest,
      payload: {
        requested_reviewer: { login: "carol" },
        sender: { login: "bob", type: "User" },
      },
    });

    expect(router.handleReviewRequested).not.toHaveBeenCalled();
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
      expect.objectContaining({ owner: "acme", repo: "api" }),
      expect.any(Function)
    );
    expect(router.syncReviewCheck).toHaveBeenCalledTimes(1);
  });

  it("is the only work for a merge queue event", async () => {
    const { router, gate } = await runEvent("merge_group", "checks_requested");
    expect(gate.runGate).toHaveBeenCalledTimes(1);
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });
});

describe("the gate mode", () => {
  const gateInputs = { mode: "gate", "gate-app-id": "4242" };
  const gateModule = () =>
    jest.requireMock<jest.Mocked<typeof import("../src/gate/run")>>("../src/gate/run");
  const coreModule = () => jest.requireMock<jest.Mocked<typeof core>>("@actions/core");

  it("runs only the gate, under the App named by gate-app-id", async () => {
    const router = await runAction("synchronize", { inputs: gateInputs });
    expect(gateModule().runGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventName: "pull_request_target", action: "synchronize" }),
      expect.objectContaining({ owner: "acme", repo: "api", appId: 4242 }),
      expect.any(Function)
    );
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
    expect(router.handleDependabotPush).not.toHaveBeenCalled();
  });

  it("does not load the team config, which the gate never reads", async () => {
    await runAction("opened", { inputs: gateInputs });
    const config = jest.requireMock<jest.Mocked<typeof import("../src/config")>>("../src/config");
    expect(config.loadTeamsConfigForOrg).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-5", "4242.5", "abc"])(
    "fails without running anything when gate-app-id is %j",
    async (id) => {
      const router = await runAction("synchronize", {
        inputs: { mode: "gate", "gate-app-id": id },
      });
      expect(coreModule().setFailed).toHaveBeenCalledWith(expect.stringContaining("gate-app-id"));
      expect(gateModule().runGate).not.toHaveBeenCalled();
      expect(router.syncReviewCheck).not.toHaveBeenCalled();
    }
  );

  it("fails on a mode it doesn't know", async () => {
    const router = await runAction("synchronize", { inputs: { mode: "gaet" } });
    expect(coreModule().setFailed).toHaveBeenCalledWith(expect.stringContaining('"gaet"'));
    expect(gateModule().runGate).not.toHaveBeenCalled();
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });

  it("still does nothing without a token, as for a fork run with no secrets", async () => {
    await runAction("synchronize", { token: "", inputs: gateInputs });
    expect(gateModule().runGate).not.toHaveBeenCalled();
    expect(coreModule().setFailed).not.toHaveBeenCalled();
  });

  it("passes no dry run to the gate, since it posts the result", async () => {
    await runAction("synchronize", { inputs: gateInputs });
    expect(gateModule().runGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ dryRun: expect.anything() }),
      expect.any(Function)
    );
  });

  it("no longer accepts the removed all mode", async () => {
    const router = await runAction("synchronize", { inputs: { mode: "all" } });
    expect(coreModule().setFailed).toHaveBeenCalledWith(expect.stringContaining('"all"'));
    expect(gateModule().runGate).not.toHaveBeenCalled();
    expect(router.syncReviewCheck).not.toHaveBeenCalled();
  });
});

describe("the router mode, which is the default", () => {
  const gateModule = () =>
    jest.requireMock<jest.Mocked<typeof import("../src/gate/run")>>("../src/gate/run");
  const coreModule = () => jest.requireMock<jest.Mocked<typeof core>>("@actions/core");

  it("keeps routing, and evaluates the gate only for Dependabot without posting it", async () => {
    const router = await runAction("synchronize");
    expect(gateModule().runGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ dryRun: { onlyAuthor: "dependabot[bot]" } }),
      expect.any(Function)
    );
    expect(router.syncReviewCheck).toHaveBeenCalledTimes(1);
  });

  it("behaves the same when mode names it", async () => {
    await runAction("synchronize", { inputs: { mode: "router" } });
    expect(gateModule().runGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ dryRun: { onlyAuthor: "dependabot[bot]" } }),
      expect.any(Function)
    );
  });

  it("needs no gate-app-id, since it posts nothing", async () => {
    await runAction("synchronize");
    expect(coreModule().setFailed).not.toHaveBeenCalled();
  });

  it("ignores gate-app-id, so the Router never treats an App's results as its own", async () => {
    await runAction("synchronize", { inputs: { "gate-app-id": "4242" } });
    expect(gateModule().runGate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ appId: expect.anything() }),
      expect.any(Function)
    );
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

  async function runSchedule(
    octokit: ReturnType<typeof octokitWith>,
    swept: object[] = [],
    firstRouteFails = false
  ) {
    mockContext.eventName = "schedule";
    try {
      jest.resetModules();
      if (firstRouteFails) {
        jest
          .requireMock<jest.Mocked<typeof import("../src/router")>>("../src/router")
          .handleDependabotPush.mockRejectedValueOnce(new Error("403"));
      }
      const coreMock = jest.requireMock<jest.Mocked<typeof core>>("@actions/core");
      coreMock.getInput.mockImplementation((name: string) =>
        name === "github-token" ? "tok" : ""
      );
      mockContext.payload = { repository: { default_branch: "trunk" } };
      jest
        .requireMock<jest.Mocked<typeof import("../src/gate/run")>>("../src/gate/run")
        .runGate.mockImplementation(async (_octokit, _event, _ref, onSweepDecision) => {
          swept.forEach((decided) => onSweepDecision?.(decided as never));
          return null;
        });
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
        router: jest.requireMock<jest.Mocked<typeof import("../src/router")>>("../src/router"),
      };
    } finally {
      mockContext.eventName = "pull_request_target";
    }
  }

  describe("routing a Dependabot pull request the sweep finds blocked", () => {
    const quota = { remaining: 4000, limit: 5000 };
    const decision = { conclusion: "action_required", reason: "needs-approval" };
    const swept = (number: number) => ({
      number,
      author: "dependabot[bot]",
      labels: ["dependencies"],
      decision,
    });

    it("hands each swept decision to the push handler, for pull requests never routed", async () => {
      const { router } = await runSchedule(octokitWith(quota), [swept(5)]);
      expect(router.handleDependabotPush).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          owner: "acme",
          repo: "api",
          prNumber: 5,
          author: "dependabot[bot]",
          labels: ["dependencies"],
          gateDecision: decision,
          unroutedOnly: true,
          teamsConfig,
        })
      );
    });

    it("routes nothing when the sweep decided nothing", async () => {
      const { router } = await runSchedule(octokitWith(quota));
      expect(router.handleDependabotPush).not.toHaveBeenCalled();
    });

    it("routes the other pull requests and still runs the reminders when one fails", async () => {
      const {
        router,
        core: coreMock,
        reminders,
      } = await runSchedule(octokitWith(quota), [swept(5), swept(6)], true);
      expect(router.handleDependabotPush).toHaveBeenCalledTimes(2);
      expect(coreMock.warning).toHaveBeenCalledWith(expect.stringContaining("#5"));
      expect(reminders.handleSchedule).toHaveBeenCalledTimes(1);
    });
  });

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

describe("the gate's decision reaches the routing of a Dependabot pull request", () => {
  const decision = { conclusion: "success", reason: "dependabot", title: "t", summary: "s" };
  const dependabot = {
    user: { login: "dependabot[bot]" },
    labels: [{ name: "dependencies" }],
  };

  it("hands the decision to the opened handler", async () => {
    const router = await runAction("opened", { pullRequest: dependabot, gateDecision: decision });
    expect(router.handleOpened).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ author: "dependabot[bot]", gateDecision: decision })
    );
  });

  it.each(["synchronize", "reopened"])(
    "hands the decision and the label names to the push handler after %s",
    async (action) => {
      const router = await runAction(action, { pullRequest: dependabot, gateDecision: decision });
      expect(router.handleDependabotPush).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          prNumber: 7,
          author: "dependabot[bot]",
          labels: ["dependencies"],
          gateDecision: decision,
        })
      );
    }
  );

  it("passes no decision when the repository has no gate", async () => {
    const router = await runAction("synchronize", { pullRequest: dependabot });
    expect(router.handleDependabotPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ gateDecision: null })
    );
  });

  it("copes with a payload that has no labels", async () => {
    const router = await runAction("synchronize");
    expect(router.handleDependabotPush).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ labels: [] })
    );
  });
});
