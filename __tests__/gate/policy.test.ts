import { matchesAny, parsePolicy } from "../../src/gate/policy";

describe("parsePolicy", () => {
  it("reads the Dependabot family with the dr-auto-merge field names", () => {
    const policy = parsePolicy(
      [
        "dependabot:",
        "  allowed_paths: ['requirements/**', Dockerfile]",
        "  max_changed_files: 3",
        "  update_types: [patch]",
      ].join("\n")
    );
    expect(policy.dependabot).toEqual({
      allowedPaths: ["requirements/**", "Dockerfile"],
      maxChangedFiles: 3,
      updateTypes: ["patch"],
    });
  });

  it("defaults the update types to patch and minor and the file limit to 10", () => {
    const policy = parsePolicy("dependabot:\n  allowed_paths: ['a']");
    expect(policy.dependabot?.updateTypes).toEqual(["patch", "minor"]);
    expect(policy.dependabot?.maxChangedFiles).toBe(10);
  });

  it("enables no family for an empty file", () => {
    expect(parsePolicy("")).toEqual({});
  });

  it("enables no family for a file that only holds comments", () => {
    expect(parsePolicy("# dependabot:\n#   allowed_paths: [a]\n")).toEqual({});
  });

  it("enables no family when the Dependabot block lists no path", () => {
    expect(parsePolicy("dependabot:\n  allowed_paths: []").dependabot).toBeUndefined();
  });

  it("ignores keys it does not know, so a newer file still parses", () => {
    expect(parsePolicy("future: true\n")).toEqual({});
  });

  it("rejects text that is not YAML", () => {
    expect(() => parsePolicy("dependabot: [unclosed")).toThrow();
  });

  it("rejects a file limit that is not a positive integer", () => {
    expect(() => parsePolicy("dependabot:\n  allowed_paths: [a]\n  max_changed_files: 0")).toThrow(
      /max_changed_files/
    );
  });

  it("rejects an update type other than patch, minor or major", () => {
    expect(() => parsePolicy("dependabot:\n  allowed_paths: [a]\n  update_types: [huge]")).toThrow(
      /update_types/
    );
  });

  it("rejects an allowed path that is not a string", () => {
    expect(() => parsePolicy("dependabot:\n  allowed_paths: [1]")).toThrow(/allowed_paths/);
  });

  it("rejects a document that is not a mapping", () => {
    expect(() => parsePolicy("- a\n- b")).toThrow();
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
