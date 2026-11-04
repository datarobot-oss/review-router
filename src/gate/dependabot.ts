import * as yaml from "js-yaml";
import {
  DependabotPolicy,
  DependencyRule,
  DependencySettings,
  matchesDependency,
  matchesName,
  UpdateType,
} from "./policy";

const METADATA_BLOCK = /(?:^|\n)---\nupdated-dependencies:[\s\S]*?\n\.\.\./;
const UPDATE_TYPE = /^version-update:semver-(patch|minor|major)$/;
const SINGLE_BUMP = /Bumps \[([^\]]+)\]\([^)]*\) from (\S+) to (\S+)/g;
const GROUP_BUMP = /Updates `([^`]+)` from (\S+) to (\S+)/g;
// A hyphen after the numeric core (1.0.0-M1, 21-ea, v0.0.0-2024...) or a PEP 440 suffix
// (2.0.0b1, 3.14.0rc1-slim) marks a prerelease, and so do the usual words after a dot.
const PRERELEASE = [
  /^v?\d+(\.\d+)*-/,
  /\d(a|b|c|rc)\d+/i,
  /\.(alpha|beta|rc|pre|preview|dev|snapshot|canary|next)/i,
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

/**
 * Reads the entries of the metadata block of one commit message. Every scalar is read as text,
 * so a version such as 1.10 stays 1.10. Returns undefined when the block is missing, does not
 * parse, is empty, or holds an entry without a text name: the caller then trusts none of it.
 */
function readBlock(message: string): Record<string, unknown>[] | undefined {
  const block = METADATA_BLOCK.exec(message);
  if (!block) return undefined;
  try {
    const doc = yaml.load(block[0].replace(/^\n?---\n/, "").replace(/\n\.\.\.$/, ""), {
      schema: yaml.FAILSAFE_SCHEMA,
    });
    const list = (doc as Record<string, unknown> | undefined)?.["updated-dependencies"];
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const valid = list.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>)["dependency-name"] === "string"
    );
    return valid ? (list as Record<string, unknown>[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the dependencies Dependabot lists in its commit messages. A commit with no metadata
 * block, or one that is not fully readable, makes the result empty, which the gate reads as
 * "send to a person".
 */
export function parseDependencies(messages: string[], ecosystem: string): DependencyFacts[] {
  const dependencies: DependencyFacts[] = [];
  for (const message of messages) {
    const entries = readBlock(message);
    // One unreadable commit makes the whole list untrustworthy, not just that commit.
    if (!entries) return [];
    const bumps = bumpsByName(message);
    for (const entry of entries) {
      const name = entry["dependency-name"] as string;
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
    (match.dependency === undefined ||
      matchesDependency(dep.name, match.dependency, dep.ecosystem)) &&
    (match.ecosystem === undefined || match.ecosystem === dep.ecosystem) &&
    (match.dependencyType === undefined || match.dependencyType === dep.dependencyType) &&
    (match.updateType === undefined || match.updateType === type) &&
    (match.group === undefined || (dep.group !== undefined && matchesName(dep.group, match.group)))
  );
}

/**
 * The update type the policy enforces: the metadata type, else the one derived from the versions
 * when `unknown_update_type` allows it, and a minor bump to a 0.x version counted as major.
 * The major part comes from the new version, which is known even when the previous one is not.
 */
function effectiveType(dep: DependencyFacts, settings: DependencySettings): UpdateType | undefined {
  let type =
    dep.updateType ??
    (settings.unknownUpdateType === "derive"
      ? deriveUpdateType(dep.previous, dep.version)
      : undefined);
  if (type === "minor" && settings.zeroMinorIsMajor) {
    const major = numericParts(dep.version ?? dep.previous ?? "")?.[0];
    if (major === undefined || major === 0) type = "major";
  }
  return type;
}

interface DependencyResult {
  reason?: string;
  note: string;
}

function evaluateOne(dep: DependencyFacts, policy: DependabotPolicy): DependencyResult {
  // Rules match on the type under the defaults, so a rule can't change what it is matched on.
  const matchType = effectiveType(dep, policy.defaults);
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

  if (!settings.ecosystems.includes(dep.ecosystem)) {
    return fail(`the ecosystem ${dep.ecosystem || "(none)"} is not allowed`);
  }
  if (!settings.dependencyTypes.includes(dep.dependencyType as never)) {
    return fail(`the dependency type ${dep.dependencyType || "(none)"} is not allowed`);
  }
  if (!settings.allowPrerelease && isPrerelease(dep.version)) {
    return fail(`${dep.version} is a prerelease`);
  }

  const type = effectiveType(dep, settings);
  if (!type) return fail("the update type is unknown");
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
