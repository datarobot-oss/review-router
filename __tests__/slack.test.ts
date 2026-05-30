import { buildSlackBlocks, sendSlackNotification } from "../src/slack";

const params = {
  prUrl: "https://github.com/org/repo/pull/1",
  prTitle: "Add feature X",
  prNumber: 1,
  orgName: "org",
  repoName: "repo",
  baseBranch: "main",
  author: "alice",
  additions: 15,
  deletions: 3,
  allFiles: [
    { filename: "src/app.py", additions: 10, deletions: 2 },
    { filename: "src/utils.py", additions: 5, deletions: 1 },
  ],
};

describe("buildSlackBlocks", () => {
  it("builds Block Kit structure with header, context, files, and button", () => {
    const { blocks } = buildSlackBlocks(params);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].type).toBe("section");
    expect(blocks[1].type).toBe("context");
    expect(blocks[2].type).toBe("section");
    expect(blocks[3].type).toBe("actions");
  });

  it("includes PR link with org, diff stats, base branch, and title", () => {
    const { blocks } = buildSlackBlocks(params);
    const header = blocks[0].text!.text;
    expect(header).toContain(":pencil2:");
    expect(header).toContain("<https://github.com/org/repo/pull/1|org/repo#1>");
    expect(header).toContain("`+15 -3`");
    expect(header).toContain("to be merged in `main`");
    expect(header).toContain("Add feature X");
  });

  it("includes author without diff stats in context", () => {
    const { blocks } = buildSlackBlocks(params);
    const context = blocks[1].elements![0].text as string;
    expect(context).toContain("alice");
    expect(context).not.toContain("+15");
  });

  it("lists files as code with per-file stats", () => {
    const { blocks } = buildSlackBlocks(params);
    const files = blocks[2].text!.text;
    expect(files).toContain("*Changes:*");
    expect(files).toContain("• `src/app.py` `+10 -2`");
    expect(files).toContain("• `src/utils.py` `+5 -1`");
  });

  it("has a View PR button with correct URL", () => {
    const { blocks } = buildSlackBlocks(params);
    const button = blocks[3].elements![0];
    expect((button.text as { text: string }).text).toBe("View PR");
    expect(button.url).toBe("https://github.com/org/repo/pull/1");
  });

  it("has a plain text fallback", () => {
    const { fallback } = buildSlackBlocks(params);
    expect(fallback).toContain("repo#1");
    expect(fallback).toContain("alice");
    expect(fallback).not.toContain("*");
  });
});

describe("sendSlackNotification", () => {
  it("returns early when no token is provided", async () => {
    await expect(
      sendSlackNotification("", "#channel", params)
    ).resolves.not.toThrow();
  });
});
