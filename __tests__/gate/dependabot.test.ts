import * as fs from "fs";
import * as path from "path";
import {
  DependencyFacts,
  deriveUpdateType,
  evaluateDependencies,
  isPrerelease,
  parseDependencies,
} from "../../src/gate/dependabot";
import { DependabotPolicy, parsePolicy } from "../../src/gate/policy";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "../fixtures/dependabot", `${name}.txt`), "utf8");

describe("parseDependencies", () => {
  it("reads one dependency with its versions, type, update type and group", () => {
    expect(parseDependencies([fixture("npm-group-single")], "npm_and_yarn")).toEqual([
      {
        name: "@aws-sdk/client-s3",
        ecosystem: "npm_and_yarn",
        dependencyType: "direct:production",
        updateType: "minor",
        group: "aws-sdk",
        version: "3.1157.0",
        previous: "3.1153.0",
      },
    ]);
  });

  it("reads every dependency of a grouped update", () => {
    const deps = parseDependencies([fixture("npm-group-three")], "npm_and_yarn");
    expect(deps.map((d) => d.name)).toEqual([
      "@typescript-eslint/eslint-plugin",
      "@typescript-eslint/parser",
      "typescript-eslint",
    ]);
    expect(deps.every((d) => d.dependencyType === "direct:development")).toBe(true);
    expect(deps.every((d) => d.updateType === "patch")).toBe(true);
    expect(deps.map((d) => d.previous)).toEqual(["8.72.0", "8.72.0", "8.72.0"]);
  });

  it("reads the previous version of a single bump, without the trailing period", () => {
    const [dep] = parseDependencies([fixture("pip-minor")], "pip");
    expect(dep).toMatchObject({ name: "pypdf", previous: "6.20.1", version: "6.21.2" });
  });

  it("leaves the update type empty when the metadata has none", () => {
    const [dep] = parseDependencies([fixture("pip-no-update-type")], "pip");
    expect(dep.updateType).toBeUndefined();
    expect(dep).toMatchObject({ previous: "6.21.2", version: "6.21.4" });
  });

  it("reads a major bump of a GitHub Action", () => {
    const [dep] = parseDependencies([fixture("actions-major")], "github_actions");
    expect(dep).toMatchObject({ name: "actions/checkout", updateType: "major", previous: "4.2.2" });
  });

  it("collects the dependencies of every commit", () => {
    const deps = parseDependencies([fixture("pip-minor"), fixture("actions-major")], "pip");
    expect(deps.map((d) => d.name)).toEqual(["pypdf", "actions/checkout"]);
  });

  it("returns nothing for a message without a metadata block", () => {
    expect(parseDependencies(["Bump pypdf\n\nBumps pypdf from 1.0.0 to 1.0.1."], "pip")).toEqual(
      []
    );
  });

  it("returns nothing when the metadata block is not valid YAML", () => {
    const broken =
      "Bumps x from 1.0.0 to 1.0.1.\n\n---\nupdated-dependencies:\n- dependency-name: [oops\n...\n";
    expect(parseDependencies([broken], "pip")).toEqual([]);
  });

  it("returns nothing when the metadata is not a list of dependencies", () => {
    expect(parseDependencies(["---\nupdated-dependencies: nope\n...\n"], "pip")).toEqual([]);
  });

  it("does not guess the previous version when one name has two different bumps to the same version", () => {
    const message = [
      "Updates `x` from 1.0.0 to 1.0.2",
      "Updates `x` from 1.0.1 to 1.0.2",
      "",
      "---",
      "updated-dependencies:",
      "- dependency-name: x",
      "  dependency-version: 1.0.2",
      "  dependency-type: direct:production",
      "...",
    ].join("\n");
    expect(parseDependencies([message], "pip")[0].previous).toBeUndefined();
  });

  it("keeps a version such as 1.10 as written, not as the number 1.1", () => {
    const message =
      "---\nupdated-dependencies:\n- dependency-name: x\n  dependency-version: 1.10\n...\n";
    expect(parseDependencies([message], "pip")[0].version).toBe("1.10");
  });

  it("keeps a numeric package name as text", () => {
    const message =
      "---\nupdated-dependencies:\n- dependency-name: 123\n  dependency-version: 1.0.1\n...\n";
    expect(parseDependencies([message], "pip")[0].name).toBe("123");
  });

  it.each([
    ["a scalar entry", "- ok-one\n- dependency-name: fine\n  dependency-version: 1.0.1"],
    [
      "an entry without a name",
      "- dependency-version: 2.0.0\n  update-type: version-update:semver-major\n- dependency-name: fine\n  dependency-version: 1.0.1",
    ],
    [
      "an entry whose name is a list",
      "- dependency-name: [a, b]\n- dependency-name: fine\n  dependency-version: 1.0.1",
    ],
    ["an empty list", "[]"],
  ])("returns nothing for the whole commit when it holds %s", (_label, entries) => {
    const message = `---\nupdated-dependencies:\n${entries}\n...\n`;
    expect(parseDependencies([message], "pip")).toEqual([]);
  });

  it("returns nothing for the whole pull request when one commit lists no dependency", () => {
    const empty = "---\nupdated-dependencies: []\n...\n";
    expect(parseDependencies([fixture("pip-minor"), empty], "pip")).toEqual([]);
  });

  it("returns nothing for the whole pull request when one commit has no readable metadata", () => {
    const good = fixture("pip-minor");
    expect(parseDependencies([good, "A commit with no metadata"], "pip")).toEqual([]);
    expect(parseDependencies(["A commit with no metadata", good], "pip")).toEqual([]);
  });

  it("keeps a missing dependency type as an empty string, so no allow-list matches it", () => {
    const message =
      "---\nupdated-dependencies:\n- dependency-name: x\n  dependency-version: 1.0.1\n...\n";
    expect(parseDependencies([message], "pip")[0].dependencyType).toBe("");
  });
});

