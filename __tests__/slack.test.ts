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
  it("builds 7-block structure: header, title, author context, divider, files, footer, button", () => {
    const { blocks } = buildSlackBlocks(params);
    expect(blocks).toHaveLength(7);
    expect(blocks[0].type).toBe("section");
    expect(blocks[1].type).toBe("section");
    expect(blocks[2].type).toBe("context");
    expect(blocks[3].type).toBe("divider");
    expect(blocks[4].type).toBe("section");
    expect(blocks[5].type).toBe("context");
    expect(blocks[6].type).toBe("actions");
  });

  it("has review requested header with PR link and diff stats", () => {
    const { blocks } = buildSlackBlocks(params);
    const header = blocks[0].text.text;
    expect(header).toContain(":rr-mag:");
    expect(header).toContain("Review requested");
    expect(header).toContain("<https://github.com/org/repo/pull/1|org/repo #1>");
    expect(header).toContain("`+15 -3`");
  });

  it("has bold PR title", () => {
    const { blocks } = buildSlackBlocks(params);
    expect(blocks[1].text.text).toBe("*Add feature X*");
  });

  it("has author context with avatar and merge target", () => {
    const { blocks } = buildSlackBlocks(params);
    const elements = blocks[2].elements;
    expect(elements).toHaveLength(2);
    expect(elements[0].type).toBe("image");
    expect(elements[0].image_url).toBe("https://github.com/alice.png?size=24");
    expect(elements[0].alt_text).toBe("alice");
    expect(elements[1].text).toContain("*alice*");
    expect(elements[1].text).toContain("wants to merge into `main`");
  });

  it("lists files with header and per-file stats", () => {
    const { blocks } = buildSlackBlocks(params);
    const files = blocks[4].text.text;
    expect(files).toContain("*Files changed:*");
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
    const files = blocks[4].text.text;
    expect(files).toContain("`src/file9.ts`");
    expect(files).not.toContain("`src/file10.ts`");
    expect(files).toContain("and 5 more files");
  });

  it("has a footer with branch, commits, files, and labels in backticks", () => {
    const { blocks } = buildSlackBlocks(params);
    const footer = blocks[5].elements[0].text;
    expect(footer).toContain("`main`");
    expect(footer).toContain("3 commits");
    expect(footer).toContain("2 files");
    expect(footer).toContain("`enhancement` · `ci/cd`");
  });

  it("omits labels from footer when none present", () => {
    const { blocks } = buildSlackBlocks({ ...params, labels: [] });
    const footer = blocks[5].elements[0].text;
    expect(footer).not.toContain(":rr-label:");
  });

  it("has View pull request button after footer", () => {
    const { blocks } = buildSlackBlocks(params);
    const button = blocks[6].elements[0];
    expect(button.text.text).toBe("View pull request");
    expect(button.url).toBe("https://github.com/org/repo/pull/1");
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
    await expect(sendSlackNotification("", "#channel", params)).resolves.not.toThrow();
  });
});
