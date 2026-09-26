import { AiReviewSettings } from "./settings";

export const AI_REVIEW_COMMAND = "/ai-review";

export type TriggerKind = "label" | "comment";

const TRUSTED_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);

/** Returns whether a comment body is the AI review command. */
export function isAiReviewCommand(body: string | undefined): boolean {
  const text = (body ?? "").trim();
  return text === AI_REVIEW_COMMAND || /^\/ai-review\s/.test(text);
}

export interface GateInput {
  kind: TriggerKind;
  settings: AiReviewSettings | null;
  aiToken: string;
  prState: string;
  headRepo: string | undefined;
  baseRepo: string | undefined;
  authorType: string | undefined;
  commenterAssociation?: string;
}

export type GateResult = { run: true; settings: AiReviewSettings } | { run: false; reason: string };

/** Decides whether the AI review runs, checking gates in the spec's order. */
export function evaluateGates(input: GateInput): GateResult {
  if (!input.settings) return { run: false, reason: "not enabled for this repo" };
  if (!input.aiToken) return { run: false, reason: "no ai-token" };
  if (input.prState !== "open") return { run: false, reason: "PR is not open" };
  // pull_request_target gives fork PRs full secrets, so this gate is a hard boundary.
  if (!input.headRepo || input.headRepo !== input.baseRepo) {
    return { run: false, reason: "PR is from a fork" };
  }
  if (input.kind === "label" && input.authorType === "Bot") {
    return { run: false, reason: "PR author is a bot" };
  }
  if (input.kind === "comment" && !TRUSTED_ASSOCIATIONS.has(input.commenterAssociation ?? "")) {
    return { run: false, reason: "commenter is not a member or collaborator" };
  }
  return { run: true, settings: input.settings };
}