describe("deriveUpdateType", () => {
  it.each([
    ["1.2.3", "1.2.4", "patch"],
    ["1.2.3", "1.3.0", "minor"],
    ["1.2.3", "2.0.0", "major"],
    ["8.72.0", "8.72.1", "patch"],
    ["v1.2.3", "v1.4.0", "minor"],
    ["1.2", "1.3", "minor"],
    ["1.2", "2.0", "major"],
    ["3.1153.0", "3.1157.0", "minor"],
    ["1.0.0-rc.1", "1.0.1", "patch"],
  ])("reads %s to %s as %s", (from, to, expected) => {
    expect(deriveUpdateType(from, to)).toBe(expected);
  });

  it.each([
    [undefined, "1.0.0"],
    ["1.0.0", undefined],
    ["abc", "def"],
    ["1.0.0", "1.0.0"],
    ["2.0.0", "1.9.9"],
  ])("returns nothing for %s to %s", (from, to) => {
    expect(deriveUpdateType(from, to)).toBeUndefined();
  });
});

describe("isPrerelease", () => {
  it.each([
    "1.0.0-rc.1",
    "2.0.0-beta",
    "1.2.3-alpha.2",
    "2.0.0b1",
    "1.0.0a1",
    "1.2.3.dev4",
    "1.0.0-next.3",
  ])("treats %s as a prerelease", (version) => expect(isPrerelease(version)).toBe(true));

  it.each([
    "1.2.3",
    "3.1157.0",
    "1.2.3+build.5",
    "1.2.3+build.dev5",
    "1.0.0.post1",
    "2026.11.0",
    undefined,
  ])("treats %s as a release", (version) => expect(isPrerelease(version)).toBe(false));
});

const policy = (body = ""): DependabotPolicy => {
  const parsed = parsePolicy(`dependabot:\n  allowed_paths: [a]\n${body}`).dependabot;
  if (!parsed) throw new Error("test policy is off");
  return parsed;
};

const dep = (over: Partial<DependencyFacts> = {}): DependencyFacts => ({
  name: "pypdf",
  ecosystem: "pip",
  dependencyType: "direct:production",
  updateType: "patch",
  version: "6.0.1",
  previous: "6.0.0",
  compatibility: 90,
  ...over,
});

const verdict = (deps: DependencyFacts[], body = "") => evaluateDependencies(deps, policy(body));
const failed = (result: ReturnType<typeof evaluateDependencies>) => (result.ok ? "" : result.why);

