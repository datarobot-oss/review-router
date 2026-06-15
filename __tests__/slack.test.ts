import {
  buildSlackBlocks,
  buildSlackReminderBlocks,
  sendSlackNotification,
  sendSlackReminder,
  isSlackMessageMuted,
  postSlackThreadReply,
} from "../src/slack";

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
    expect(header).toContain(":mag:");
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
    expect(elements[1].text).toContain("requested a review on a PR merging into `main`");
  });

  it("lists files with header and per-file stats", () => {
    const { blocks } = buildSlackBlocks(params);
    const files = blocks[4].text.text;
    expect(files).toContain("*Files changed:*");
    expect(files).toContain("· `src/app.py` `+10 -2`");
    expect(files).toContain("· `src/utils.py` `+5 -1`");
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

  it("adds cc block with Slack mentions for individual owners", () => {
    const { blocks } = buildSlackBlocks({
      ...params,
      individualOwners: ["@johndoe", "@janedoe"],
      users: { johndoe: "U123ABC", janedoe: "U456DEF" },
    });
    const ccBlock = blocks.find(
      (b) => b.type === "context" && b.elements?.[0]?.text?.includes("cc")
    );
    expect(ccBlock).toBeDefined();
    expect(ccBlock!.elements[0].text).toContain("<@U123ABC>");
    expect(ccBlock!.elements[0].text).toContain("<@U456DEF>");
  });

  it("skips cc block when no Slack mapping exists for owners", () => {
    const { blocks } = buildSlackBlocks({
      ...params,
      individualOwners: ["@johndoe"],
      users: {},
    });
    const ccBlock = blocks.find(
      (b) => b.type === "context" && b.elements?.[0]?.text?.includes("cc")
    );
    expect(ccBlock).toBeUndefined();
  });

  it("skips cc block when no individual owners", () => {
    const { blocks } = buildSlackBlocks(params);
    const ccBlock = blocks.find(
      (b) => b.type === "context" && b.elements?.[0]?.text?.includes("cc")
    );
    expect(ccBlock).toBeUndefined();
  });

  it("skips cc block when users config is undefined", () => {
    const { blocks } = buildSlackBlocks({
      ...params,
      individualOwners: ["@johndoe"],
    });
    const ccBlock = blocks.find(
      (b) => b.type === "context" && b.elements?.[0]?.text?.includes("cc")
    );
    expect(ccBlock).toBeUndefined();
  });
});

describe("buildSlackReminderBlocks", () => {
  const reminderParams = {
    prUrl: "https://github.com/org/repo/pull/10",
    prTitle: "Stale PR",
    prNumber: 10,
    orgName: "org",
    repoName: "repo",
    teamName: "Frontend",
    ageDisplay: "2 days",
  };

  it("builds 4-block structure: header, title, context, button", () => {
    const { blocks } = buildSlackReminderBlocks(reminderParams);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].type).toBe("section");
    expect(blocks[1].type).toBe("section");
    expect(blocks[2].type).toBe("context");
    expect(blocks[3].type).toBe("actions");
  });

  it("has reminder header with PR link", () => {
    const { blocks } = buildSlackReminderBlocks(reminderParams);
    const header = blocks[0].text.text;
    expect(header).toContain(":info: *Reminder*");
    expect(header).toContain("still needs review");
    expect(header).toContain("<https://github.com/org/repo/pull/10|org/repo #10>");
  });

  it("shows age and team name in context", () => {
    const { blocks } = buildSlackReminderBlocks(reminderParams);
    const context = blocks[2].elements[0].text;
    expect(context).toContain("2 days");
    expect(context).toContain("Frontend");
  });

  it("has view PR button", () => {
    const { blocks } = buildSlackReminderBlocks(reminderParams);
    const button = blocks[3].elements[0];
    expect(button.text.text).toBe("View pull request");
    expect(button.url).toBe("https://github.com/org/repo/pull/10");
  });

  it("has plain text fallback", () => {
    const { fallback } = buildSlackReminderBlocks(reminderParams);
    expect(fallback).toContain("Reminder");
    expect(fallback).toContain("org/repo#10");
    expect(fallback).toContain("2 days");
  });
});

describe("sendSlackNotification", () => {
  it("returns early when no token is provided", async () => {
    await expect(sendSlackNotification("", "#channel", params)).resolves.not.toThrow();
  });
});

describe("sendSlackReminder", () => {
  it("returns early when no token is provided", async () => {
    await expect(
      sendSlackReminder("", "#channel", {
        prUrl: "https://github.com/org/repo/pull/1",
        prTitle: "Test",
        prNumber: 1,
        orgName: "org",
        repoName: "repo",
        teamName: "Frontend",
        ageDisplay: "1 day",
      })
    ).resolves.not.toThrow();
  });
});

describe("isSlackMessageMuted", () => {
  const mockReactionsGet = jest.fn();
  const mockWebClient = { reactions: { get: mockReactionsGet } };

  beforeEach(() => jest.clearAllMocks());

  it("returns true when :mute: reaction is present", async () => {
    mockReactionsGet.mockResolvedValue({
      message: { reactions: [{ name: "mute", users: ["U123"], count: 1 }] },
    });
    const result = await isSlackMessageMuted(mockWebClient as any, "C123", "1.0");
    expect(result).toBe(true);
  });

  it("returns true when :no_bell: reaction is present", async () => {
    mockReactionsGet.mockResolvedValue({
      message: { reactions: [{ name: "no_bell", users: ["U123"], count: 1 }] },
    });
    const result = await isSlackMessageMuted(mockWebClient as any, "C123", "1.0");
    expect(result).toBe(true);
  });

  it("returns false when no mute reactions", async () => {
    mockReactionsGet.mockResolvedValue({
      message: { reactions: [{ name: "thumbsup", users: ["U123"], count: 1 }] },
    });
    const result = await isSlackMessageMuted(mockWebClient as any, "C123", "1.0");
    expect(result).toBe(false);
  });

  it("returns false when message has no reactions field", async () => {
    mockReactionsGet.mockResolvedValue({ message: {} });
    const result = await isSlackMessageMuted(mockWebClient as any, "C123", "1.0");
    expect(result).toBe(false);
  });

  it("returns false (fail open) when reactions.get throws", async () => {
    mockReactionsGet.mockRejectedValue(new Error("scope_missing"));
    const result = await isSlackMessageMuted(mockWebClient as any, "C123", "1.0");
    expect(result).toBe(false);
  });
});

describe("postSlackThreadReply", () => {
  const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
  const mockWebClient = { chat: { postMessage: mockPostMessage } };

  beforeEach(() => jest.clearAllMocks());

  it("posts a threaded message", async () => {
    await postSlackThreadReply(mockWebClient as any, "C123", "1.0", "hello");
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1.0",
      text: "hello",
    });
  });
});
