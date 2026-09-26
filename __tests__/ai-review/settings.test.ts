import { resolveAiReviewSettings } from "../../src/ai-review/settings";
import { OrgConfig } from "../../src/types";

const base: OrgConfig = { teams: {} };
const aiReview = {
  enabled: true,
  repos: ["api"],
  endpoint: "https://app.eu.datarobot.com/api/v2/",
  models: { reviewer: "rev-model", scorer: "score-model" },
};

describe("resolveAiReviewSettings", () => {
  it("returns null when the block is missing", () => {
    expect(resolveAiReviewSettings(base, "api")).toBeNull();
  });

  it("returns null when disabled", () => {
    expect(
      resolveAiReviewSettings({ ...base, ai_review: { ...aiReview, enabled: false } }, "api")
    ).toBeNull();
  });

  it("returns null for a repo not in the allowlist", () => {
    expect(resolveAiReviewSettings({ ...base, ai_review: aiReview }, "web")).toBeNull();
  });

  it("applies defaults and trims the endpoint's trailing slash", () => {
    expect(resolveAiReviewSettings({ ...base, ai_review: aiReview }, "api")).toEqual({
      endpoint: "https://app.eu.datarobot.com/api/v2",
      reviewerModel: "rev-model",
      scorerModel: "score-model",
      threshold: 70,
      maxCostUsd: 3,
    });
  });

  it("keeps explicit threshold and cost cap", () => {
    const settings = resolveAiReviewSettings(
      { ...base, ai_review: { ...aiReview, threshold: 80, max_cost_usd: 1.5 } },
      "api"
    );
    expect(settings?.threshold).toBe(80);
    expect(settings?.maxCostUsd).toBe(1.5);
  });
});
