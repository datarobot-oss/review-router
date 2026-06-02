import { parse, CodeOwnersEntry } from "codeowners-utils";
import { OwnershipMap, Octokit } from "./types";

export function parseCodeowners(content: string): CodeOwnersEntry[] {
  return parse(content);
}

export function matchFileToOwners(
  filePath: string,
  entries: CodeOwnersEntry[]
): string[] {
  // codeowners-utils parse() returns entries in reverse file order (last entry first).
  // For last-match-wins semantics we take the first matching entry in this reversed array.
  const normalizedFile = filePath.replace(/^\//, "");
  for (const entry of entries) {
    if (fileMatchesPattern(normalizedFile, entry.pattern)) {
      return entry.owners;
    }
  }
  return [];
}

function patternToRegex(pattern: string): RegExp {
  let regexStr = pattern
    .replace(/^\//, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0GLOBSTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0GLOBSTAR\0/g, ".*")
    .replace(/\?/g, "[^/]");

  // Directory pattern: match anything under it
  if (regexStr.endsWith("/")) {
    regexStr += ".*";
  }

  return new RegExp(`^${regexStr}$`);
}

function fileMatchesPattern(filePath: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return patternToRegex(pattern).test(filePath);
}

function extractTeamSlug(owner: string): string | undefined {
  // Match @org/team-slug for any org
  const match = owner.match(/^@[^/]+\/(.+)$/);
  return match ? match[1] : undefined;
}

function getDefaultTeamSlugs(entries: CodeOwnersEntry[]): string[] {
  for (const entry of entries) {
    if (entry.pattern === "*") {
      return entry.owners
        .map((o) => extractTeamSlug(o))
        .filter((slug): slug is string => slug !== undefined);
    }
  }
  return [];
}

export function mapFilesToTeams(
  files: string[],
  entries: CodeOwnersEntry[]
): OwnershipMap {
  const teamFiles = new Map<string, string[]>();
  const unownedFiles: string[] = [];
  const defaultTeamSlugs = getDefaultTeamSlugs(entries);

  for (const file of files) {
    const owners = matchFileToOwners(file, entries);
    let teamSlugs = owners
      .map((o) => extractTeamSlug(o))
      .filter((slug): slug is string => slug !== undefined);

    if (teamSlugs.length === 0 && owners.length > 0) {
      teamSlugs = defaultTeamSlugs;
    }

    if (teamSlugs.length === 0) {
      unownedFiles.push(file);
    } else {
      for (const slug of teamSlugs) {
        const existing = teamFiles.get(slug) || [];
        existing.push(file);
        teamFiles.set(slug, existing);
      }
    }
  }

  return { teamFiles, unownedFiles };
}

export async function fetchCodeownersContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: ".github/CODEOWNERS",
      ref,
    });
    if ("content" in response.data && response.data.content) {
      return Buffer.from(response.data.content, "base64").toString("utf8");
    }
    return null;
  } catch (error: unknown) {
    const httpError = error as { status?: number };
    if (httpError.status === 404) {
      return null;
    }
    throw error;
  }
}
