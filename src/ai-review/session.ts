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
  /** Names the session in logs, for example "claims" or "scorer claims-0". */
  label: string;
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

/** The fields of the result event of `claude -p --output-format stream-json` this module reads. */
export interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  result?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

export const SALVAGE_PROMPT =
  "Your exploration budget is used up and your tools are gone. Output your answer now, based on what you have already verified.";
export const SALVAGE_MAX_TURNS = 3;
// Resuming with no tools invalidates the prompt cache, so a salvage re-writes the whole context.
export const SALVAGE_HEADROOM_USD = 0.3;
const TOOL_GIST_CHARS = 160;

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
      blockReadsOutsideWorkingDirectories: true,
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
    "stream-json",
    "--verbose",
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

function describeRun(label: string, result: ClaudeResult, turns: number): string {
  const u = result.usage ?? {};
  const read = u.cache_read_input_tokens ?? 0;
  const input = read + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0);
  return (
    `AI review session ${label}: ${turns} turns, $${(result.total_cost_usd ?? 0).toFixed(2)}, ` +
    `tokens: ${read} cache read, ${u.cache_creation_input_tokens ?? 0} cache write, ` +
    `${u.input_tokens ?? 0} uncached input, ${u.output_tokens ?? 0} output` +
    (input > 0 ? `, ${Math.round((read / input) * 100)}% from cache` : "")
  );
}

// Caching failing through the proxy or the gateway fails nothing, it only multiplies the cost.
function cacheLooksBroken(result: ClaudeResult): boolean {
  return (
    result.usage != null && (result.num_turns ?? 0) > 1 && !result.usage.cache_read_input_tokens
  );
}

/** Formats one tool call for the log, with paths relative to the workspace root. */
function toolGist(name: string, input: Record<string, unknown>, root: string): string {
  const rel = (p: unknown) =>
    typeof p !== "string" ? "" : p.startsWith(root) ? p.slice(root.length) : p;
  let target = rel(input.file_path);
  if (!target && typeof input.pattern === "string") {
    target = input.pattern + (typeof input.path === "string" ? ` in ${rel(input.path)}` : "");
  }
  target = target.replace(/\s+/g, " ");
  if (target.length > TOOL_GIST_CHARS) target = `${target.slice(0, TOOL_GIST_CHARS)}…`;
  return `tool ${name} ${target}`.trimEnd();
}

interface StreamEvent {
  type?: string;
  message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
}

/** Parses stream-json stdout into its result event and a log line per tool call. */
function parse(stdout: string, root: string): { result: ClaudeResult | null; tools: string[] } {
  let result: ClaudeResult | null = null;
  const tools: string[] = [];
  for (const line of stdout.split("\n")) {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.type === "result") result = event as ClaudeResult;
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      // The schema-constrained answer arrives as a StructuredOutput call, which isn't exploration.
      if (block.type !== "tool_use" || !block.name || block.name === "StructuredOutput") continue;
      tools.push(toolGist(block.name, block.input ?? {}, root));
    }
  }
  return { result, tools };
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
  const root = `${path.dirname(spec.cwd)}${path.sep}`;
  const logTools = (tools: string[]) =>
    tools.forEach((tool) => core.info(`AI review session ${spec.label}: ${tool}`));
  const warn = (error: string) =>
    core.warning(`AI review session ${spec.label} on ${spec.model} failed: ${error}`);
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
      const parsed = parse(run.stdout, root);
      logTools(parsed.tools);
      first = parsed.result;
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
        const second = parse(run.stdout, root).result;
        if (second) {
          final = second;
          turns += second.num_turns ?? 0;
        }
      } catch {
        // The capped result stands, and its cost still counts.
      }
    }
    core.info(`${describeRun(spec.label, final, turns)}${salvaged ? ", salvaged" : ""}`);
    // A salvage resume starts a fresh cache, so each run is checked on its own turns.
    const brokenCacheRun = [first, final].find(cacheLooksBroken);
    if (brokenCacheRun) {
      core.warning(
        `AI review session ${spec.label} read nothing from the prompt cache over ${brokenCacheRun.num_turns} turns, so caching may be broken and reviews cost several times more.`
      );
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
