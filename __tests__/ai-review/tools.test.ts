import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  CLAUDE_CODE_VERSION,
  freePort,
  LITELLM_VERSION,
  ProcessToolRuntime,
  proxyEnv,
  renderLiteLLMConfig,
  waitForPort,
} from "../../src/ai-review/tools";
import { CommandRunner } from "../../src/ai-review/process";

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return { ...actual, mkdtempSync: jest.fn(actual.mkdtempSync) };
});

/** Returns the directories src code created through mkdtempSync with this prefix. */
function createdDirs(prefix: string): string[] {
  return (fs.mkdtempSync as jest.Mock).mock.results
    .map((r) => r.value as string)
    .filter((dir) => path.basename(dir).startsWith(prefix));
}

describe("renderLiteLLMConfig", () => {
  it("routes everything to the openai provider and holds no credentials", () => {
    const config = renderLiteLLMConfig();
    expect(config).toContain('model: "openai/*"');
    expect(config).toContain('api_base: "os.environ/GW_API_BASE"');
    expect(config).toContain('api_key: "os.environ/GW_TOKEN"');
    expect(config).toContain('master_key: "os.environ/LITELLM_MASTER_KEY"');
    expect(config).not.toContain("datarobot/");
  });
});

describe("proxyEnv", () => {
  it("appends the gateway path, forces chat completions, and carries no action inputs", () => {
    process.env["INPUT_GITHUB-TOKEN"] = "gh-secret";
    const env = proxyEnv("https://app.eu.datarobot.com/api/v2", "dr-token", "master");
    delete process.env["INPUT_GITHUB-TOKEN"];
    expect(env.GW_API_BASE).toBe("https://app.eu.datarobot.com/api/v2/genai/llmgw");
    expect(env.GW_TOKEN).toBe("dr-token");
    expect(env.LITELLM_MASTER_KEY).toBe("master");
    expect(env.LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES).toBe("1");
    expect(Object.values(env)).not.toContain("gh-secret");
  });
});

describe("ports", () => {
  it("finds a free port and waits for a listener", async () => {
    const port = await freePort();
    const server = net.createServer().listen(port, "127.0.0.1");
    await expect(waitForPort(port, 2000)).resolves.toBeUndefined();
    server.close();
  });

  it("times out when nothing listens", async () => {
    await expect(waitForPort(await freePort(), 300)).rejects.toThrow("did not open");
  });
});

describe("ProcessToolRuntime proxy lifecycle", () => {
  it("starts a proxy, and stopping it leaves no unhandled rejection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
    const bin = path.join(dir, "venv", "bin", "litellm");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      `#!${process.execPath}\nconst port = Number(process.argv[process.argv.indexOf("--port") + 1]);\nrequire("net").createServer().listen(port, "127.0.0.1");\n`
    );
    fs.chmodSync(bin, 0o755);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const runtime = new ProcessToolRuntime({ run: jest.fn() }, dir);
      const proxy = await runtime.startProxy("https://x/api/v2", "tok");
      expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      runtime.stop();
      await new Promise((r) => setTimeout(r, 300));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("includes the proxy's log tail, without the token, when it exits early", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
    const bin = path.join(dir, "venv", "bin", "litellm");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      `#!${process.execPath}\nprocess.stderr.write("bad config for " + process.env.GW_TOKEN + "\\n");\nprocess.exit(1);\n`
    );
    fs.chmodSync(bin, 0o755);
    const runtime = new ProcessToolRuntime({ run: jest.fn() }, dir);
    const error = await runtime.startProxy("https://x/api/v2", "tok-secret").catch((e) => e);
    expect(error.message).toContain("bad config for ***");
    expect(error.message).not.toContain("tok-secret");
  });

  it("rejects when the proxy binary can't be spawned", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
    const runtime = new ProcessToolRuntime({ run: jest.fn() }, dir);
    await expect(runtime.startProxy("https://x/api/v2", "tok")).rejects.toThrow(/ENOENT/);
  });
});

describe("ProcessToolRuntime.install", () => {
  it("installs the pinned versions and returns the claude binary path", async () => {
    const calls: [string, string[]][] = [];
    const runner: CommandRunner = {
      run: jest.fn(async (cmd: string, args: string[]) => {
        calls.push([cmd, args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const bin = await new ProcessToolRuntime(runner, "/tmp/tools").install();
    expect(bin).toBe("/tmp/tools/claude/node_modules/.bin/claude");
    expect(calls[0][1]).toContain(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
    expect(calls[2][1]).toContain(`litellm[proxy]==${LITELLM_VERSION}`);
  });

  it("passes the abort signal to every install command", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const runner: CommandRunner = {
      run: jest.fn(async (_cmd, _args, opts) => {
        signals.push(opts.signal);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const signal = new AbortController().signal;
    await new ProcessToolRuntime(runner, "/tmp/tools").install(signal);
    expect(signals).toEqual([signal, signal, signal]);
  });

  it("creates its work directory on install, not on construction, and removes it on stop", async () => {
    const runner: CommandRunner = {
      run: jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    const before = createdDirs("ai-review-tools-").length;
    const runtime = new ProcessToolRuntime(runner);
    expect(createdDirs("ai-review-tools-")).toHaveLength(before);
    const bin = await runtime.install();
    const [dir] = createdDirs("ai-review-tools-").slice(before);
    expect(bin.startsWith(dir)).toBe(true);
    runtime.stop();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("fails with the failing step when a command exits non-zero", async () => {
    const runner: CommandRunner = {
      run: jest.fn(async () => ({ stdout: "", stderr: "no network", exitCode: 1 })),
    };
    await expect(new ProcessToolRuntime(runner, "/tmp/tools").install()).rejects.toThrow(
      "npm install failed: no network"
    );
  });
});
