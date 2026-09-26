import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { baseEnv, CommandRunner } from "./process";
import { ProxyInfo } from "./session";

export const CLAUDE_CODE_VERSION = "2.1.280";
export const LITELLM_VERSION = "1.102.1";
const PROXY_START_TIMEOUT_MS = 90_000;
const LOG_TAIL_CHARS = 1000;

/** Installs the review tools and runs the local LLM proxy. */
export interface ToolRuntime {
  /** Installs claude and LiteLLM, and returns the claude binary path. */
  install(signal?: AbortSignal): Promise<string>;
  startProxy(endpoint: string, token: string): Promise<ProxyInfo>;
  stop(): void;
}

/**
 * Renders the LiteLLM config. The openai provider keeps cache_control, which LiteLLM's datarobot
 * provider strips, and credentials stay in the proxy's environment, never in this file.
 */
export function renderLiteLLMConfig(): string {
  return [
    "model_list:",
    '  - model_name: "*"',
    "    litellm_params:",
    '      model: "openai/*"',
    '      api_base: "os.environ/GW_API_BASE"',
    '      api_key: "os.environ/GW_TOKEN"',
    "      drop_params: true",
    "general_settings:",
    '  master_key: "os.environ/LITELLM_MASTER_KEY"',
    "litellm_settings:",
    "  drop_params: true",
    "  success_callback: []",
    "  failure_callback: []",
    "",
  ].join("\n");
}

export function proxyEnv(endpoint: string, token: string, key: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    GW_API_BASE: `${endpoint}/genai/llmgw`,
    GW_TOKEN: token,
    LITELLM_MASTER_KEY: key,
    // Without this, /v1/messages goes through LiteLLM's Responses adapter, which drops cache_control.
    LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES: "1",
  };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

export class ProcessToolRuntime implements ToolRuntime {
  private proxy?: ChildProcess;
  private ownsDir = false;

  /** Uses `dir` when given; otherwise creates a temp directory on first use and removes it on stop. */
  constructor(
    private readonly runner: CommandRunner,
    private dir?: string
  ) {}

  async install(signal?: AbortSignal): Promise<string> {
    const claudeDir = path.join(this.workDir(), "claude");
    const venv = path.join(this.workDir(), "venv");
    await this.must(
      "npm",
      [
        "install",
        "--prefix",
        claudeDir,
        "--no-audit",
        "--no-fund",
        `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
      ],
      signal
    );
    await this.must("python3", ["-m", "venv", venv], signal);
    await this.must(
      path.join(venv, "bin", "pip"),
      ["install", "--quiet", `litellm[proxy]==${LITELLM_VERSION}`],
      signal
    );
    return path.join(claudeDir, "node_modules", ".bin", "claude");
  }

  async startProxy(endpoint: string, token: string): Promise<ProxyInfo> {
    const port = await freePort();
    const key = crypto.randomBytes(32).toString("hex");
    const configFile = path.join(this.workDir(), "litellm.yaml");
    const logFile = path.join(this.workDir(), "litellm.log");
    fs.writeFileSync(configFile, renderLiteLLMConfig());
    const log = fs.openSync(logFile, "w");
    const proxy = spawn(
      path.join(this.workDir(), "venv", "bin", "litellm"),
      ["--config", configFile, "--host", "127.0.0.1", "--port", String(port)],
      { env: proxyEnv(endpoint, token, key), stdio: ["ignore", log, log] }
    );
    fs.closeSync(log);
    this.proxy = proxy;
    const exited = new Promise<never>((_, reject) => {
      proxy.once("exit", (code) => reject(new Error(`LiteLLM exited early with code ${code}`)));
      proxy.once("error", reject);
    });
    try {
      await Promise.race([waitForPort(port, PROXY_START_TIMEOUT_MS), exited]);
    } catch (error) {
      const tail = fs.readFileSync(logFile, "utf8").slice(-LOG_TAIL_CHARS).split(token).join("***");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(tail.trim() ? `${message}. LiteLLM log:\n${tail}` : message, {
        cause: error,
      });
    }
    return { url: `http://127.0.0.1:${port}`, key };
  }

  stop(): void {
    this.proxy?.kill("SIGTERM");
    this.proxy = undefined;
    if (this.ownsDir && this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private workDir(): string {
    if (!this.dir) {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-tools-"));
      this.ownsDir = true;
    }
    return this.dir;
  }

  private async must(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
    const result = await this.runner.run(cmd, args, { env: baseEnv(), signal });
    if (result.exitCode !== 0) {
      throw new Error(`${path.basename(cmd)} ${args[0]} failed: ${result.stderr.slice(-300)}`);
    }
  }
}
