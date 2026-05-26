import { parse, CodeOwnersEntry } from "codeowners-utils";
import { OwnershipMap } from "./types";

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

function fileMatchesPattern(filePath: string, pattern: string): boolean {
  // Normalize: remove leading /
  const normalizedPattern = pattern.replace(/^\//, "");

  // Wildcard * matches everything
  if (normalizedPattern === "*") {
    return true;
  }

  // Directory pattern (ends with /)
  if (normalizedPattern.endsWith("/")) {
    return filePath.startsWith(normalizedPattern);
  }

  // Directory prefix without trailing slash
  if (
    filePath.startsWith(normalizedPattern + "/") ||
    filePath === normalizedPattern
  ) {
    return true;
  }

  // Glob-style matching for simple patterns
  const regexStr = normalizedPattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)(\*)/g, "[^/]*");
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

function extractTeamSlug(
  owner: string,
  orgPrefix: string
): string | undefined {
  const prefix = `@${orgPrefix}/`;
  if (owner.startsWith(prefix)) {
    return owner.slice(prefix.length);
  }
  return undefined;
}

export function mapFilesToTeams(
  files: string[],
  entries: CodeOwnersEntry[],
  orgPrefix: string
): OwnershipMap {
  const teamFiles = new Map<string, string[]>();
  const unownedFiles: string[] = [];

  for (const file of files) {
    const owners = matchFileToOwners(file, entries);
    const teamSlugs = owners
      .map((o) => extractTeamSlug(o, orgPrefix))
      .filter((slug): slug is string => slug !== undefined);

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
  octokit: ReturnType<typeof import("@actions/github").getOctokit>,
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
