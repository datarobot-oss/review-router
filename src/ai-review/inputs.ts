import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Octokit } from "../types";
import { buildContextPack } from "./context-pack";
import { baseEnv, CommandRunner } from "./process";

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
}

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
}

export interface Workspace {
  root: string;
  repoDir: string;
  contextDir: string;
  files: PrFile[];
  diffPatch: string;
  guidance: string;
  ruleFiles: string[];
}

export interface FileHistory {
  path: string;
  commits: { sha: string; date: string; message: string }[];
}

export interface RuleFile {
  name: string;
  content: string;
}

export const GUIDANCE_PATH = ".github/ai-review.md";
export const RULES_DIR = ".cursor";
const HISTORY_MAX_FILES = 20;
const HISTORY_PER_FILE = 8;

/** Removes paired `<!-- NAME -->...<!-- /NAME -->` blocks that other bots write into PR bodies. */
export function stripBotBlocks(body: string): string {
  return body.replace(/<!--\s*([A-Z][A-Z0-9_]*)\s*-->[\s\S]*?<!--\s*\/\1\s*-->/g, "").trim();
}

/** Assembles a git-style diff from the PR files API. */
export function buildDiffPatch(files: PrFile[]): string {
  const parts = files.map((f) => {
    const oldName = f.previous_filename ?? f.filename;
    return [
      `diff --git a/${oldName} b/${f.filename}`,
      f.status === "added" ? "--- /dev/null" : `--- a/${oldName}`,
      f.status === "removed" ? "+++ /dev/null" : `+++ b/${f.filename}`,
      f.patch ?? "(no patch: binary or too large to show)",
    ].join("\n");
  });
  return `${parts.join("\n")}\n`;
}

export function buildHistoryMarkdown(history: FileHistory[]): string {
  const parts = ["# Recent history of files this PR touches (at the PR base)"];
  for (const file of history) {
    parts.push("", `## ${file.path}`, "");
    parts.push(
      ...(file.commits.length
        ? file.commits.map((c) => `- ${c.sha} ${c.date} ${c.message}`)
        : ["- (no history found)"])
    );
  }
  return `${parts.join("\n")}\n`;
}

/** Fetches recent commits for up to HISTORY_MAX_FILES paths at the PR base. */
export async function fetchHistory(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  paths: string[]
): Promise<FileHistory[]> {
  return Promise.all(
    paths.slice(0, HISTORY_MAX_FILES).map(async (p) => {
      try {
        const { data } = await octokit.rest.repos.listCommits({
          owner,
          repo,
          sha: baseSha,
          path: p,
          per_page: HISTORY_PER_FILE,
        });
        return {
          path: p,
          commits: data.map((c) => ({
            sha: c.sha.slice(0, 7),
            date: c.commit.author?.date?.slice(0, 10) ?? "",
            message: c.commit.message.split("\n")[0],
          })),
        };
      } catch {
        return { path: p, commits: [] };
      }
    })
  );
}

async function readText(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
    if (!Array.isArray(data) && "content" in data && data.content) {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return null;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** Reads maintainer guidance and `.cursor/*.md` rules from the base branch, never the PR head. */
export async function fetchBaseRules(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseRef: string
): Promise<{ guidance: string; rules: RuleFile[] }> {
  const guidance = (await readText(octokit, owner, repo, baseRef, GUIDANCE_PATH)) ?? "";
  const rules: RuleFile[] = guidance
    ? [{ name: path.basename(GUIDANCE_PATH), content: guidance }]
    : [];
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: RULES_DIR,
      ref: baseRef,
    });
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
        const content = await readText(octokit, owner, repo, baseRef, entry.path);
        if (content) rules.push({ name: path.basename(entry.name), content });
      }
    }
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  return { guidance, rules };
}

/** Deletes every symlink under dir, so no session can read through one out of the workspace. */
export function removeSymlinks(dir: string): number {
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      fs.unlinkSync(full);
      removed++;
    } else if (entry.isDirectory()) {
      removed += removeSymlinks(full);
    }
  }
  return removed;
}

/** Downloads and extracts the PR head, then removes symlinks, rules, and Claude Code config. */
export async function downloadHead(
  octokit: Octokit,
  runner: CommandRunner,
  owner: string,
  repo: string,
  sha: string,
  destDir: string,
  signal?: AbortSignal
): Promise<void> {
  const { data } = await octokit.rest.repos.downloadTarballArchive({
    owner,
    repo,
    ref: sha,
    request: { signal },
  });
  const tarball = path.join(path.dirname(destDir), "head.tar.gz");
  fs.writeFileSync(tarball, Buffer.from(data as ArrayBuffer));
  fs.mkdirSync(destDir, { recursive: true });
  const result = await runner.run(
    "tar",
    ["-xzf", tarball, "-C", destDir, "--strip-components=1", "--no-same-owner"],
    { env: baseEnv(), signal }
  );
  fs.rmSync(tarball, { force: true });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.slice(0, 300)}`);
  removeSymlinks(destDir);
  for (const rel of [GUIDANCE_PATH, RULES_DIR, ".claude", ".mcp.json"]) {
    fs.rmSync(path.join(destDir, rel), { recursive: true, force: true });
  }
}

/** Builds the temp workspace: the PR head in `repo/`, and everything the passes read in `context/`. */
export async function prepareWorkspace(
  octokit: Octokit,
  runner: CommandRunner,
  owner: string,
  repo: string,
  pr: PrInfo,
  signal?: AbortSignal
): Promise<Workspace> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-"));
  try {
    return await fillWorkspace(octokit, runner, owner, repo, pr, root, signal);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function fillWorkspace(
  octokit: Octokit,
  runner: CommandRunner,
  owner: string,
  repo: string,
  pr: PrInfo,
  root: string,
  signal?: AbortSignal
): Promise<Workspace> {
  const repoDir = path.join(root, "repo");
  const contextDir = path.join(root, "context");
  fs.mkdirSync(path.join(contextDir, "rules"), { recursive: true });

  const files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  })) as PrFile[];
  const diffPatch = buildDiffPatch(files);
  fs.writeFileSync(path.join(contextDir, "diff.patch"), diffPatch);
  fs.writeFileSync(path.join(contextDir, "pr.md"), `# ${pr.title}\n\n${stripBotBlocks(pr.body)}\n`);

  await downloadHead(octokit, runner, owner, repo, pr.headSha, repoDir, signal);

  const history = await fetchHistory(
    octokit,
    owner,
    repo,
    pr.baseSha,
    files.map((f) => f.previous_filename ?? f.filename)
  );
  fs.writeFileSync(path.join(contextDir, "history.md"), buildHistoryMarkdown(history));

  const { guidance, rules } = await fetchBaseRules(octokit, owner, repo, pr.baseRef);
  for (const rule of rules) {
    fs.writeFileSync(path.join(contextDir, "rules", rule.name), rule.content);
  }

  fs.writeFileSync(path.join(contextDir, "callers.md"), buildContextPack(repoDir, diffPatch));
  return {
    root,
    repoDir,
    contextDir,
    files,
    diffPatch,
    guidance,
    ruleFiles: rules.map((r) => r.name),
  };
}
