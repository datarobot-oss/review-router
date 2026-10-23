import { OrgConfig } from "../types";
import { Effort } from "./session";

export const DEFAULT_THRESHOLD = 70;
export const DEFAULT_MAX_COST_USD = 3;
export const DEFAULT_EFFORT: Effort = "medium";

/** AI review settings resolved for one repo, with defaults applied. */
export interface AiReviewSettings {
  endpoint: string;
  reviewerModel: string;
  scorerModel: string;
  reviewerEffort: Effort;
  scorerEffort: Effort;
  threshold: number;
  maxCostUsd: number;
}

/** Returns the repo's AI review settings, or null when the feature is off for it. */
export function resolveAiReviewSettings(org: OrgConfig, repo: string): AiReviewSettings | null {
  const config = org.ai_review;
  if (!config?.enabled || !config.repos.includes(repo)) return null;
  return {
    endpoint: config.endpoint.replace(/\/+$/, ""),
    reviewerModel: config.models.reviewer,
    scorerModel: config.models.scorer,
    reviewerEffort: config.effort?.reviewer ?? DEFAULT_EFFORT,
    scorerEffort: config.effort?.scorer ?? DEFAULT_EFFORT,
    threshold: config.threshold ?? DEFAULT_THRESHOLD,
    maxCostUsd: config.max_cost_usd ?? DEFAULT_MAX_COST_USD,
  };
}
