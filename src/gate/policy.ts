import * as yaml from "js-yaml";

export const POLICY_PATH = ".github/review-router.yml";

export type UpdateType = "patch" | "minor" | "major";
export type DependencyType = "direct:production" | "direct:development" | "indirect";

const UPDATE_TYPES: readonly UpdateType[] = ["patch", "minor", "major"];
const DEPENDENCY_TYPES: readonly DependencyType[] = [
  "direct:production",
  "direct:development",
  "indirect",
];
const DEFAULT_MAX_CHANGED_FILES = 10;

// Ecosystem names as they appear in Dependabot branches, `dependabot/<ecosystem>/...`. Only
// npm_and_yarn, pip, uv, go_modules and github_actions were checked against real branches.
const ECOSYSTEMS: readonly string[] = [
  "npm_and_yarn",
  "pip",
  "uv",
  "go_modules",
  "github_actions",
  "docker",
  "docker_compose",
  "bundler",
  "bun",
  "cargo",
  "composer",
  "maven",
  "gradle",
  "nuget",
  "terraform",
  "opentofu",
  "helm",
  "mix",
  "pub",
  "swift",
  "elm",
  "gitsubmodule",
  "devcontainers",
  "dotnet_sdk",
  "rust_toolchain",
  "vcpkg",
];
// The `package-ecosystem` names of dependabot.yml that differ from the branch name.
const ECOSYSTEM_ALIASES: Record<string, string> = { npm: "npm_and_yarn", gomod: "go_modules" };

/** The risk dials of one dependency update. A rule can change any of them. */
export interface DependencySettings {
  /** Dependabot ecosystems that pass, by the name in its branch: `npm_and_yarn`, `pip`, `uv`. */
  ecosystems: string[];
  updateTypes: UpdateType[];
  dependencyTypes: DependencyType[];
  /** Lowest Dependabot compatibility score, 0 to 100. 0 turns the score off. */
  minCompatibility: number;
  unknownCompatibility: "human" | "pass";
  unknownUpdateType: "derive" | "human";
  /** Below 1.0 a minor bump can break, so it counts as a major one. */
  zeroMinorIsMajor: boolean;
  allowPrerelease: boolean;
}

export const DEFAULT_SETTINGS: DependencySettings = {
  ecosystems: ["npm_and_yarn", "pip", "uv", "go_modules"],
  updateTypes: ["patch", "minor"],
  dependencyTypes: [...DEPENDENCY_TYPES],
  minCompatibility: 70,
  unknownCompatibility: "human",
  unknownUpdateType: "derive",
  zeroMinorIsMajor: true,
  allowPrerelease: false,
};

export interface RuleMatch {
  /** Package name glob. `*` also matches a slash. */
  dependency?: string;
  ecosystem?: string;
  dependencyType?: DependencyType;
  updateType?: UpdateType;
  group?: string;
}

export interface DependencyRule {
  match: RuleMatch;
  /** `human` always wins. `pass` skips the risk settings. Without an action, `settings` apply. */
  action?: "human" | "pass";
  settings: Partial<DependencySettings>;
}

export interface DependabotPolicy {
  allowedPaths: string[];
  maxChangedFiles: number;
  defaults: DependencySettings;
  rules: DependencyRule[];
  /** True when a score is needed anywhere, so the gate fetches it only then. */
  usesCompatibility: boolean;
}

/** What a repository allows the gate to pass without a person's approval. */
export interface GatePolicy {
  dependabot?: DependabotPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects a key the code does not know: in a security file a typo must not read as "no limit". */
function checkKeys(where: string, record: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new Error(`${where} has an unknown key: ${unknown.join(", ")}`);
}

/** Reads an ecosystem as written in dependabot.yml or in a branch, and returns the branch name. */
function ecosystemName(where: string, value: unknown): string {
  const written = typeof value === "string" ? value : "";
  const name = ECOSYSTEM_ALIASES[written] ?? written.replace(/-/g, "_");
  if (!ECOSYSTEMS.includes(name)) {
    throw new Error(
      `${where} has an unknown ecosystem "${written}". Use one of: ${ECOSYSTEMS.join(", ")}`
    );
  }
  return name;
}

function enumList<T extends string>(where: string, value: unknown, allowed: readonly T[]): T[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is T => allowed.includes(item as T))
  ) {
    throw new Error(`${where} must list ${allowed.join(", ")}`);
  }
  return value;
}

function enumValue<T extends string>(where: string, value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new Error(`${where} must be ${allowed.join(" or ")}`);
  return value as T;
}

const SETTING_KEYS = [
  "ecosystems",
  "update_types",
  "dependency_types",
  "min_compatibility",
  "unknown_compatibility",
  "unknown_update_type",
  "zero_minor_is_major",
  "allow_prerelease",
] as const;

/** Reads the setting keys of a record. Only the keys present end up in the result. */
function parseSettings(where: string, raw: Record<string, unknown>): Partial<DependencySettings> {
  const settings: Partial<DependencySettings> = {};
  if (raw.ecosystems !== undefined) {
    const list = raw.ecosystems;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`${where}.ecosystems must be a list of ecosystem names`);
    }
    settings.ecosystems = list.map((name) => ecosystemName(`${where}.ecosystems`, name));
  }
  if (raw.update_types !== undefined) {
    settings.updateTypes = enumList(`${where}.update_types`, raw.update_types, UPDATE_TYPES);
  }
  if (raw.dependency_types !== undefined) {
    settings.dependencyTypes = enumList(
      `${where}.dependency_types`,
      raw.dependency_types,
      DEPENDENCY_TYPES
    );
  }
  if (raw.min_compatibility !== undefined) {
    const score = raw.min_compatibility;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error(`${where}.min_compatibility must be an integer from 0 to 100`);
    }
    settings.minCompatibility = score;
  }
  if (raw.unknown_compatibility !== undefined) {
    settings.unknownCompatibility = enumValue(
      `${where}.unknown_compatibility`,
      raw.unknown_compatibility,
      ["human", "pass"] as const
    );
  }
  if (raw.unknown_update_type !== undefined) {
    settings.unknownUpdateType = enumValue(
      `${where}.unknown_update_type`,
      raw.unknown_update_type,
      ["derive", "human"] as const
    );
  }
  for (const [key, field] of [
    ["zero_minor_is_major", "zeroMinorIsMajor"],
    ["allow_prerelease", "allowPrerelease"],
  ] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") throw new Error(`${where}.${key} must be true or false`);
      settings[field] = raw[key];
    }
  }
  return settings;
}

