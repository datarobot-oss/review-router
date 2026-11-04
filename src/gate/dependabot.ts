import * as yaml from "js-yaml";
import { DependabotPolicy, DependencyRule, matchesName, UpdateType } from "./policy";

const METADATA_BLOCK = /(?:^|\n)---\nupdated-dependencies:[\s\S]*?\n\.\.\./;
const UPDATE_TYPE = /^version-update:semver-(patch|minor|major)$/;
const SINGLE_BUMP = /Bumps \[([^\]]+)\]\([^)]*\) from (\S+) to (\S+)/g;
const GROUP_BUMP = /Updates `([^`]+)` from (\S+) to (\S+)/g;
const PRERELEASE = [
  /[-.](alpha|beta|rc|pre|preview|dev|snapshot|canary|next)/i,
  /\d(a|b|c|rc)\d+$/i,
];
const MAX_REASONS = 5;

/** One updated dependency of a Dependabot pull request. */
export interface DependencyFacts {
  name: string;
  ecosystem: string;
  /** From the metadata. An empty string when Dependabot gave none. */
  dependencyType: string;
  /** From the metadata. Missing for indirect dependencies and some security updates. */
  updateType?: UpdateType;
  group?: string;
  version?: string;
  previous?: string;
  /** Dependabot compatibility score. Missing when it is unknown. */
  compatibility?: number;
}

export type DependencyVerdict = { ok: true; summary: string } | { ok: false; why: string };

function trimPunctuation(version: string): string {
  return version.replace(/[.,]$/, "");
}

interface Bump {
  from: string;
  to: string;
}

/** The bumps the commit message states in words, by package name. */
function bumpsByName(message: string): Map<string, Bump[]> {
  const found = new Map<string, Bump[]>();
  for (const pattern of [SINGLE_BUMP, GROUP_BUMP]) {
    for (const [, name, from, to] of message.matchAll(pattern)) {
      found.set(name, [
        ...(found.get(name) ?? []),
        { from: trimPunctuation(from), to: trimPunctuation(to) },
      ]);
    }
  }
  return found;
}

/**
 * Picks the bump of one dependency. The metadata version can differ from the message (a real
 * commit lists 6.21.1 beside "to 6.21.2"), so the version only narrows several bumps of one name.
 * Returns undefined when two different bumps remain.
 */
function pickBump(bumps: Bump[] | undefined, version: string | undefined): Bump | undefined {
  if (!bumps?.length) return undefined;
  const narrowed = bumps.filter((bump) => bump.to === version);
  const candidates = narrowed.length > 0 ? narrowed : bumps;
  const [first] = candidates;
  return candidates.every((bump) => bump.from === first.from && bump.to === first.to)
    ? first
    : undefined;
}

function readBlock(message: string): Record<string, unknown>[] {
  const block = METADATA_BLOCK.exec(message);
  if (!block) return [];
  try {
    const doc = yaml.load(block[0].replace(/^\n?---\n/, "").replace(/\n\.\.\.$/, ""));
    const list = (doc as Record<string, unknown> | undefined)?.["updated-dependencies"];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null
    );
  } catch {
    return [];
  }
}

/**
 * Reads the dependencies Dependabot lists in its commit messages. A message with no metadata
 * block, or one that doesn't parse, adds nothing, which the gate reads as "send to a person".
 */
export function parseDependencies(messages: string[], ecosystem: string): DependencyFacts[] {
  const dependencies: DependencyFacts[] = [];
  for (const message of messages) {
    const bumps = bumpsByName(message);
    for (const entry of readBlock(message)) {
      const name = entry["dependency-name"];
      if (typeof name !== "string") continue;
      const metadataVersion =
        entry["dependency-version"] === undefined ? undefined : String(entry["dependency-version"]);
      const bump = pickBump(bumps.get(name), metadataVersion);
      const type = UPDATE_TYPE.exec(String(entry["update-type"] ?? ""))?.[1] as
        UpdateType | undefined;
      dependencies.push({
        name,
        ecosystem,
        dependencyType: String(entry["dependency-type"] ?? ""),
        updateType: type,
        group:
          entry["dependency-group"] === undefined ? undefined : String(entry["dependency-group"]),
        version: bump?.to ?? metadataVersion,
        previous: bump?.from,
      });
    }
  }
  return dependencies;
}

function numericParts(version: string): number[] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

/** The size of a bump from two versions, or undefined when they can't be compared. */
export function deriveUpdateType(previous?: string, version?: string): UpdateType | undefined {
  const from = previous === undefined ? undefined : numericParts(previous);
  const to = version === undefined ? undefined : numericParts(version);
  if (!from || !to) return undefined;
  const names: UpdateType[] = ["major", "minor", "patch"];
  const index = from.findIndex((part, i) => part !== to[i]);
  if (index === -1 || to[index] < from[index]) return undefined;
  return names[index];
}

/** True for versions such as 1.0.0-rc.1, 2.0.0b1 or 1.2.3.dev4. Build metadata does not count. */
export function isPrerelease(version?: string): boolean {
  if (!version) return false;
  const core = version.split("+")[0];
  return PRERELEASE.some((pattern) => pattern.test(core));
}

function ruleMatches(
  rule: DependencyRule,
  dep: DependencyFacts,
  type: UpdateType | undefined
): boolean {
  const { match } = rule;
  return (
    (match.dependency === undefined || matchesName(dep.name, match.dependency)) &&
    (match.ecosystem === undefined || match.ecosystem === dep.ecosystem) &&
    (match.dependencyType === undefined || match.dependencyType === dep.dependencyType) &&
    (match.updateType === undefined || match.updateType === type) &&
    (match.group === undefined || (dep.group !== undefined && matchesName(dep.group, match.group)))
  );
}

interface DependencyResult {
  reason?: string;
  note: string;
}

function evaluateOne(dep: DependencyFacts, policy: DependabotPolicy): DependencyResult {
  const derived = deriveUpdateType(dep.previous, dep.version);
  const matchType = dep.updateType ?? derived;
  const matching = policy.rules
    .map((rule, index) => ({ rule, number: index + 1 }))
    .filter(({ rule }) => ruleMatches(rule, dep, matchType));

  // A rule that sends a dependency to a person beats every other rule, wherever it sits.
  const human = matching.find(({ rule }) => rule.action === "human");
  if (human) return { reason: `rule ${human.number} sends it to a person`, note: "" };

  const first = matching[0];
  const via = first ? `, rule ${first.number}` : "";
  if (first?.rule.action === "pass") return { note: `rule ${first.number}: pass` };

  const settings = { ...policy.defaults, ...first?.rule.settings };
  const fail = (reason: string): DependencyResult => ({ reason: `${reason}${via}`, note: "" });

  if (!settings.dependencyTypes.includes(dep.dependencyType as never)) {
    return fail(`the dependency type ${dep.dependencyType || "(none)"} is not allowed`);
  }
  if (!settings.allowPrerelease && isPrerelease(dep.version)) {
    return fail(`${dep.version} is a prerelease`);
  }

  let type = dep.updateType ?? (settings.unknownUpdateType === "derive" ? derived : undefined);
  if (!type) return fail("the update type is unknown");
  if (
    type === "minor" &&
    settings.zeroMinorIsMajor &&
    numericParts(dep.previous ?? "")?.[0] === 0
  ) {
    type = "major";
  }
  if (!settings.updateTypes.includes(type)) return fail(`the update type ${type} is not allowed`);

  if (settings.minCompatibility > 0) {
    if (dep.compatibility === undefined) {
      if (settings.unknownCompatibility === "human")
        return fail("the compatibility score is unknown");
    } else if (dep.compatibility < settings.minCompatibility) {
      return fail(
        `the compatibility score ${dep.compatibility}% is below ${settings.minCompatibility}%`
      );
    }
  }
  const score = dep.compatibility === undefined ? "" : `, ${dep.compatibility}%`;
  return { note: `${type}${score}${via}` };
}

/**
 * Decides every dependency of a pull request on its own. The pull request passes only when all
 * of them pass. A rule with the action `human` beats every other rule. Otherwise the first
 * matching rule decides, and a dependency no rule matches follows the defaults.
 */
export function evaluateDependencies(
  dependencies: DependencyFacts[],
  policy: DependabotPolicy
): DependencyVerdict {
  if (dependencies.length === 0) {
    return { ok: false, why: "The commit lists no dependency metadata." };
  }
  const results = dependencies.map((dep) => ({ dep, result: evaluateOne(dep, policy) }));
  const failures = results.filter(({ result }) => result.reason);
  if (failures.length > 0) {
    const shown = failures
      .slice(0, MAX_REASONS)
      .map(({ dep, result }) => `\`${dep.name}\`: ${result.reason}.`);
    const more = failures.length > MAX_REASONS ? ` And ${failures.length - MAX_REASONS} more.` : "";
    return { ok: false, why: `${shown.join(" ")}${more}` };
  }
  const list = results.map(({ dep, result }) => `\`${dep.name}\` (${result.note})`).join(", ");
  return { ok: true, summary: `Dependabot updates inside the policy: ${list}.` };
}
