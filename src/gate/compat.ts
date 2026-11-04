import * as core from "@actions/core";
import { DependencyFacts } from "./dependabot";

const BADGE_URL = "https://dependabot-badges.githubapp.com/badges/compatibility_score";
const TIMEOUT_MS = 10_000;
const MAX_LOOKUPS = 30;
const BATCH_SIZE = 8;
const SCORE = /aria-label="compatibility: (\d{1,3})%"/;

// A host that fails this many requests in a row is skipped for the rest of the run, so a black
// hole costs seconds on a sweep of many pull requests, not minutes.
const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveFailures = 0;

/** Forgets earlier failures. Only tests need it: a run is one process. */
export function resetCompatibilityBreaker(): void {
  consecutiveFailures = 0;
}

type FetchFn = (
  url: string,
  init: { signal: AbortSignal; redirect: "error" }
) => Promise<{
  ok: boolean;
  text: () => Promise<string>;
}>;

/** The badge Dependabot shows for the bump, built from the dependency and its two versions. */
export function badgeUrl(dep: DependencyFacts): string | undefined {
  if (!dep.previous || !dep.version) return undefined;
  const query = new URLSearchParams({
    "dependency-name": dep.name,
    "package-manager": dep.ecosystem,
    "previous-version": dep.previous,
    "new-version": dep.version,
  });
  return `${BADGE_URL}?${query}`;
}

/**
 * Reads the Dependabot compatibility score of a bump, 0 to 100. Returns undefined for an unknown
 * score and for every failure, which the gate treats as "no score". Never throws.
 */
export async function fetchCompatibility(
  dep: DependencyFacts,
  fetchFn: FetchFn = fetch as unknown as FetchFn
): Promise<number | undefined> {
  const url = badgeUrl(dep);
  if (!url || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return undefined;
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // The answer must come from the badge host and nowhere else.
      redirect: "error",
    });
    consecutiveFailures = 0;
    if (!response.ok) return undefined;
    const match = SCORE.exec((await response.text()).slice(0, 5000));
    const score = match ? Number(match[1]) : undefined;
    return score !== undefined && score <= 100 ? score : undefined;
  } catch (error) {
    consecutiveFailures += 1;
    core.info(
      `No compatibility score for ${dep.name}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/** Adds the score to each dependency. Looks up at most 30, in small batches. */
export async function addCompatibility(
  dependencies: DependencyFacts[],
  fetchFn?: FetchFn
): Promise<DependencyFacts[]> {
  const result = dependencies.map((dep) => ({ ...dep }));
  const looked = result.slice(0, MAX_LOOKUPS);
  for (let start = 0; start < looked.length; start += BATCH_SIZE) {
    const batch = looked.slice(start, start + BATCH_SIZE);
    const scores = await Promise.all(batch.map((dep) => fetchCompatibility(dep, fetchFn)));
    batch.forEach((dep, index) => {
      dep.compatibility = scores[index];
    });
  }
  return result;
}
