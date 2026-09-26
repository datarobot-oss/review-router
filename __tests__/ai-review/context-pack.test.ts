import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildContextPack,
  extractChangedFunctions,
  findUsages,
  matchDefinition,
  MAX_PACK_BYTES,
  renderCallersMarkdown,
} from "../../src/ai-review/context-pack";

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-pack-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe("matchDefinition", () => {
  it.each([
    ["func WaitForBuild(id string) error {", { name: "WaitForBuild", isMethod: false }],
    ["func (b *Build) IsDeployable() bool {", { name: "IsDeployable", isMethod: true }],
    ["func Map[T any](xs []T) []T {", { name: "Map", isMethod: false }],
    ["export async function loadConfig(path: string) {", { name: "loadConfig", isMethod: false }],
    [
      "export const handleLabeled = async (octokit: Octokit): Promise<void> => {",
      { name: "handleLabeled", isMethod: false },
    ],
    [
      "  private async fetchAll(owner: string): Promise<void> {",
      { name: "fetchAll", isMethod: true },
    ],
    ["def refresh_lockfile(path):", { name: "refresh_lockfile", isMethod: false }],
    ["    async def rotate(self, name):", { name: "rotate", isMethod: true }],
  ])("%s", (line, expected) => {
    expect(matchDefinition(line)).toEqual(expected);
  });

  it.each(["  if (ready) {", "  for (const x of xs) {", "x := func() {", "return build(x)"])(
    "ignores %s",
    (line) => {
      expect(matchDefinition(line)).toBeNull();
    }
  );
});

describe("extractChangedFunctions", () => {
  const diff = [
    "diff --git a/internal/build.go b/internal/build.go",
    "--- a/internal/build.go",
    "+++ b/internal/build.go",
    "@@ -383,19 +434,31 @@ func WaitForBuild(",
    " \tpoll()",
    "+func (b *Build) IsDeployable() bool {",
    "diff --git a/internal/build_test.go b/internal/build_test.go",
    "--- a/internal/build_test.go",
    "+++ b/internal/build_test.go",
    "+func TestWaitForBuild(t *testing.T) {",
    "+func helperInTests() {",
    "diff --git a/docs/x.md b/docs/x.md",
    "--- a/docs/x.md",
    "+++ b/docs/x.md",
    "+func NotCode() {",
  ].join("\n");

  it("takes names from hunk headers and added definitions in source files only", () => {
    expect(extractChangedFunctions(diff)).toEqual([
      { name: "IsDeployable", isMethod: true },
      { name: "WaitForBuild", isMethod: false },
    ]);
  });

  it("returns nothing for a diff without source changes", () => {
    expect(
      extractChangedFunctions("diff --git a/README.md b/README.md\n+++ b/README.md\n+hello\n")
    ).toEqual([]);
  });
});

describe("findUsages", () => {
  it("finds definitions and call sites with their enclosing function, skipping tests", () => {
    const root = tree({
      "internal/build.go": "package x\n\nfunc WaitForBuild() error {\n\treturn nil\n}\n",
      "cmd/get.go": "package cmd\n\nfunc runGet() {\n\tworkload.WaitForBuild()\n}\n",
      "cmd/get_test.go": "func TestX() {\n\tWaitForBuild()\n}\n",
      "node_modules/pkg/index.js": "WaitForBuild()\n",
    });
    const usages = findUsages(root, [{ name: "WaitForBuild", isMethod: false }]);
    expect(usages.get("WaitForBuild")).toEqual({
      definitions: ["internal/build.go:3"],
      sites: [
        { path: "cmd/get.go", line: 4, enclosing: "runGet", code: "workload.WaitForBuild()" },
      ],
      total: 1,
    });
  });

  it("matches methods only as .name(", () => {
    const root = tree({ "a.go": "func run() {\n\tIsDeployable()\n\tb.IsDeployable()\n}\n" });
    expect(
      findUsages(root, [{ name: "IsDeployable", isMethod: true }]).get("IsDeployable")?.total
    ).toBe(1);
  });

  it("caps call sites but keeps the total", () => {
    const calls = Array.from({ length: 15 }, () => "\tFoo()").join("\n");
    const root = tree({ "a.go": `func run() {\n${calls}\n}\n` });
    const usage = findUsages(root, [{ name: "Foo", isMethod: false }], 10).get("Foo");
    expect(usage?.sites).toHaveLength(10);
    expect(usage?.total).toBe(15);
  });

  it("does not follow symlinks", () => {
    const root = tree({ "a.go": "func run() {}\n" });
    fs.symlinkSync("/etc", path.join(root, "etc-link"));
    expect(() => findUsages(root, [{ name: "run", isMethod: false }])).not.toThrow();
  });
});

describe("renderCallersMarkdown", () => {
  it("says so when a function has no definition or call sites", () => {
    const text = renderCallersMarkdown(
      [{ name: "Gone", isMethod: false }],
      new Map([["Gone", { definitions: [], sites: [], total: 0 }]])
    );
    expect(text).toContain("- (not found)");
    expect(text).toContain("- (none outside tests)");
  });

  it("truncates past the size cap", () => {
    const fns = Array.from({ length: 2000 }, (_, i) => ({ name: `Function${i}`, isMethod: false }));
    const usages = new Map(
      fns.map((f) => [f.name, { definitions: ["a.go:1"], sites: [], total: 0 }])
    );
    const text = renderCallersMarkdown(fns, usages);
    expect(text.length).toBeLessThanOrEqual(MAX_PACK_BYTES + 20);
    expect(text).toContain("(truncated)");
  });
});

describe("buildContextPack", () => {
  it("renders the header even when nothing changed in source", () => {
    const root = tree({ "README.md": "hi" });
    const text = buildContextPack(root, "");
    expect(text).toContain("# Changed functions");
    expect(text).toContain("No changed functions found in the diff.");
  });
});
