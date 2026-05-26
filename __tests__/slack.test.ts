import { buildSlackMessage, sendSlackNotification } from "../src/slack";

describe("buildSlackMessage", () => {
  it("formats a review notification message", () => {
    const message = buildSlackMessage({
      prUrl: "https://github.com/org/repo/pull/1",
      prTitle: "Add feature X",
      prNumber: 1,
      repoName: "repo",
      author: "alice",
      files: ["src/app.py", "src/utils.py"],
    });

    expect(message).toContain("https://github.com/org/repo/pull/1");
    expect(message).toContain("Add feature X");
    expect(message).toContain("alice");
    expect(message).toContain("src/app.py");
    expect(message).toContain("src/utils.py");
  });
});

describe("sendSlackNotification", () => {
  it("returns early when no token is provided", async () => {
    await expect(
      sendSlackNotification("", "#channel", "message")
    ).resolves.not.toThrow();
  });
});
