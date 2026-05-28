import { buildSlackAttachment, sendSlackNotification } from "../src/slack";

const params = {
  prUrl: "https://github.com/org/repo/pull/1",
  prTitle: "Add feature X",
  prNumber: 1,
  repoName: "repo",
  author: "alice",
  additions: 15,
  deletions: 3,
  allFiles: [
    { filename: "src/app.py", additions: 10, deletions: 2 },
    { filename: "src/utils.py", additions: 5, deletions: 1 },
  ],
};

describe("buildSlackAttachment", () => {
  it("formats an EngProd-style attachment", () => {
    const attachment = buildSlackAttachment(params);
    expect(attachment.text).toContain("PR by *alice* needs a review:");
    expect(attachment.text).toContain("`+15 -3`");
    expect(attachment.text).toContain("repo#1: Add feature X");
    expect(attachment.text).toContain("• src/app.py `+10 -2`");
    expect(attachment.text).toContain("• src/utils.py `+5 -1`");
    expect(attachment.color).toBe("#1a7ccc");
  });

  it("has a plain text fallback", () => {
    const attachment = buildSlackAttachment(params);
    expect(attachment.fallback).toContain("repo#1");
    expect(attachment.fallback).toContain("alice");
    expect(attachment.fallback).not.toContain("*");
  });
});

describe("sendSlackNotification", () => {
  it("returns early when no token is provided", async () => {
    await expect(
      sendSlackNotification("", "#channel", params)
    ).resolves.not.toThrow();
  });
});
