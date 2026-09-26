import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Budget,
  Candidate,
  mergeCandidates,
  runPipeline,
  ScoredFinding,
  selectFindings,
  selectForScoring,
  SessionFn,
} from "../../src/ai-review/pipeline";
import { Workspace } from "../../src/ai-review/inputs";
import { SessionResult, SessionSpec } from "../../src/ai-review/session";

const settings = {
  endpoint: "https://x/api/v2",
  reviewerModel: "rev",
  scorerModel: "sco",
  threshold: 70,
  maxCostUsd: 3,
};

function workspace(ruleFiles: string[] = ["BUGBOT.md"]): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipe-"));
  return {
    root,
    repoDir: path.join(root, "repo"),
    contextDir: path.join(root, "context"),
    files: [],
    diffPatch: "",
    guidance: "",
    ruleFiles,
  };
}

function ok(output: unknown, costUsd = 0.1): SessionResult {
  return { ok: true, output, costUsd, turns: 3, salvaged: false };
}

function finding(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "claims-0",
    pass: "claims",
    path: "a.go",
    line: 10,
    severity: "high",
    title: "t",
    body: "b",
    ...overrides,
  };
}

/** Routes sessions by prompt: passes by their focus heading, scorers by candidate id. */
function fakeRun(
  passes: Record<string, SessionResult>,
  scores: Record<string, number>
): { run: SessionFn; specs: SessionSpec[] } {
  const specs: SessionSpec[] = [];
  const run: SessionFn = jest.fn(async (spec: SessionSpec) => {
    specs.push(spec);
    if (spec.systemPrompt.includes("claims and reach")) return passes.claims;
    if (spec.systemPrompt.includes("own review rules")) return passes.rules;
    const file = spec.userPrompt.match(/in (\S+candidate\.json)/)?.[1] as string;
    const id = JSON.parse(fs.readFileSync(file, "utf8")).id;
    return ok({ scores: [{ id, score: scores[id] ?? 0, reason: "r" }] }, 0.05);
  });
  return { run, specs };
}

describe("Budget", () => {
  it("shares what is left after salvage headroom, and refuses shares below the minimum", () => {
    const budget = new Budget(3);
    expect(budget.share(2, 1)).toBe(1);
    budget.charge(2.5);
    expect(budget.share(1, 0.35)).toBeCloseTo(0.2);
    expect(budget.share(2, 0.35)).toBe(0);
  });
});

describe("mergeCandidates", () => {
  it("ids findings by pass and index, and ignores empty output", () => {
    const merged = mergeCandidates([
      { pass: "claims", result: ok({ findings: [finding(), finding({ line: 20 })] }) },
      { pass: "rules", result: ok(null) },
    ]);
    expect(merged.map((c) => c.id)).toEqual(["claims-0", "claims-1"]);
  });
});

describe("selectForScoring", () => {
  it("drops low severity, orders high first, and caps at 6", () => {
    const candidates = [
      finding({ id: "a", severity: "low" }),
      finding({ id: "b", severity: "medium" }),
      ...Array.from({ length: 7 }, (_, i) => finding({ id: `h${i}`, severity: "high" })),
    ];
    const selected = selectForScoring(candidates);
    expect(selected).toHaveLength(6);
    expect(selected.every((c) => c.severity === "high")).toBe(true);
  });
});

describe("selectFindings", () => {
  it("applies the threshold and keeps the higher score of near-duplicates", () => {
    const scored: ScoredFinding[] = [
      { ...finding({ id: "a", line: 10 }), score: 80, reason: "" },
      { ...finding({ id: "b", line: 20 }), score: 90, reason: "" },
      { ...finding({ id: "c", line: 60 }), score: 69, reason: "" },
      { ...finding({ id: "d", path: "b.go", line: 10 }), score: 70, reason: "" },
    ];
    expect(selectFindings(scored, 70).map((f) => f.id)).toEqual(["b", "d"]);
  });
});

