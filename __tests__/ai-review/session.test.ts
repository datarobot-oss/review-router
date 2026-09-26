import {
  initialArgs,
  isCapped,
  needsThinkingDisabled,
  runSession,
  SALVAGE_HEADROOM_USD,
  salvageArgs,
  sessionEnv,
  sessionSettings,
  SessionSpec,
} from "../../src/ai-review/session";
import * as core from "@actions/core";
import { CommandRunner } from "../../src/ai-review/process";

jest.mock("@actions/core");

const spec: SessionSpec = {
  cwd: "/tmp/ws/repo",
  addDirs: ["/tmp/ws/context"],
  systemPrompt: "system",
  userPrompt: "review it",
  schema: { type: "object" },
  model: "bedrock/anthropic.claude-sonnet-5",
  maxTurns: 14,
  maxBudgetUsd: 1,
  effort: "medium",
};
const proxy = { url: "http://127.0.0.1:4555", key: "proxy-key" };

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fakeRunner(outputs: object[]): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run: jest.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      const next = outputs.shift();
      if (!next) throw new Error("no more outputs");
      return { stdout: JSON.stringify(next), stderr: "", exitCode: 0 };
    }),
  };
  return { runner, calls };
}

describe("initialArgs", () => {
  it("allows only Read, Grep, and Glob, and passes the caps", () => {
    const args = initialArgs(spec, "/tmp/p.md");
    expect(flagValue(args, "--tools")).toBe("Read,Grep,Glob");
    expect(flagValue(args, "--max-turns")).toBe("14");
    expect(flagValue(args, "--max-budget-usd")).toBe("1.00");
    expect(flagValue(args, "--effort")).toBe("medium");
    expect(flagValue(args, "--add-dir")).toBe("/tmp/ws/context");
    expect(args).toContain("--bare");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("loads no project or local settings, which the PR head controls", () => {
    expect(flagValue(initialArgs(spec, "/tmp/p.md"), "--setting-sources")).toBe("user");
    expect(flagValue(salvageArgs(spec, "/tmp/p.md", "s"), "--setting-sources")).toBe("user");
  });
});

describe("salvageArgs", () => {
  it("resumes with no tools, 3 turns, and budget headroom", () => {
    const args = salvageArgs(spec, "/tmp/p.md", "sess-1");
    expect(flagValue(args, "--resume")).toBe("sess-1");
    expect(flagValue(args, "--tools")).toBe("");
    expect(flagValue(args, "--max-turns")).toBe("3");
    expect(flagValue(args, "--max-budget-usd")).toBe((1 + SALVAGE_HEADROOM_USD).toFixed(2));
  });
});

describe("sessionSettings", () => {
  it("uses the apiKeyHelper and denies reads outside the workspace", () => {
    const settings = JSON.parse(sessionSettings());
    expect(settings.apiKeyHelper).toBe("printenv ANTHROPIC_AUTH_TOKEN");
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Read(//proc/**)", "Read(//sys/**)", "Read(//etc/**)", "Read(~/**)"])
    );
  });
});

describe("sessionEnv", () => {
  it("points claude at the proxy and carries no action inputs", () => {
    process.env["INPUT_AI-TOKEN"] = "secret";
    const env = sessionEnv(proxy, spec);
    delete process.env["INPUT_AI-TOKEN"];
    expect(env.ANTHROPIC_BASE_URL).toBe(proxy.url);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("proxy-key");
    expect(env.ANTHROPIC_MODEL).toBe(spec.model);
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(Object.values(env)).not.toContain("secret");
    expect(env.MAX_THINKING_TOKENS).toBeUndefined();
  });

  it("disables thinking for budget-thinking models", () => {
    const env = sessionEnv(proxy, {
      ...spec,
      model: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(env.MAX_THINKING_TOKENS).toBe("0");
  });
});

describe("needsThinkingDisabled", () => {
  it.each([
    ["bedrock/anthropic.claude-sonnet-5", false],
    ["anthropic/claude-opus-5", false],
    ["bedrock/anthropic.claude-haiku-4-5-20251001-v1:0", true],
    ["bedrock/anthropic.claude-opus-4-8", true],
  ])("%s -> %s", (model, expected) => {
    expect(needsThinkingDisabled(model)).toBe(expected);
  });
});

describe("isCapped", () => {
  it.each([
    ["error_max_turns", true],
    ["error_max_budget_usd", true],
    ["success", false],
    ["error_during_execution", false],
  ])("%s -> %s", (subtype, expected) => {
    expect(isCapped({ subtype })).toBe(expected);
  });
});

describe("runSession", () => {
  it("returns structured output and cost on success", async () => {
    const { runner, calls } = fakeRunner([
      {
        subtype: "success",
        is_error: false,
        structured_output: { findings: [] },
        total_cost_usd: 0.4,
        num_turns: 6,
        session_id: "s",
      },
    ]);
    const result = await runSession(runner, "claude", proxy, spec);
    expect(result).toEqual({
      ok: true,
      output: { findings: [] },
      costUsd: 0.4,
      turns: 6,
      salvaged: false,
      error: undefined,
    });
    expect(calls).toHaveLength(1);
  });

  it("salvages a capped session and takes the resumed session's cumulative cost", async () => {
    const { runner, calls } = fakeRunner([
      {
        subtype: "error_max_turns",
        is_error: true,
        total_cost_usd: 0.67,
        num_turns: 15,
        session_id: "s1",
      },
      {
        subtype: "success",
        is_error: false,
        structured_output: { findings: [] },
        total_cost_usd: 1.0,
        num_turns: 2,
        session_id: "s1",
      },
    ]);
    const result = await runSession(runner, "claude", proxy, spec);
    expect(result.ok).toBe(true);
    expect(result.salvaged).toBe(true);
    expect(result.costUsd).toBe(1.0);
    expect(result.turns).toBe(17);
    expect(flagValue(calls[1], "--resume")).toBe("s1");
  });

  it("keeps the capped cost when salvage itself fails", async () => {
    const { runner } = fakeRunner([
      {
        subtype: "error_max_turns",
        is_error: true,
        total_cost_usd: 0.67,
        num_turns: 15,
        session_id: "s1",
      },
    ]);
    const result = await runSession(runner, "claude", proxy, spec);
    expect(result).toMatchObject({ ok: false, costUsd: 0.67, salvaged: true });
  });

  it("fails cleanly on unparseable output", async () => {
    const runner: CommandRunner = {
      run: jest.fn(async () => ({ stdout: "not json", stderr: "", exitCode: 1 })),
    };
    expect(await runSession(runner, "claude", proxy, spec)).toMatchObject({
      ok: false,
      costUsd: 0,
      error: "unparseable session output",
    });
  });

  it("logs stderr when the output can't be parsed", async () => {
    const runner: CommandRunner = {
      run: jest.fn(async () => ({ stdout: "", stderr: "Error: model not found", exitCode: 1 })),
    };
    const result = await runSession(runner, "claude", proxy, spec);
    expect(result.error).toBe("unparseable session output: Error: model not found");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("model not found"));
  });

  it("fails cleanly when the process throws, for example on abort", async () => {
    const runner: CommandRunner = {
      run: jest.fn(async () => {
        throw new Error("aborted");
      }),
    };
    expect(await runSession(runner, "claude", proxy, spec)).toMatchObject({
      ok: false,
      costUsd: 0,
      error: "aborted",
    });
  });

  it("keeps and logs the error text of a failed session", async () => {
    const { runner } = fakeRunner([
      {
        subtype: "success",
        is_error: true,
        result: "API Error: 401 invalid token",
        total_cost_usd: 0,
        num_turns: 1,
      },
    ]);
    const result = await runSession(runner, "claude", proxy, spec);
    expect(result.error).toBe("success: API Error: 401 invalid token");
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("API Error: 401 invalid token")
    );
  });

  it("treats is_error with no structured output as a failure", async () => {
    const { runner } = fakeRunner([
      { subtype: "success", is_error: true, total_cost_usd: 0.1, num_turns: 1 },
    ]);
    expect(await runSession(runner, "claude", proxy, spec)).toMatchObject({
      ok: false,
      costUsd: 0.1,
    });
  });
});
