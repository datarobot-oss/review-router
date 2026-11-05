import * as core from "@actions/core";
import {
  parseRepoReminders,
  readRepoReminders,
  reminderDue,
  resolveReminders,
} from "../src/schedule";

jest.mock("@actions/core");

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe("reminderDue", () => {
  it("is always due when no interval is set", () => {
    expect(reminderDue(0, undefined, 60)).toBe(true);
    expect(reminderDue(7 * HOUR + 13 * MINUTE, undefined, 60)).toBe(true);
  });

  it.each([
    ["at the moment the PR turns stale", 0, true],
    ["just inside the first window", 59 * MINUTE, true],
    ["at the end of the window, which is excluded", 60 * MINUTE, false],
    ["in the middle of the interval", 3 * HOUR, false],
    ["at the next interval", 6 * HOUR, true],
    ["inside the next interval's window", 6 * HOUR + 30 * MINUTE, true],
    ["past the next interval's window", 6 * HOUR + 90 * MINUTE, false],
    ["inside a later interval's window", 12 * HOUR + 10 * MINUTE, true],
  ])("with a 6 hour interval and a 60 minute tick, %s", (_name, sinceStale, expected) => {
    expect(reminderDue(sinceStale, 6, 60)).toBe(expected);
  });

  it("is due on every run when the tick covers the whole interval", () => {
    expect(reminderDue(5 * HOUR, 6, 360)).toBe(true);
  });
});

describe("resolveReminders", () => {
  it("applies the defaults to an org block that sets only enabled", () => {
    expect(resolveReminders({ enabled: true }, undefined)).toEqual({
      enabled: true,
      staleHours: 24,
      intervalHours: undefined,
      tickMinutes: 60,
    });
  });

  it("lets the repo override single keys of the org block", () => {
    const org = { enabled: true, stale_hours: 48, interval_hours: 12 };
    expect(resolveReminders(org, { interval_hours: 6, tick_minutes: 30 })).toEqual({
      enabled: true,
      staleHours: 48,
      intervalHours: 6,
      tickMinutes: 30,
    });
  });

  it("lets the repo turn reminders off", () => {
    expect(resolveReminders({ enabled: true }, { enabled: false }).enabled).toBe(false);
  });

  it("stays off when neither layer enables reminders", () => {
    expect(resolveReminders(undefined, undefined).enabled).toBe(false);
    expect(resolveReminders(undefined, { stale_hours: 12 }).enabled).toBe(false);
  });

  it("lets the repo turn reminders on when the org block is absent", () => {
    expect(resolveReminders(undefined, { enabled: true }).enabled).toBe(true);
  });
});

describe("parseRepoReminders", () => {
  it("returns undefined for a file with no reminders block", () => {
    expect(parseRepoReminders("dependabot:\n  allowed_paths: [a.txt]\n")).toBeUndefined();
  });

  it.each([
    ["an empty file", ""],
    ["a file of blank lines", "\n\n"],
    ["a comment-only stub", "# Review Router policy\n\n# dependabot:\n"],
    ["a document that is only null", "---\n"],
  ])("returns undefined for %s", (_name, text) => {
    expect(parseRepoReminders(text)).toBeUndefined();
  });

  it("reads every supported key and ignores the other blocks", () => {
    const text = [
      "dependabot:",
      "  allowed_paths: [a.txt]",
      "reminders:",
      "  enabled: true",
      "  stale_hours: 12",
      "  interval_hours: 6",
      "  tick_minutes: 60",
    ].join("\n");
    expect(parseRepoReminders(text)).toEqual({
      enabled: true,
      stale_hours: 12,
      interval_hours: 6,
      tick_minutes: 60,
    });
  });

  it.each([
    ["an unknown key", "reminders:\n  every: 3\n", /every/],
    ["a zero interval", "reminders:\n  interval_hours: 0\n", /interval_hours/],
    ["a fractional tick", "reminders:\n  tick_minutes: 1.5\n", /tick_minutes/],
    ["a string number", 'reminders:\n  stale_hours: "24"\n', /stale_hours/],
    ["a non-boolean enabled", "reminders:\n  enabled: yes please\n", /enabled/],
    ["a block that is not a mapping", "reminders: [1, 2]\n", /reminders/],
    ["a YAML syntax error", "reminders: [\n", /./],
  ])("throws for %s", (_name, text, message) => {
    expect(() => parseRepoReminders(text)).toThrow(message);
  });
});

describe("readRepoReminders", () => {
  function octokitReturning(result: { content?: string; error?: { status: number } }) {
    return {
      rest: {
        repos: {
          getContent: jest.fn(async () => {
            if (result.error) throw Object.assign(new Error("failed"), result.error);
            return {
              data: {
                type: "file",
                content: Buffer.from(result.content ?? "").toString("base64"),
              },
            };
          }),
        },
      },
    } as never;
  }

  beforeEach(() => jest.clearAllMocks());

  it("returns the repo block from the default branch", async () => {
    const octokit = octokitReturning({ content: "reminders:\n  interval_hours: 4\n" });
    await expect(readRepoReminders(octokit, "o", "r", "main")).resolves.toEqual({
      interval_hours: 4,
    });
    expect(
      (octokit as { rest: { repos: { getContent: jest.Mock } } }).rest.repos.getContent
    ).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      path: ".github/review-router.yml",
      ref: "main",
    });
  });

  it("returns undefined without a warning when the repo has no policy file", async () => {
    const octokit = octokitReturning({ error: { status: 404 } });
    await expect(readRepoReminders(octokit, "o", "r", "main")).resolves.toBeUndefined();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("returns undefined without a warning for a comment-only policy stub", async () => {
    const octokit = octokitReturning({ content: "# Review Router policy\n" });
    await expect(readRepoReminders(octokit, "o", "r", "main")).resolves.toBeUndefined();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("ignores an invalid block and warns, so the org settings apply", async () => {
    const octokit = octokitReturning({ content: "reminders:\n  interval_hours: 0\n" });
    await expect(readRepoReminders(octokit, "o", "r", "main")).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("interval_hours"));
  });

  it("returns undefined and warns on an API error instead of throwing", async () => {
    const octokit = octokitReturning({ error: { status: 500 } });
    await expect(readRepoReminders(octokit, "o", "r", "main")).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalled();
  });
});