describe("evaluateDependencies with the defaults", () => {
  it("passes a patch update with a good score", () => {
    expect(verdict([dep()]).ok).toBe(true);
  });

  it("passes a minor update", () => {
    expect(verdict([dep({ updateType: "minor" })]).ok).toBe(true);
  });

  it("sends a major update to a person", () => {
    const result = verdict([dep({ updateType: "major" })]);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("pypdf");
    expect(failed(result)).toContain("major");
  });

  it("passes a score at the minimum and fails one below it", () => {
    expect(verdict([dep({ compatibility: 70 })]).ok).toBe(true);
    const low = verdict([dep({ compatibility: 69 })]);
    expect(low.ok).toBe(false);
    expect(failed(low)).toContain("69%");
  });

  it("sends an unknown score to a person", () => {
    const result = verdict([dep({ compatibility: undefined })]);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("unknown");
  });

  it("derives a missing update type from the versions", () => {
    expect(
      verdict([dep({ updateType: undefined, previous: "6.21.2", version: "6.21.4" })]).ok
    ).toBe(true);
    const major = verdict([dep({ updateType: undefined, previous: "6.21.2", version: "7.0.0" })]);
    expect(major.ok).toBe(false);
  });

  it("sends an update to a person when its type is missing and can't be derived", () => {
    const result = verdict([dep({ updateType: undefined, previous: undefined })]);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("update type");
  });

  it("treats a minor bump below 1.0 as a major one", () => {
    const zero = dep({ updateType: "minor", previous: "0.3.1", version: "0.4.0" });
    expect(verdict([zero]).ok).toBe(false);
    expect(
      verdict([{ ...zero, previous: "0.3.1", version: "0.3.2", updateType: "patch" }]).ok
    ).toBe(true);
    expect(verdict([{ ...zero, previous: "1.3.1", version: "1.4.0" }]).ok).toBe(true);
  });

  it("treats a minor bump to a 0.x version as major even when the previous version is unknown", () => {
    const body = "  defaults:\n    min_compatibility: 0";
    const zero = dep({ updateType: "minor", previous: undefined, version: "0.5.0" });
    expect(verdict([zero], body).ok).toBe(false);
    expect(verdict([{ ...zero, version: "1.5.0" }], body).ok).toBe(true);
  });

  it("sends a minor bump to a person when no version is known to tell if it is below 1.0", () => {
    const body = "  defaults:\n    min_compatibility: 0";
    expect(
      verdict([dep({ updateType: "minor", previous: undefined, version: undefined })], body).ok
    ).toBe(false);
  });

  it("sends a prerelease to a person", () => {
    const result = verdict([dep({ version: "6.1.0-rc.1", updateType: "minor" })]);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("prerelease");
  });

  it("sends a dependency of an unknown type to a person", () => {
    expect(verdict([dep({ dependencyType: "" })]).ok).toBe(false);
  });

  it("needs every dependency of a group to pass, and names the one that fails", () => {
    const result = verdict([dep(), dep({ name: "other", updateType: "major" })]);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("other");
    expect(failed(result)).not.toContain("pypdf:");
  });

  it("sends a pull request with no dependency metadata to a person", () => {
    const result = verdict([]);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("metadata");
  });

  it("names every dependency in the summary of a pass", () => {
    const result = verdict([dep(), dep({ name: "other", compatibility: 80 })]);
    expect(result.ok && result.summary).toContain("pypdf");
    expect(result.ok && result.summary).toContain("other");
  });
});

describe("evaluateDependencies by ecosystem", () => {
  it.each(["npm_and_yarn", "pip", "uv", "go_modules"])("passes %s by default", (ecosystem) => {
    expect(verdict([dep({ ecosystem })]).ok).toBe(true);
  });

  it.each(["docker", "github_actions", "cargo", ""])(
    "sends %s to a person by default, since its score is not verified",
    (ecosystem) => {
      const result = verdict([dep({ ecosystem })]);
      expect(result.ok).toBe(false);
      expect(failed(result)).toContain("ecosystem");
    }
  );

  it("passes another ecosystem when a repository lists it", () => {
    expect(
      verdict([dep({ ecosystem: "docker" })], "  defaults:\n    ecosystems: [docker]").ok
    ).toBe(true);
    expect(verdict([dep({ ecosystem: "pip" })], "  defaults:\n    ecosystems: [docker]").ok).toBe(
      false
    );
  });

  it("lets a rule allow an ecosystem for one dependency only", () => {
    const body = "  rules:\n    - match: { dependency: 'node' }\n      ecosystems: [docker]";
    expect(verdict([dep({ name: "node", ecosystem: "docker" })], body).ok).toBe(true);
    expect(verdict([dep({ name: "redis", ecosystem: "docker" })], body).ok).toBe(false);
  });
});

