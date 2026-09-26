import { baseEnv, processRunner } from "../../src/ai-review/process";

describe("baseEnv", () => {
  it("keeps PATH and HOME but never the action's INPUT_ tokens", () => {
    process.env["INPUT_AI-TOKEN"] = "secret";
    process.env["INPUT_GITHUB-TOKEN"] = "secret";
    const env = baseEnv();
    delete process.env["INPUT_AI-TOKEN"];
    delete process.env["INPUT_GITHUB-TOKEN"];
    expect(env.PATH).toBe(process.env.PATH);
    expect(Object.keys(env).some((k) => k.startsWith("INPUT_"))).toBe(false);
  });
});

describe("processRunner", () => {
  it("captures stdout, stderr, and the exit code without a shell", async () => {
    const result = await processRunner.run(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      { env: baseEnv() }
    );
    expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 3 });
  });

  it("rejects when aborted", async () => {
    const controller = new AbortController();
    const running = processRunner.run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      env: baseEnv(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow();
  });
});