describe("runPipeline", () => {
  it("runs both passes, scores medium and high candidates, and keeps those at the threshold", async () => {
    const { run, specs } = fakeRun(
      {
        claims: ok({ findings: [finding({ line: 10 }), finding({ line: 40, severity: "low" })] }),
        rules: ok({ findings: [finding({ path: "b.go", severity: "medium" })] }),
      },
      { "claims-0": 85, "rules-0": 60 }
    );
    const result = await runPipeline(run, workspace(), settings);
    expect(result.findings.map((f) => f.id)).toEqual(["claims-0"]);
    expect(result.passes).toEqual(["claims", "rules"]);
    expect(result.failedPasses).toEqual([]);
    expect(specs.filter((s) => s.model === "sco")).toHaveLength(2);
    expect(result.costUsd).toBeCloseTo(0.3);
  });

  it("skips the rules pass when the repo has no rules", async () => {
    const { run, specs } = fakeRun({ claims: ok({ findings: [] }) }, {});
    const result = await runPipeline(run, workspace([]), settings);
    expect(result.passes).toEqual(["claims"]);
    expect(specs).toHaveLength(1);
  });

  it("continues with the other pass when one fails", async () => {
    const { run } = fakeRun(
      {
        claims: { ok: false, output: null, costUsd: 0.2, turns: 1, salvaged: false, error: "boom" },
        rules: ok({ findings: [finding({ id: "x" })] }),
      },
      { "rules-0": 90 }
    );
    const result = await runPipeline(run, workspace(), settings);
    expect(result.failedPasses).toEqual(["claims"]);
    expect(result.findings).toHaveLength(1);
  });

  it("scores fewer candidates when the budget is short, and reports how many it skipped", async () => {
    const four = Array.from({ length: 4 }, (_, i) => finding({ line: i * 100 }));
    const { run, specs } = fakeRun(
      { claims: ok({ findings: four }, 1.8), rules: ok({ findings: [] }, 0.2) },
      {}
    );
    const result = await runPipeline(run, workspace(), settings);
    const scorers = specs.filter((s) => s.model === "sco");
    expect(scorers).toHaveLength(2);
    expect(result.skippedCandidates).toBe(2);
    scorers.forEach((s) => expect(s.maxBudgetUsd).toBeGreaterThanOrEqual(0.15));
  });

  it("passes caps, effort, and the context directories to each session", async () => {
    const { run, specs } = fakeRun(
      { claims: ok({ findings: [finding()] }), rules: ok({ findings: [] }) },
      { "claims-0": 90 }
    );
    const ws = workspace();
    await runPipeline(run, ws, settings);
    const claims = specs.find((s) => s.systemPrompt.includes("claims and reach")) as SessionSpec;
    expect(claims).toMatchObject({
      label: "claims",
      model: "rev",
      maxTurns: 14,
      effort: "medium",
      cwd: ws.repoDir,
      addDirs: [ws.contextDir],
    });
    const scorer = specs.find((s) => s.model === "sco") as SessionSpec;
    expect(scorer.maxTurns).toBe(10);
    expect(scorer.label).toBe("scorer claims-0");
    expect(scorer.addDirs[0]).toBe(ws.contextDir);
  });

  it("counts scorer sessions that fail", async () => {
    const { run } = fakeRun(
      {
        claims: ok({ findings: [finding(), finding({ line: 100 })] }),
        rules: ok({ findings: [] }),
      },
      {}
    );
    const failing: SessionFn = async (spec) =>
      spec.model === "sco"
        ? { ok: false, output: null, costUsd: 0.05, turns: 1, salvaged: false, error: "bad model" }
        : run(spec);
    const result = await runPipeline(failing, workspace(), settings);
    expect(result.scoredCandidates).toBe(2);
    expect(result.failedCandidates).toBe(2);
    expect(result.findings).toEqual([]);
  });

  it("reports a timeout and scores nothing after the signal fires", async () => {
    const controller = new AbortController();
    const { run, specs } = fakeRun(
      { claims: ok({ findings: [finding()] }), rules: ok({ findings: [] }) },
      {}
    );
    const wrapped: SessionFn = async (spec) => {
      const result = await run(spec);
      controller.abort();
      return result;
    };
    const result = await runPipeline(wrapped, workspace(), settings, controller.signal);
    expect(result.timedOut).toBe(true);
    expect(specs.filter((s) => s.model === "sco")).toHaveLength(0);
  });
});
