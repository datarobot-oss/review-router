import { buildSlackBlocks, buildSlackFallbackText, sendSlackNotification } from "../src/slack";

const params = {
  prUrl: "https://github.com/org/repo/pull/1",
  prTitle: "Add feature X",
  prNumber: 1,
  repoName: "repo",
  author: "alice",
  teamSlug: "applications",
  files: ["src/app.py", "src/utils.py"],
};

describe("buildSlackBlocks", () => {
  it("returns block kit blocks with header, PR info, files, and button", () => {
    const blocks = buildSlackBlocks(params);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].type).toBe("header");
    expect(blocks[1].type).toBe("section");
    expect(blocks[2].type).toBe("section");
    expect(blocks[3].type).toBe("actions");
  });
});

describe("buildSlackFallbackText", () => {
  it("returns a plain text summary", () => {
    const text = buildSlackFallbackText(params);
    expect(text).toContain("repo#1");
    expect(text).toContain("Add feature X");
    expect(text).toContain("alice");
  });
});

describe("sendSlackNotification", () => {
  it("returns early when no token is provided", async () => {
    await expect(
      sendSlackNotification("", "#channel", params)
    ).resolves.not.toThrow();
  });
});
