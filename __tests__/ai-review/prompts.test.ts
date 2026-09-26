import {
  buildPassPrompt,
  buildScorerPrompt,
  FINDINGS_SCHEMA,
  MAX_GUIDANCE_CHARS,
  passUserPrompt,
  scorerUserPrompt,
} from "../../src/ai-review/prompts";

describe("buildPassPrompt", () => {
  it("starts with the trust boundary before any focus text", () => {
    const prompt = buildPassPrompt("claims", 10, "");
    expect(prompt.indexOf("## Trust boundary")).toBeGreaterThan(-1);
    expect(prompt.indexOf("## Trust boundary")).toBeLessThan(prompt.indexOf("## Your focus"));
  });

  it("puts the soft budget in the focus section", () => {
    expect(buildPassPrompt("rules", 8, "")).toContain("Budget: about 8 tool calls.");
  });

  it("omits the guidance section when there is none", () => {
    expect(buildPassPrompt("claims", 10, "  ")).not.toContain("## Repository guidance");
  });

  it("fences guidance, places it last, and truncates it", () => {
    const prompt = buildPassPrompt("claims", 10, "x".repeat(MAX_GUIDANCE_CHARS + 500));
    const at = prompt.indexOf("## Repository guidance");
    expect(at).toBeGreaterThan(prompt.indexOf("## Your focus"));
    expect(prompt).toContain("<guidance>");
    expect(prompt).toContain("</guidance>");
    expect(prompt.length).toBeLessThan(at + MAX_GUIDANCE_CHARS + 600);
  });
});

describe("buildScorerPrompt", () => {
  it("carries the rubric and the unchanged-caller carve-out", () => {
    const prompt = buildScorerPrompt(8);
    expect(prompt).toContain("- 75: Highly confident.");
    expect(prompt).toContain("still counts when this diff causes or exposes it");
  });
});

describe("user prompts", () => {
  it("name the context directory and the candidate file", () => {
    expect(passUserPrompt("/tmp/ctx")).toContain("/tmp/ctx");
    expect(scorerUserPrompt("/tmp/c/candidate.json", "/tmp/ctx")).toContain(
      "/tmp/c/candidate.json"
    );
  });
});

describe("FINDINGS_SCHEMA", () => {
  it("caps findings at 4", () => {
    expect(FINDINGS_SCHEMA.properties.findings.maxItems).toBe(4);
  });
});
