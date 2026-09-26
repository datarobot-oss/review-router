import * as fs from "fs";
import * as path from "path";
import { Workspace } from "./inputs";
import {
  buildPassPrompt,
  buildScorerPrompt,
  FINDINGS_SCHEMA,
  PassName,
  passUserPrompt,
  SCORES_SCHEMA,
  scorerUserPrompt,
} from "./prompts";
import { SALVAGE_HEADROOM_USD, SessionResult, SessionSpec } from "./session";
import { AiReviewSettings } from "./settings";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
}

export interface Candidate extends Finding {
  id: string;
  pass: PassName;
}

export interface ScoredFinding extends Candidate {
  score: number;
  reason: string;
}

export type SessionFn = (spec: SessionSpec) => Promise<SessionResult>;

export interface PipelineResult {
  findings: ScoredFinding[];
  costUsd: number;
  passes: PassName[];
  failedPasses: PassName[];
  skippedCandidates: number;
  scoredCandidates: number;
  failedCandidates: number;
  timedOut: boolean;
}

// Caps and budgets from the spike's config D.
export const PASS_TURNS: Record<PassName, number> = { claims: 14, rules: 11 };
export const PASS_SOFT_CALLS: Record<PassName, number> = { claims: 10, rules: 8 };
export const SCORER_TURNS = 10;
export const SCORER_SOFT_CALLS = 8;
export const PASS_BUDGET_USD = 1.0;
export const SCORER_BUDGET_USD = 0.35;
export const MIN_SESSION_USD = 0.15;
export const MAX_CANDIDATES = 6;
export const DEDUPE_LINES = 15;
export const EFFORT = "medium" as const;

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Tracks list-price spend against the review's cap. */
export class Budget {
  private spent = 0;

  constructor(private readonly capUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  charge(usd: number): void {
    this.spent += usd;
  }

  /** Returns the per-session cap for n sessions started together, or 0 when they don't fit. */
  share(n: number, perSessionMaxUsd: number): number {
    const available = this.capUsd - this.spent - SALVAGE_HEADROOM_USD * n;
    const each = Math.min(perSessionMaxUsd, available / n);
    return each >= MIN_SESSION_USD ? each : 0;
  }
}

export function mergeCandidates(outputs: { pass: PassName; result: SessionResult }[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const { pass, result } of outputs) {
    const findings = (result.output as { findings?: Finding[] } | null)?.findings ?? [];
    findings.forEach((f, i) => candidates.push({ ...f, id: `${pass}-${i}`, pass }));
  }
  return candidates;
}

/** Drops low severity, which the spike showed never survives scoring, and caps the count. */
export function selectForScoring(candidates: Candidate[]): Candidate[] {
  return candidates
    .filter((c) => c.severity !== "low")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_CANDIDATES);
}

/** Keeps findings at or above the threshold, dropping lower-scored ones near a kept one. */
export function selectFindings(scored: ScoredFinding[], threshold: number): ScoredFinding[] {
  const kept: ScoredFinding[] = [];
  const passing = scored.filter((s) => s.score >= threshold).sort((a, b) => b.score - a.score);
  for (const f of passing) {
    if (!kept.some((k) => k.path === f.path && Math.abs(k.line - f.line) <= DEDUPE_LINES)) {
      kept.push(f);
    }
  }
  return kept;
}

async function scoreOne(
  run: SessionFn,
  ws: Workspace,
  settings: AiReviewSettings,
  candidate: Candidate,
  budgetUsd: number
): Promise<{ finding: ScoredFinding | null; failed: boolean; costUsd: number }> {
  const dir = path.join(ws.root, "candidates", candidate.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "candidate.json");
  fs.writeFileSync(file, JSON.stringify(candidate, null, 2));
  const result = await run({
    label: `scorer ${candidate.id}`,
    cwd: ws.repoDir,
    addDirs: [ws.contextDir, dir],
    systemPrompt: buildScorerPrompt(SCORER_SOFT_CALLS),
    userPrompt: scorerUserPrompt(file, ws.contextDir),
    schema: SCORES_SCHEMA,
    model: settings.scorerModel,
    maxTurns: SCORER_TURNS,
    maxBudgetUsd: budgetUsd,
    effort: EFFORT,
  });
  const scores = (
    result.output as { scores?: { id: string; score: number; reason: string }[] } | null
  )?.scores;
  const score = result.ok ? scores?.find((s) => s.id === candidate.id) : undefined;
  return {
    finding: score ? { ...candidate, score: score.score, reason: score.reason } : null,
    failed: !score,
    costUsd: result.costUsd,
  };
}

/** Runs the passes in parallel, then one scorer per selected candidate, within the cost cap. */
export async function runPipeline(
  run: SessionFn,
  ws: Workspace,
  settings: AiReviewSettings,
  signal?: AbortSignal
): Promise<PipelineResult> {
  const budget = new Budget(settings.maxCostUsd);
  const passes: PassName[] = ws.ruleFiles.length > 0 ? ["claims", "rules"] : ["claims"];
  const perPass = budget.share(passes.length, PASS_BUDGET_USD);
  const passResults = await Promise.all(
    passes.map(async (pass) => ({
      pass,
      result: await run({
        label: pass,
        cwd: ws.repoDir,
        addDirs: [ws.contextDir],
        systemPrompt: buildPassPrompt(pass, PASS_SOFT_CALLS[pass], ws.guidance),
        userPrompt: passUserPrompt(ws.contextDir),
        schema: FINDINGS_SCHEMA,
        model: settings.reviewerModel,
        maxTurns: PASS_TURNS[pass],
        maxBudgetUsd: perPass,
        effort: EFFORT,
      }),
    }))
  );
  passResults.forEach((p) => budget.charge(p.result.costUsd));
  const failedPasses = passResults.filter((p) => !p.result.ok).map((p) => p.pass);

  const eligible = selectForScoring(mergeCandidates(passResults.filter((p) => p.result.ok)));
  let toScore = signal?.aborted ? [] : eligible;
  let perScorer = 0;
  while (
    toScore.length > 0 &&
    (perScorer = budget.share(toScore.length, SCORER_BUDGET_USD)) === 0
  ) {
    toScore = toScore.slice(0, -1);
  }
  const scored = await Promise.all(toScore.map((c) => scoreOne(run, ws, settings, c, perScorer)));
  scored.forEach((s) => budget.charge(s.costUsd));

  return {
    findings: selectFindings(
      scored.flatMap((s) => (s.finding ? [s.finding] : [])),
      settings.threshold
    ),
    costUsd: budget.spentUsd,
    passes,
    failedPasses,
    skippedCandidates: eligible.length - toScore.length,
    scoredCandidates: toScore.length,
    failedCandidates: scored.filter((s) => s.failed).length,
    timedOut: signal?.aborted ?? false,
  };
}
