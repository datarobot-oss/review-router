import * as yaml from "js-yaml";

export const POLICY_PATH = ".github/review-router.yml";

export type UpdateType = "patch" | "minor" | "major";

const UPDATE_TYPES: readonly UpdateType[] = ["patch", "minor", "major"];
const DEFAULT_UPDATE_TYPES: UpdateType[] = ["patch", "minor"];
const DEFAULT_MAX_CHANGED_FILES = 10;

export interface DependabotPolicy {
  allowedPaths: string[];
  maxChangedFiles: number;
  updateTypes: UpdateType[];
}

/** What a repository allows the gate to pass without a person's approval. */
export interface GatePolicy {
  dependabot?: DependabotPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDependabot(raw: unknown): DependabotPolicy | undefined {
  if (!isRecord(raw)) throw new Error("dependabot must be a mapping");

  const paths = raw.allowed_paths ?? [];
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.length > 0)) {
    throw new Error("dependabot.allowed_paths must be a list of non-empty strings");
  }

  const limit = raw.max_changed_files ?? DEFAULT_MAX_CHANGED_FILES;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("dependabot.max_changed_files must be a positive integer");
  }

  const types = raw.update_types ?? DEFAULT_UPDATE_TYPES;
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    !types.every((t): t is UpdateType => UPDATE_TYPES.includes(t as UpdateType))
  ) {
    throw new Error("dependabot.update_types must list patch, minor or major");
  }

  // No allowed path means no file can qualify, so the family stays off.
  if (paths.length === 0) return undefined;
  return { allowedPaths: paths, maxChangedFiles: limit, updateTypes: types };
}

/**
 * Parses the contents of .github/review-router.yml. Unknown keys are ignored so a newer
 * file still parses. Throws on malformed input: the caller fails closed.
 */
export function parsePolicy(text: string): GatePolicy {
  // js-yaml throws on a document with no content, and a stub that only holds comments is valid.
  if (text.split("\n").every((line) => line.trim() === "" || line.trim().startsWith("#"))) {
    return {};
  }
  const doc = yaml.load(text);
  if (doc === undefined || doc === null) return {};
  if (!isRecord(doc)) throw new Error("the policy file must be a mapping");

  const policy: GatePolicy = {};
  if (doc.dependabot !== undefined) {
    const dependabot = parseDependabot(doc.dependabot);
    if (dependabot) policy.dependabot = dependabot;
  }
  return policy;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      // "**/" spans zero or more directories, a trailing "**" spans everything below.
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when the whole path matches one pattern. Paths with "." or ".." segments never match. */
export function matchesAny(path: string, patterns: string[]): boolean {
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
