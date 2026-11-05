import { Octokit } from "./types";

/** A scheduled run stops when less than this share of the hourly API budget remains. */
const MIN_REMAINING_SHARE = 0.2;

export interface Quota {
  remaining: number;
  limit: number;
}

/** The core API budget of the token. The endpoint costs no quota. Undefined when it can't be read. */
export async function readQuota(octokit: Octokit): Promise<Quota | undefined> {
  try {
    const { data } = await octokit.rest.rateLimit.get();
    const { remaining, limit } = data.resources.core;
    return { remaining, limit };
  } catch {
    return undefined;
  }
}

export function quotaLow(quota: Quota): boolean {
  return quota.remaining < quota.limit * MIN_REMAINING_SHARE;
}