function parseMatch(where: string, raw: unknown): RuleMatch {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new Error(`${where} needs a match with at least one key`);
  }
  checkKeys(`${where}.match`, raw, [
    "dependency",
    "ecosystem",
    "dependency_type",
    "update_type",
    "group",
  ]);
  const match: RuleMatch = {};
  for (const key of ["dependency", "group"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string" || raw[key] === "") {
        throw new Error(`${where}.match.${key} must be a non-empty string`);
      }
      match[key] = raw[key];
    }
  }
  if (raw.ecosystem !== undefined)
    match.ecosystem = ecosystemName(`${where}.match.ecosystem`, raw.ecosystem);
  if (raw.dependency_type !== undefined) {
    match.dependencyType = enumValue(
      `${where}.match.dependency_type`,
      raw.dependency_type,
      DEPENDENCY_TYPES
    );
  }
  if (raw.update_type !== undefined) {
    match.updateType = enumValue(`${where}.match.update_type`, raw.update_type, UPDATE_TYPES);
  }
  return match;
}

function parseRule(index: number, raw: unknown): DependencyRule {
  const where = `dependabot.rules[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be a mapping`);
  checkKeys(where, raw, ["match", "action", ...SETTING_KEYS]);

  const match = parseMatch(where, raw.match);
  const settings = parseSettings(where, raw);
  const hasSettings = Object.keys(settings).length > 0;
  if (raw.action === undefined) {
    if (!hasSettings) throw new Error(`${where} needs an action or a setting`);
    return { match, settings };
  }
  if (hasSettings) throw new Error(`${where} sets both an action and settings`);
  return {
    match,
    settings,
    action: enumValue(`${where}.action`, raw.action, ["human", "pass"] as const),
  };
}

function parseDependabot(raw: unknown): DependabotPolicy | undefined {
  if (!isRecord(raw)) throw new Error("dependabot must be a mapping");
  checkKeys("dependabot", raw, [
    "allowed_paths",
    "max_changed_files",
    "update_types",
    "defaults",
    "rules",
  ]);

  const paths = raw.allowed_paths ?? [];
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.length > 0)) {
    throw new Error("dependabot.allowed_paths must be a list of non-empty strings");
  }

  const limit = raw.max_changed_files ?? DEFAULT_MAX_CHANGED_FILES;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("dependabot.max_changed_files must be a positive integer");
  }

  const rawDefaults = raw.defaults ?? {};
  if (!isRecord(rawDefaults)) throw new Error("dependabot.defaults must be a mapping");
  checkKeys("dependabot.defaults", rawDefaults, SETTING_KEYS);
  if (raw.update_types !== undefined && rawDefaults.update_types !== undefined) {
    throw new Error("set update_types in dependabot or in dependabot.defaults, not both");
  }
  // The top-level update_types of the first release stays valid as a shorthand.
  const shorthand = raw.update_types === undefined ? {} : { update_types: raw.update_types };
  const defaults: DependencySettings = {
    ...DEFAULT_SETTINGS,
    ...parseSettings("dependabot.defaults", { ...rawDefaults, ...shorthand }),
  };

  const rawRules = raw.rules ?? [];
  if (!Array.isArray(rawRules)) throw new Error("dependabot.rules must be a list");
  const rules = rawRules.map((rule, index) => parseRule(index, rule));

  // No allowed path means no file can qualify, so the family stays off.
  if (paths.length === 0) return undefined;
  const usesCompatibility =
    defaults.minCompatibility > 0 ||
    rules.some((rule) => (rule.settings.minCompatibility ?? 0) > 0);
  return { allowedPaths: paths, maxChangedFiles: limit, defaults, rules, usesCompatibility };
}

/**
 * Parses the contents of .github/review-router.yml. Unknown top-level keys are ignored so a newer
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

function escapeRegExp(char: string): string {
  return char.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
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
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when the whole path matches one pattern. Paths with "." or ".." segments never match. */
export function matchesAny(path: string, patterns: string[]): boolean {
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** True when a package name matches a glob. Here `*` also matches a slash: `@aws-sdk/*`. */
export function matchesName(name: string, pattern: string): boolean {
  const source = [...pattern]
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : escapeRegExp(char)))
    .join("");
  return new RegExp(`^${source}$`).test(name);
}

// pip and uv compare names without case and treat "-", "_" and "." alike (PEP 503).
const PEP_503_ECOSYSTEMS = new Set(["pip", "uv"]);

/** Matches a dependency name against a rule's glob the way its ecosystem compares names. */
export function matchesDependency(name: string, pattern: string, ecosystem: string): boolean {
  if (!PEP_503_ECOSYSTEMS.has(ecosystem)) return matchesName(name, pattern);
  const normalize = (text: string) => text.toLowerCase().replace(/[-_.]+/g, "-");
  return matchesName(normalize(name), normalize(pattern));
}
