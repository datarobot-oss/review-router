import * as core from "@actions/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { baseEnv, CommandRunner } from "./process";

export type Effort = "low" | "medium" | "high";

export interface ProxyInfo {
  url: string;
  key: string;
}

export interface SessionSpec {
  cwd: string;
  addDirs: string[];
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  effort?: Effort;
}

export interface SessionResult {
  ok: boolean;
  output: unknown;
  costUsd: number;
  turns: number;
  salvaged: boolean;
  error?: string;
}

/** The fields of `claude -p --output-format json` this module reads. */
export interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  result?: string;
}

export const SALVAGE_PROMPT =
  "Your exploration budget is used up and your tools are gone. Output your answer now, based on what you have already verified.";
export const SALVAGE_MAX_TURNS = 3;
// Resuming with no tools invalidates the prompt cache, so a salvage re-writes the whole context.
export const SALVAGE_HEADROOM_USD = 0.3;

// Models that use adaptive thinking. Anything else sends thinking.type "enabled", which LiteLLM's
// openai provider reroutes to a Responses route the gateway doesn't serve.
const ADAPTIVE_THINKING_MODELS = [/claude-sonnet-5/, /claude-opus-5/];

export function needsThinkingDisabled(model: string): boolean {
  return !ADAPTIVE_THINKING_MODELS.some((re) => re.test(model));
}

/** Settings JSON for every session: proxy auth, and no reads outside the workspace. */
export function sessionSettings(): string {
  return JSON.stringify({
    apiKeyHelper: "printenv ANTHROPIC_AUTH_TOKEN",
    permissions: {
      deny: ["Read(//proc/**)", "Read(//sys/**)", "Read(//etc/**)", "Read(~/**)"],
    },
  });
}

export function sessionEnv(proxy: ProxyInfo, spec: SessionSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv(),
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_AUTH_TOKEN: proxy.key,
    ANTHROPIC_MODEL: spec.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: spec.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: spec.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: spec.model,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (needsThinkingDisabled(spec.model)) env.MAX_THINKING_TOKENS = "0";
  return env;
}

function commonArgs(spec: SessionSpec, promptFile: string, budgetUsd: number): string[] {
  return [
    "--bare",
    // --bare still loads project and local settings, and the PR head controls those.
    "--setting-sources",
    "user",
    "--settings",
    sessionSettings(),
    "--system-prompt-file",
    promptFile,
    ...spec.addDirs.flatMap((dir) => ["--add-dir", dir]),
    "--strict-mcp-config",
    ...(spec.effort ? ["--effort", spec.effort] : []),
    "--max-budget-usd",
    budgetUsd.toFixed(2),
    "--json-schema",
    JSON.stringify(spec.schema),
    "--output-format",
    "json",
  ];
}

export function initialArgs(spec: SessionSpec, promptFile: string): string[] {
  return [
    "-p",
    spec.userPrompt,
    "--tools",
    "Read,Grep,Glob",
    "--max-turns",
    String(spec.maxTurns),
    ...commonArgs(spec, promptFile, spec.maxBudgetUsd),
  ];
}

export function salvageArgs(spec: SessionSpec, promptFile: string, sessionId: string): string[] {
  return [
    "-p",
    SALVAGE_PROMPT,
    "--resume",
    sessionId,
    "--tools",
    "",
    "--max-turns",
    String(SALVAGE_MAX_TURNS),
    ...commonArgs(spec, promptFile, spec.maxBudgetUsd + SALVAGE_HEADROOM_USD),
  ];
}

/** Returns whether a session stopped on its turn or budget cap, leaving no structured output. */
export function isCapped(result: ClaudeResult): boolean {
  return result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd";
}

// claude reports API errors with subtype "success", so the result text carries the cause.
function failureText(result: ClaudeResult): string {
  const subtype = result.subtype ?? "session failed";
  return result.result ? `${subtype}: ${result.result.slice(0, 300)}` : subtype;
}

function parse(stdout: string): ClaudeResult | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    return value && typeof value === "object" ? (value as ClaudeResult) : null;
  } catch {
    return null;
  }
}

/**
 * Runs one read-only claude session, salvaging it once if it hits a cap.
 *
 * A resumed session reports cost cumulatively, so the final result's cost is the whole session's.
 */
export async function runSession(
  runner: CommandRunner,
  claudeBin: string,
  proxy: ProxyInfo,
  spec: SessionSpec,
  signal?: AbortSignal
): Promise<SessionResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-session-"));
  const promptFile = path.join(dir, "system.md");
  fs.writeFileSync(promptFile, spec.systemPrompt);
  const env = sessionEnv(proxy, spec);
  const warn = (error: string) =>
    core.warning(`AI review session on ${spec.model} failed: ${error}`);
  const failed = (error: string): SessionResult => {
    warn(error);
    return { ok: false, output: null, costUsd: 0, turns: 0, salvaged: false, error };
  };
  try {
    let first: ClaudeResult | null;
    let stderr: string;
    try {
      const run = await runner.run(claudeBin, initialArgs(spec, promptFile), {
        cwd: spec.cwd,
        env,
        signal,
      });
      first = parse(run.stdout);
      stderr = run.stderr.trim().slice(-300);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    if (!first) {
      return failed(
        stderr ? `unparseable session output: ${stderr}` : "unparseable session output"
      );
    }

    let final = first;
    let turns = first.num_turns ?? 0;
    let salvaged = false;
    if (isCapped(first) && first.session_id) {
      salvaged = true;
      try {
        const run = await runner.run(claudeBin, salvageArgs(spec, promptFile, first.session_id), {
          cwd: spec.cwd,
          env,
          signal,
        });
        const second = parse(run.stdout);
        if (second) {
          final = second;
          turns += second.num_turns ?? 0;
        }
      } catch {
        // The capped result stands, and its cost still counts.
      }
    }
    const ok = !final.is_error && final.structured_output != null;
    const error = ok ? undefined : failureText(final);
    if (error) warn(error);
    return {
      ok,
      output: ok ? final.structured_output : null,
      costUsd: final.total_cost_usd ?? 0,
      turns,
      salvaged,
      error,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