describe("evaluateDependencies with settings", () => {
  it("lets the update types be widened", () => {
    expect(
      verdict([dep({ updateType: "major" })], "  update_types: [patch, minor, major]").ok
    ).toBe(true);
  });

  it("limits the dependency types", () => {
    const body = "  defaults:\n    dependency_types: [direct:development]";
    expect(verdict([dep()], body).ok).toBe(false);
    expect(verdict([dep({ dependencyType: "direct:development" })], body).ok).toBe(true);
  });

  it("turns the score off with a minimum of 0, so an unknown score passes", () => {
    expect(
      verdict([dep({ compatibility: undefined })], "  defaults:\n    min_compatibility: 0").ok
    ).toBe(true);
  });

  it("lets an unknown score pass when the setting says so, but still checks a known one", () => {
    const body = "  defaults:\n    unknown_compatibility: pass";
    expect(verdict([dep({ compatibility: undefined })], body).ok).toBe(true);
    expect(verdict([dep({ compatibility: 10 })], body).ok).toBe(false);
  });

  it("sends a missing update type to a person when the setting says not to derive", () => {
    const body = "  defaults:\n    unknown_update_type: human";
    expect(verdict([dep({ updateType: undefined })], body).ok).toBe(false);
    expect(verdict([dep()], body).ok).toBe(true);
  });

  it("can allow prereleases and bumps below 1.0", () => {
    const body = "  defaults:\n    allow_prerelease: true\n    zero_minor_is_major: false";
    expect(verdict([dep({ version: "6.1.0-rc.1", updateType: "minor" })], body).ok).toBe(true);
    expect(
      verdict([dep({ previous: "0.3.1", version: "0.4.0", updateType: "minor" })], body).ok
    ).toBe(true);
  });
});

