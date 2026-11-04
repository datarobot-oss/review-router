import { DEFAULT_SETTINGS, matchesAny, matchesName, parsePolicy } from "../../src/gate/policy";

const dependabot = (body: string) => parsePolicy(`dependabot:\n${body}`).dependabot;

describe("parsePolicy", () => {
  it("reads the Dependabot family with the dr-auto-merge field names", () => {
    const policy = dependabot(
      [
        "  allowed_paths: ['requirements/**', Dockerfile]",
        "  max_changed_files: 3",
        "  update_types: [patch]",
      ].join("\n")
    );
    expect(policy?.allowedPaths).toEqual(["requirements/**", "Dockerfile"]);
    expect(policy?.maxChangedFiles).toBe(3);
    expect(policy?.defaults.updateTypes).toEqual(["patch"]);
  });

  it("fills every default for a block that only lists paths", () => {
    const policy = dependabot("  allowed_paths: ['a']");
    expect(policy?.maxChangedFiles).toBe(10);
    expect(policy?.defaults).toEqual(DEFAULT_SETTINGS);
    expect(policy?.rules).toEqual([]);
  });

  it("defaults to patch and minor, all dependency types, a score of 70 and a person for unknowns", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      updateTypes: ["patch", "minor"],
      dependencyTypes: ["direct:production", "direct:development", "indirect"],
      minCompatibility: 70,
      unknownCompatibility: "human",
      unknownUpdateType: "derive",
      zeroMinorIsMajor: true,
      allowPrerelease: false,
    });
  });

  it("reads every default setting", () => {
    const policy = dependabot(
      [
        "  allowed_paths: [a]",
        "  defaults:",
        "    update_types: [patch]",
        "    dependency_types: [indirect]",
        "    min_compatibility: 0",
        "    unknown_compatibility: pass",
        "    unknown_update_type: human",
        "    zero_minor_is_major: false",
        "    allow_prerelease: true",
      ].join("\n")
    );
    expect(policy?.defaults).toEqual({
      updateTypes: ["patch"],
      dependencyTypes: ["indirect"],
      minCompatibility: 0,
      unknownCompatibility: "pass",
      unknownUpdateType: "human",
      zeroMinorIsMajor: false,
      allowPrerelease: true,
    });
  });

  it("reads rules in order, with a match and either an action or settings", () => {
    const policy = dependabot(
      [
        "  allowed_paths: [a]",
        "  rules:",
        "    - match: { dependency: '@types/*', dependency_type: direct:development }",
        "      update_types: [patch, minor, major]",
        "      min_compatibility: 0",
        "    - match: { dependency: cryptography }",
        "      action: human",
        "    - match: { ecosystem: npm_and_yarn, update_type: patch, group: tools }",
        "      action: pass",
      ].join("\n")
    );
    expect(policy?.rules).toEqual([
      {
        match: { dependency: "@types/*", dependencyType: "direct:development" },
        settings: { updateTypes: ["patch", "minor", "major"], minCompatibility: 0 },
      },
      { match: { dependency: "cryptography" }, settings: {}, action: "human" },
      {
        match: { ecosystem: "npm_and_yarn", updateType: "patch", group: "tools" },
        settings: {},
        action: "pass",
      },
    ]);
  });

  it("keeps the top-level update_types as a shorthand for the default", () => {
    expect(
      dependabot("  allowed_paths: [a]\n  update_types: [major]")?.defaults.updateTypes
    ).toEqual(["major"]);
  });

  it("rejects update_types set both at the top level and in defaults", () => {
    expect(() =>
      dependabot(
        "  allowed_paths: [a]\n  update_types: [patch]\n  defaults:\n    update_types: [minor]"
      )
    ).toThrow(/update_types/);
  });

  it("enables no family for an empty file or one that only holds comments", () => {
    expect(parsePolicy("")).toEqual({});
    expect(parsePolicy("# dependabot:\n#   allowed_paths: [a]\n")).toEqual({});
  });

  it("enables no family when the Dependabot block lists no path", () => {
    expect(dependabot("  allowed_paths: []")).toBeUndefined();
  });

  it("ignores unknown top-level keys, so a newer file still parses", () => {
    expect(parsePolicy("future: true\n")).toEqual({});
  });

  it("rejects an unknown key inside the Dependabot block, since a typo could loosen a limit", () => {
    expect(() => dependabot("  allowed_paths: [a]\n  min_compatability: 90")).toThrow(
      /min_compatability/
    );
    expect(() =>
      dependabot("  allowed_paths: [a]\n  defaults:\n    min_compatability: 90")
    ).toThrow(/min_compatability/);
  });

  it("rejects an unknown key in a rule or its match", () => {
    expect(() =>
      dependabot(
        "  allowed_paths: [a]\n  rules:\n    - match: { dependency: x }\n      acton: human"
      )
    ).toThrow(/acton/);
    expect(() =>
      dependabot(
        "  allowed_paths: [a]\n  rules:\n    - match: { dependancy: x }\n      action: human"
      )
    ).toThrow(/dependancy/);
  });

  it("rejects a rule with no match, an empty match, or no effect", () => {
    expect(() => dependabot("  allowed_paths: [a]\n  rules:\n    - action: human")).toThrow(
      /match/
    );
    expect(() =>
      dependabot("  allowed_paths: [a]\n  rules:\n    - match: {}\n      action: human")
    ).toThrow(/match/);
    expect(() =>
      dependabot("  allowed_paths: [a]\n  rules:\n    - match: { dependency: x }")
    ).toThrow(/action or a setting/);
  });

  it("rejects a rule that sets both an action and settings", () => {
    expect(() =>
      dependabot(
        "  allowed_paths: [a]\n  rules:\n    - match: { dependency: x }\n      action: pass\n      min_compatibility: 0"
      )
    ).toThrow(/both/);
  });

  it("rejects an action other than human or pass", () => {
    expect(() =>
      dependabot(
        "  allowed_paths: [a]\n  rules:\n    - match: { dependency: x }\n      action: maybe"
      )
    ).toThrow(/action/);
  });

  it("rejects a match value of the wrong kind", () => {
    const rule = (match: string) =>
      dependabot(`  allowed_paths: [a]\n  rules:\n    - match: { ${match} }\n      action: human`);
    expect(() => rule("update_type: huge")).toThrow(/update_type/);
    expect(() => rule("dependency_type: transitive")).toThrow(/dependency_type/);
    expect(() => rule("dependency: 5")).toThrow(/dependency/);
  });

  it("rejects text that is not YAML or not a mapping", () => {
    expect(() => parsePolicy("dependabot: [unclosed")).toThrow();
    expect(() => parsePolicy("- a\n- b")).toThrow();
  });

  it("rejects a file limit that is not a positive integer", () => {
    expect(() => dependabot("  allowed_paths: [a]\n  max_changed_files: 0")).toThrow(
      /max_changed_files/
    );
  });

  it.each([
    ["update_types: [huge]", /update_types/],
    ["update_types: []", /update_types/],
    ["dependency_types: [other]", /dependency_types/],
    ["dependency_types: []", /dependency_types/],
    ["min_compatibility: 101", /min_compatibility/],
    ["min_compatibility: -1", /min_compatibility/],
    ["min_compatibility: 7.5", /min_compatibility/],
    ["unknown_compatibility: maybe", /unknown_compatibility/],
    ["unknown_update_type: guess", /unknown_update_type/],
    ["zero_minor_is_major: yes please", /zero_minor_is_major/],
    ["allow_prerelease: 1", /allow_prerelease/],
  ])("rejects the default %s", (line, message) => {
    expect(() => dependabot(`  allowed_paths: [a]\n  defaults:\n    ${line}`)).toThrow(message);
  });

  it("rejects an allowed path that is not a string", () => {
    expect(() => dependabot("  allowed_paths: [1]")).toThrow(/allowed_paths/);
  });

  it("tells whether any setting needs the compatibility score", () => {
    expect(dependabot("  allowed_paths: [a]")?.usesCompatibility).toBe(true);
    expect(
      dependabot("  allowed_paths: [a]\n  defaults:\n    min_compatibility: 0")?.usesCompatibility
    ).toBe(false);
    expect(
      dependabot(
        "  allowed_paths: [a]\n  defaults:\n    min_compatibility: 0\n  rules:\n    - match: { dependency: x }\n      min_compatibility: 80"
      )?.usesCompatibility
    ).toBe(true);
  });
});

