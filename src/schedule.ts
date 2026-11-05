import * as core from "@actions/core";
import * as yaml from "js-yaml";
import { POLICY_PATH } from "./gate/policy";
import { Octokit, RemindersConfig } from "./types";

const DEFAULT_STALE_HOURS = 24;
const DEFAULT_TICK_MINUTES = 60;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const NUMBER_KEYS = ["stale_hours", "interval_hours", "tick_minutes"] as const;

export interface ReminderSettings {
  enabled: boolean;
  staleHours: number;
  intervalHours: number | undefined;
  tickMinutes: number;
}

/** The repo layer wins over the org layer, key by key. */
export function resolveReminders(
  org: RemindersConfig | undefined,
  repo: Partial<RemindersConfig> | undefined
): ReminderSettings {
  const merged = { ...org, ...repo };
  return {
    enabled: merged.enabled ?? false,
    staleHours: merged.stale_hours ?? DEFAULT_STALE_HOURS,
    intervalHours: merged.interval_hours,
    tickMinutes: merged.tick_minutes ?? DEFAULT_TICK_MINUTES,
  };
}

/**
 * True when a scheduled run falls in the window in which a reminder is due. Reminders repeat
 * every interval after the PR turned stale, and the window is one tick long, so a run that
 * comes once per tick lands in it once. Without an interval every run sends one.
 */
export function reminderDue(
  sinceStaleMs: number,
  intervalHours: number | undefined,
  tickMinutes: number
): boolean {
  if (intervalHours === undefined) return true;
  return sinceStaleMs % (intervalHours * HOUR_MS) < tickMinutes * MINUTE_MS;
}

/**
 * Reads the `reminders` block of the policy text. Returns undefined when there is none.
 * Throws when the block is not a mapping of known keys with the right types.
 */
export function parseRepoReminders(text: string): Partial<RemindersConfig> | undefined {
  const parsed = yaml.load(text);
  const block = (parsed as { reminders?: unknown } | null | undefined)?.reminders;
  if (block === undefined) return undefined;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("reminders must be a mapping.");
  }
  const result: Partial<RemindersConfig> = {};
  for (const [key, value] of Object.entries(block)) {
    if (key === "enabled") {
      if (typeof value !== "boolean") throw new Error("reminders.enabled must be true or false.");
      result.enabled = value;
    } else if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      if (!Number.isInteger(value) || (value as number) < 1) {
        throw new Error(`reminders.${key} must be a whole number of 1 or more.`);
      }
      result[key as (typeof NUMBER_KEYS)[number]] = value as number;
    } else {
      throw new Error(`reminders.${key} is not a known setting.`);
    }
  }
  return result;
}

/**
 * The repo layer of the reminder settings, from the policy file on the default branch. Never
 * throws: a missing file or an invalid block leaves the org settings in force.
 */
export async function readRepoReminders(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string
): Promise<Partial<RemindersConfig> | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: POLICY_PATH,
      ref: defaultBranch,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return undefined;
    return parseRepoReminders(Buffer.from(data.content, "base64").toString("utf8"));
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(`Ignoring the reminders block of ${POLICY_PATH}: ${reason}`);
    return undefined;
  }
}