describe("evaluateDependencies with rules", () => {
  const rule = (match: string, rest: string) =>
    `  rules:\n    - match: { ${match} }\n${rest
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n")}`;

  it("applies the settings of a matching rule only to what it matches", () => {
    const body = rule(
      "dependency: '@types/*'",
      "update_types: [patch, minor, major]\nmin_compatibility: 0"
    );
    const types = dep({ name: "@types/node", updateType: "major", compatibility: undefined });
    expect(verdict([types], body).ok).toBe(true);
    expect(verdict([{ ...types, name: "pypdf" }], body).ok).toBe(false);
  });

  it("keeps the defaults a rule does not mention", () => {
    const body = rule("dependency: pypdf", "update_types: [major]");
    expect(verdict([dep({ updateType: "major", compatibility: 10 })], body).ok).toBe(false);
  });

  it("sends a dependency to a person on an action of human, and names the rule", () => {
    const result = verdict(
      [dep({ name: "cryptography" })],
      rule("dependency: cryptography", "action: human")
    );
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("rule 1");
  });

  it("passes a dependency on an action of pass, whatever its update type or score", () => {
    const body = rule("dependency: pypdf", "action: pass");
    expect(
      verdict([dep({ updateType: "major", compatibility: 1, version: "7.0.0-rc.1" })], body).ok
    ).toBe(true);
  });

  it("lets the first matching rule decide when none says human", () => {
    const body = [
      "  rules:",
      "    - match: { dependency: pypdf }",
      "      action: pass",
      "    - match: { dependency: '*' }",
      "      update_types: [patch]",
    ].join("\n");
    expect(verdict([dep({ updateType: "major" })], body).ok).toBe(true);
    const reversed = [
      "  rules:",
      "    - match: { dependency: '*' }",
      "      update_types: [patch]",
      "    - match: { dependency: pypdf }",
      "      action: pass",
    ].join("\n");
    expect(verdict([dep({ updateType: "major" })], reversed).ok).toBe(false);
  });

  it("lets a human rule win over an earlier rule that loosens, wherever it sits", () => {
    const body = [
      "  rules:",
      "    - match: { dependency: '*' }",
      "      update_types: [patch, minor, major]",
      "    - match: { dependency: cryptography }",
      "      action: human",
    ].join("\n");
    const result = verdict([dep({ name: "cryptography", updateType: "major" })], body);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("rule 2");
  });

  it("lets a human rule win over an earlier pass rule", () => {
    const body = [
      "  rules:",
      "    - match: { dependency: '*' }",
      "      action: pass",
      "    - match: { ecosystem: docker }",
      "      action: human",
    ].join("\n");
    expect(verdict([dep({ ecosystem: "docker" })], body).ok).toBe(false);
    expect(verdict([dep({ ecosystem: "pip" })], body).ok).toBe(true);
  });

  it("matches on the ecosystem, the dependency type and the group", () => {
    const human = (match: string) => rule(match, "action: human");
    expect(verdict([dep()], human("ecosystem: pip")).ok).toBe(false);
    expect(verdict([dep()], human("ecosystem: npm_and_yarn")).ok).toBe(true);
    expect(verdict([dep()], human("dependency_type: direct:production")).ok).toBe(false);
    expect(verdict([dep()], human("dependency_type: indirect")).ok).toBe(true);
    expect(verdict([dep({ group: "tools" })], human("group: 'to*'")).ok).toBe(false);
    expect(verdict([dep()], human("group: tools")).ok).toBe(true);
  });

  it("matches on the update type, derived when the metadata lacks it", () => {
    const body = rule("update_type: minor", "action: human");
    expect(verdict([dep({ updateType: "minor" })], body).ok).toBe(false);
    expect(
      verdict([dep({ updateType: undefined, previous: "1.0.0", version: "1.1.0" })], body).ok
    ).toBe(false);
    expect(verdict([dep({ updateType: "patch" })], body).ok).toBe(true);
  });

  it("matches a rule on the update type the policy enforces, not the raw one", () => {
    // A 0.x minor bump counts as major, so a rule that holds back majors must catch it.
    const body = [
      "  defaults:",
      "    update_types: [patch, minor, major]",
      "    min_compatibility: 0",
      "  rules:",
      "    - match: { update_type: major }",
      "      action: human",
    ].join("\n");
    const zero = dep({ updateType: "minor", previous: "0.4.0", version: "0.5.0" });
    const result = verdict([zero], body);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("rule 1");
  });

  it("does not let a rule match a derived update type when the policy does not trust derivation", () => {
    const body = [
      "  defaults:",
      "    unknown_update_type: human",
      "  rules:",
      "    - match: { update_type: patch }",
      "      action: pass",
    ].join("\n");
    const indirect = dep({ updateType: undefined, previous: "1.0.0", version: "1.0.1" });
    const result = verdict([indirect], body);
    expect(result.ok).toBe(false);
    expect(failed(result)).toContain("update type");
  });

  it("matches pip and uv package names the way pip does: any case, and - _ . alike", () => {
    const human = rule("dependency: typing-extensions", "action: human");
    expect(verdict([dep({ name: "typing_extensions" })], human).ok).toBe(false);
    expect(verdict([dep({ name: "Typing.Extensions", ecosystem: "uv" })], human).ok).toBe(false);
    expect(verdict([dep({ name: "Django" })], rule("dependency: django", "action: human")).ok).toBe(
      false
    );
    expect(verdict([dep({ name: "PyYAML" })], rule("dependency: 'py*'", "action: human")).ok).toBe(
      false
    );
  });

  it("keeps npm package names case-sensitive", () => {
    const human = rule("dependency: foo", "action: human");
    expect(verdict([dep({ name: "Foo", ecosystem: "npm_and_yarn" })], human).ok).toBe(true);
    expect(verdict([dep({ name: "foo", ecosystem: "npm_and_yarn" })], human).ok).toBe(false);
  });

  it("needs every key of a match to hold", () => {
    const body = rule("dependency: pypdf, ecosystem: npm_and_yarn", "action: human");
    expect(verdict([dep()], body).ok).toBe(true);
  });
});

describe("evaluateDependencies on real Dependabot commits", () => {
  const real = (name: string, ecosystem: string, compatibility = 85) =>
    parseDependencies([fixture(name)], ecosystem).map((d) => ({ ...d, compatibility }));

  it("passes a security-style pip update with no update type, by deriving a patch from the versions", () => {
    expect(verdict(real("pip-no-update-type", "pip")).ok).toBe(true);
  });

  it("passes a grouped patch update of dev dependencies", () => {
    expect(verdict(real("npm-group-three", "npm_and_yarn")).ok).toBe(true);
  });

  it("sends a major GitHub Actions bump to a person", () => {
    expect(verdict(real("actions-major", "github_actions")).ok).toBe(false);
  });

  it("sends a pip update to a person when its score is low", () => {
    expect(verdict(real("pip-minor", "pip", 58)).ok).toBe(false);
  });

  it("sends a pip update with no score to a person unless the policy allows it", () => {
    const unscored = parseDependencies([fixture("pip-minor")], "pip");
    expect(verdict(unscored).ok).toBe(false);
    expect(verdict(unscored, "  defaults:\n    unknown_compatibility: pass").ok).toBe(true);
  });
});