describe("matchesAny", () => {
  it("matches a literal path exactly", () => {
    expect(matchesAny("Dockerfile", ["Dockerfile"])).toBe(true);
    expect(matchesAny("Dockerfile.dev", ["Dockerfile"])).toBe(false);
  });

  it("lets * match within one directory only", () => {
    expect(matchesAny("a/b.txt", ["a/*.txt"])).toBe(true);
    expect(matchesAny("a/c/b.txt", ["a/*.txt"])).toBe(false);
  });

  it("lets ** match across directories, including none", () => {
    expect(matchesAny("a/b/c/d.txt", ["a/**"])).toBe(true);
    expect(matchesAny("a/d.txt", ["a/**/d.txt"])).toBe(true);
    expect(matchesAny("a/b/d.txt", ["a/**/d.txt"])).toBe(true);
  });

  it("matches the whole path, not a prefix or a suffix", () => {
    expect(matchesAny("xa/b", ["a/b"])).toBe(false);
    expect(matchesAny("a/bx", ["a/b"])).toBe(false);
  });

  it("treats regular-expression characters in a pattern as literal", () => {
    expect(matchesAny("a.b", ["a.b"])).toBe(true);
    expect(matchesAny("axb", ["a.b"])).toBe(false);
    expect(matchesAny("a(1)", ["a(1)"])).toBe(true);
  });

  it("matches nothing against an empty pattern list", () => {
    expect(matchesAny("a", [])).toBe(false);
  });

  it("does not let a path climb out of the pattern with dot segments", () => {
    expect(matchesAny("requirements/../src/app.py", ["requirements/**"])).toBe(false);
  });
});

describe("matchesName", () => {
  it("matches a package name exactly or by glob, across slashes", () => {
    expect(matchesName("pypdf", "pypdf")).toBe(true);
    expect(matchesName("@types/node", "@types/*")).toBe(true);
    expect(matchesName("@aws-sdk/client-s3", "@aws-sdk/*")).toBe(true);
    expect(matchesName("@aws-sdk/client-s3", "*")).toBe(true);
  });

  it("matches the whole name only", () => {
    expect(matchesName("pypdf2", "pypdf")).toBe(false);
    expect(matchesName("my-pypdf", "pypdf")).toBe(false);
    expect(matchesName("@types/node", "@type/*")).toBe(false);
  });

  it("treats regular-expression characters as literal", () => {
    expect(matchesName("a.b", "a.b")).toBe(true);
    expect(matchesName("axb", "a.b")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(matchesName("PyPDF", "pypdf")).toBe(false);
  });
});
