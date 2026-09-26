import * as fs from "fs";
import * as path from "path";

/** A function whose definition or body the diff touches. */
export interface ChangedFunction {
  name: string;
  isMethod: boolean;
}

export interface CallSite {
  path: string;
  line: number;
  enclosing: string;
  code: string;
}

export interface Usage {
  definitions: string[];
  sites: CallSite[];
  total: number;
}

export const MAX_SITES = 10;
export const MAX_PACK_BYTES = 40_000;
const MAX_FILE_BYTES = 1_000_000;

const SOURCE_FILE = /\.(go|ts|tsx|js|jsx|py)$/;
const TEST_FILE =
  /(_test\.go|\.(test|spec)\.[jt]sx?|_test\.py)$|(^|\/)test_[^/]*\.py$|(^|\/)__tests__\//;
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "__pycache__"]);
const NOT_METHODS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "constructor",
]);

const GO_FUNC = /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/;
const JS_FUNCTION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/;
const JS_ARROW =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const JS_METHOD =
  /^\s+(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/;

/** Matches a Go, TypeScript/JavaScript, or Python function definition on one line. */
export function matchDefinition(line: string): ChangedFunction | null {
  let m = line.match(GO_FUNC);
  if (m) return { name: m[2], isMethod: Boolean(m[1]) };
  m = line.match(JS_FUNCTION);
  if (m) return { name: m[1], isMethod: false };
  m = line.match(JS_ARROW);
  if (m) return { name: m[1], isMethod: false };
  m = line.match(PY_DEF);
  if (m) return { name: m[2], isMethod: m[1].length > 0 };
  m = line.match(JS_METHOD);
  if (m && !NOT_METHODS.has(m[1])) return { name: m[1], isMethod: true };
  return null;
}

/** Lists functions named in hunk headers or on changed definition lines of non-test source files. */
export function extractChangedFunctions(diff: string): ChangedFunction[] {
  const found = new Map<string, boolean>();
  let inSource = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/^b\//, "");
      inSource = SOURCE_FILE.test(file) && !TEST_FILE.test(file);
      continue;
    }
    if (!inSource || line.startsWith("--- ")) continue;
    let text: string | undefined;
    if (line.startsWith("@@")) text = line.split("@@")[2]?.trim();
    else if (line.startsWith("+") || line.startsWith("-")) text = line.slice(1);
    const def = text ? matchDefinition(text) : null;
    if (def && def.name.length >= 3 && !/^(Test|test_)/.test(def.name)) {
      found.set(def.name, def.isMethod);
    }
  }
  return [...found]
    .map(([name, isMethod]) => ({ name, isMethod }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function* sourceFiles(root: string, rel = ""): Generator<string> {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const file = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(root, file);
    } else if (entry.isFile() && SOURCE_FILE.test(file) && !TEST_FILE.test(file)) {
      yield file;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds each function's definitions and non-test call sites under repoDir. */
export function findUsages(
  repoDir: string,
  fns: ChangedFunction[],
  maxSites = MAX_SITES
): Map<string, Usage> {
  const usages = new Map<string, Usage>(
    fns.map((f) => [f.name, { definitions: [], sites: [], total: 0 }])
  );
  const patterns = fns.map((f) => ({
    name: f.name,
    re: new RegExp(
      f.isMethod ? `\\.${escapeRegExp(f.name)}\\(` : `(^|[^\\w$])${escapeRegExp(f.name)}\\(`
    ),
  }));
  for (const file of sourceFiles(repoDir)) {
    const full = path.join(repoDir, file);
    if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
    let enclosing = "<top level>";
    fs.readFileSync(full, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const def = matchDefinition(line);
        if (def) {
          enclosing = def.name;
          usages.get(def.name)?.definitions.push(`${file}:${i + 1}`);
          return;
        }
        for (const { name, re } of patterns) {
          if (!re.test(line)) continue;
          const usage = usages.get(name) as Usage;
          usage.total++;
          if (usage.sites.length < maxSites) {
            usage.sites.push({
              path: file,
              line: i + 1,
              enclosing,
              code: line.trim().slice(0, 140),
            });
          }
        }
      });
  }
  return usages;
}

/** Renders the caller map the review passes read as `callers.md`. */
export function renderCallersMarkdown(fns: ChangedFunction[], usages: Map<string, Usage>): string {
  const parts = [
    "# Changed functions: definitions and call sites",
    "",
    "Built by a script from the diff, not by a model. Call sites exclude tests. Method names match as `.name(`, so a common name can include unrelated calls.",
  ];
  if (fns.length === 0) parts.push("", "No changed functions found in the diff.");
  for (const f of fns) {
    const usage = usages.get(f.name) ?? { definitions: [], sites: [], total: 0 };
    parts.push("", `## \`${f.name}\`${f.isMethod ? " (method)" : ""}`, "", "Defined at:");
    parts.push(
      ...(usage.definitions.length ? usage.definitions.map((d) => `- \`${d}\``) : ["- (not found)"])
    );
    const shown = usage.total > usage.sites.length ? `, first ${usage.sites.length}` : "";
    parts.push("", `Call sites (${usage.total} total${shown}):`);
    parts.push(
      ...(usage.sites.length
        ? usage.sites.map((s) => `- \`${s.path}:${s.line}\` in \`${s.enclosing}\`: \`${s.code}\``)
        : ["- (none outside tests)"])
    );
  }
  const text = `${parts.join("\n")}\n`;
  return text.length > MAX_PACK_BYTES ? `${text.slice(0, MAX_PACK_BYTES)}\n\n(truncated)\n` : text;
}

/** Builds `callers.md` for a diff against the extracted PR head. */
export function buildContextPack(repoDir: string, diff: string): string {
  const fns = extractChangedFunctions(diff);
  return renderCallersMarkdown(fns, findUsages(repoDir, fns));
}
