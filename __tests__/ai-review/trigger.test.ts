import { evaluateGates, GateInput, isAiReviewCommand } from "../../src/ai-review/trigger";

const settings = {
  endpoint: "https://x/api/v2",
  reviewerModel: "m",
  scorerModel: "m",
  threshold: 70,
  maxCostUsd: 3,
};

const ok: GateInput = {
  kind: "label",
  settings,
  aiToken: "t",
  prState: "open",
  headRepo: "acme/api",
  baseRepo: "acme/api",
  authorType: "User",
};

describe("isAiReviewCommand", () => {
  it.each([
    ["/ai-review", true],
    ["  /ai-review  ", true],
    ["/ai-review please", true],
    ["/ai-review\nthanks", true],
    ["/review", false],
    ["/ai-reviews", false],
    ["please /ai-review", false],
    ["", false],
  ])("%j -> %s", (body, expected) => {
    expect(isAiReviewCommand(body)).toBe(expected);
  });

  it("handles an undefined body", () => {
    expect(isAiReviewCommand(undefined)).toBe(false);
  });
});

describe("evaluateGates", () => {
  it("runs when every gate passes", () => {
    expect(evaluateGates(ok)).toEqual({ run: true, settings });
  });

  it.each<[string, Partial<GateInput>, string]>([
    ["no settings", { settings: null }, "not enabled for this repo"],
    ["no token", { aiToken: "" }, "no ai-token"],
    ["closed PR", { prState: "closed" }, "PR is not open"],
    ["fork PR", { headRepo: "evil/api" }, "PR is from a fork"],
    ["deleted fork", { headRepo: undefined }, "PR is from a fork"],
    ["bot author on label", { authorType: "Bot" }, "PR author is a bot"],
  ])("skips on %s", (_name, override, reason) => {
    expect(evaluateGates({ ...ok, ...override })).toEqual({ run: false, reason });
  });

  it("lets a trusted commenter review a bot PR", () => {
    const result = evaluateGates({
      ...ok,
      kind: "comment",
      authorType: "Bot",
      commenterAssociation: "MEMBER",
    });
    expect(result.run).toBe(true);
  });

  it.each(["MEMBER", "OWNER", "COLLABORATOR"])("accepts a %s commenter", (association) => {
    expect(evaluateGates({ ...ok, kind: "comment", commenterAssociation: association }).run).toBe(
      true
    );
  });

  it.each(["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR", undefined])(
    "rejects a %s commenter",
    (association) => {
      expect(evaluateGates({ ...ok, kind: "comment", commenterAssociation: association })).toEqual({
        run: false,
        reason: "commenter is not a member or collaborator",
      });
    }
  );
});
