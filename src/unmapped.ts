import * as core from "@actions/core";

const NAMED_LIMIT = 20;
const BOT_SUFFIX = "[bot]";

const unmapped = new Map<string, string>();

/** Records a GitHub login that a notification skipped because the config has no Slack user for it. */
export function noteUnmapped(login: string): void {
  if (login.endsWith(BOT_SUFFIX)) return;
  const key = login.toLowerCase();
  if (!unmapped.has(key)) unmapped.set(key, login);
}

/** Returns the logins recorded so far, once each, and clears the record. */
export function takeUnmapped(): string[] {
  const logins = [...unmapped.values()];
  unmapped.clear();
  return logins;
}

/** Adds one notice to the run for the logins that were skipped, so a rollout gap shows in the run. */
export function reportUnmapped(): void {
  const logins = takeUnmapped();
  if (logins.length === 0) return;
  const named = logins.slice(0, NAMED_LIMIT).join(", ");
  const more = logins.length > NAMED_LIMIT ? `, and ${logins.length - NAMED_LIMIT} more` : "";
  const subject =
    logins.length === 1 ? "1 GitHub login has" : `${logins.length} GitHub logins have`;
  core.notice(
    `${subject} no Slack user in the config, so notifications for them were skipped: ${named}${more}. Add them under users.`
  );
}
