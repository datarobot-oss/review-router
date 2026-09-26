import { spawn } from "child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Runs an external command without a shell. */
export interface CommandRunner {
  run(cmd: string, args: string[], opts: CommandOptions): Promise<CommandResult>;
}

export const processRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        signal: opts.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    });
  },
};

const INHERITED_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

/**
 * Returns the environment every child process starts from.
 *
 * Never process.env: GitHub exposes action inputs, including the tokens, as INPUT_* variables.
 */
export function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    INHERITED_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])
  );
}
