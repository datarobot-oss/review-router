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
  commits: 3,
  labels: ["enhancement", "ci/cd"],
  allFiles: [
    { filename: "src/app.py", additions: 10, deletions: 2 },
    { filename: "src/utils.py", additions: 5, deletions: 1 },
  ],
};

describe("buildSlackBlocks", () => {
  it("builds 5-block structure: header, fields, files, button, footer", () => {
    const { blocks } = buildSlackBlocks(params);
    expect(blocks).toHaveLength(5);
    expect(blocks[0].type).toBe("section");
    expect(blocks[1].type).toBe("section");
    expect(blocks[2].type).toBe("section");
    expect(blocks[3].type).toBe("actions");
    expect(blocks[4].type).toBe("context");
  });

  it("includes PR title as link and repo info in header", () => {
    const { blocks } = buildSlackBlocks(params);
    const header = blocks[0].text!.text;
    expect(header).toContain(":mag:");
    expect(header).toContain("Pull request ready for review");
    expect(header).toContain("<https://github.com/org/repo/pull/1|Add feature X>");
    expect(header).toContain("org/repo #1");
  });

  it("has scannable fields with author, branch, changes, commits, files, labels", () => {
    const { blocks } = buildSlackBlocks(params);
    const fields = blocks[1].fields!;
    expect(fields).toHaveLength(6);
    expect(fields[0].text).toContain("alice");
    expect(fields[1].text).toContain("`main`");
    expect(fields[2].text).toContain("`+15 -3`");
    expect(fields[3].text).toContain("3");
    expect(fields[4].text).toContain("2");
    expect(fields[5].text).toContain("enhancement");
    expect(fields[5].text).toContain("ci/cd");
  });

  it("lists files with per-file stats", () => {
    const { blocks } = buildSlackBlocks(params);
    const files = blocks[2].text!.text;
    expect(files).toContain("• `src/app.py` `+10 -2`");
    expect(files).toContain("• `src/utils.py` `+5 -1`");
  });

  it("truncates file list beyond 10 files", () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => ({
      filename: `src/file${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const { blocks } = buildSlackBlocks({ ...params, allFiles: manyFiles });
    const files = blocks[2].text!.text;
    expect(files).toContain("`src/file9.ts`");
    expect(files).not.toContain("`src/file10.ts`");
    expect(files).toContain("and 5 more files");
  });

  it("has a View pull request button", () => {
    const { blocks } = buildSlackBlocks(params);
    const button = blocks[3].elements![0];
    expect((button.text as { text: string }).text).toBe("View pull request");
    expect(button.url).toBe("https://github.com/org/repo/pull/1");
  });

  it("has a footer with branch, commits, files, and labels", () => {
    const { blocks } = buildSlackBlocks(params);
    const footer = blocks[4].elements![0].text as string;
    expect(footer).toContain("`main`");
    expect(footer).toContain("3 commits");
    expect(footer).toContain("2 files");
    expect(footer).toContain("enhancement, ci/cd");
  });

  it("shows dash for labels when none present", () => {
    const { blocks } = buildSlackBlocks({ ...params, labels: [] });
    const fields = blocks[1].fields!;
    expect(fields[5].text).toContain("—");
  });

  it("omits labels from footer when none present", () => {
    const { blocks } = buildSlackBlocks({ ...params, labels: [] });
    const footer = blocks[4].elements![0].text as string;
    expect(footer).not.toContain(":label:");
  });

  it("has a plain text fallback", () => {
    const { fallback } = buildSlackBlocks(params);
    expect(fallback).toContain("org/repo#1");
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
