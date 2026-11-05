import * as core from "@actions/core";
import { Octokit } from "./types";

export const WELCOME_MARKER = "<!-- review-router-welcome -->";
/** The markers of the separate Jira and external contributor comments this comment replaces. */
export const JIRA_COMMENT_MARKER = "<!-- review-router-jira -->";
export const EXTERNAL_COMMENT_MARKER = "<!-- review-router-external -->";
export const WELCOME_DOCS_URL = "https://github.com/datarobot-oss/review-router#readme";

export type WelcomeSection = "jira" | "external";

/** The order of the sections in the comment. */
const SECTION_ORDER: WelcomeSection[] = ["jira", "external"];
/** A Jira card follows the PR title, so it is replaced. An external message is posted once. */
const REPLACES_EXISTING: Record<WelcomeSection, boolean> = { jira: true, external: false };
const LEGACY_MARKER: Record<WelcomeSection, string> = {
  jira: JIRA_COMMENT_MARKER,
  external: EXTERNAL_COMMENT_MARKER,
};
const FOOTER = `<sub>[How Review Router works](${WELCOME_DOCS_URL})</sub>`;
const SECTION_PATTERN =
  /<!-- rr:section:(jira|external) -->\n([\s\S]*?)\n<!-- \/rr:section:\1 -->/g;

function readSections(body: string): Map<WelcomeSection, string> {
  const sections = new Map<WelcomeSection, string>();
  for (const match of body.matchAll(SECTION_PATTERN)) {
    sections.set(match[1] as WelcomeSection, match[2]);
  }
  return sections;
}

/** The welcome comment with one section set. The other sections stay as they were. */
export function setWelcomeSection(body: string, name: WelcomeSection, content: string): string {
  const sections = readSections(body);
  sections.set(name, content);
  const blocks = SECTION_ORDER.filter((section) => sections.has(section)).map(
    (section) =>
      `<!-- rr:section:${section} -->\n${sections.get(section)}\n<!-- /rr:section:${section} -->`
  );
  return [WELCOME_MARKER, ...blocks, FOOTER].join("\n\n");
}

/**
 * Writes one section of the welcome comment, which the Router posts only when a section has
 * something to say. Moves a legacy Jira comment into it. Never throws: a failure is a warning.
 */
export async function upsertWelcomeSection(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  name: WelcomeSection,
  content: string
): Promise<void> {
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const welcome = comments.find((c) => c.body?.includes(WELCOME_MARKER));
    const legacy = comments.find((c) => c.body?.includes(LEGACY_MARKER[name]));

    if (legacy && !REPLACES_EXISTING[name]) {
      core.info(`The ${name} comment already exists on PR #${prNumber}, skipping`);
      return;
    }

    const current = welcome?.body ?? "";
    const existing = readSections(current).get(name);
    if (existing !== undefined && (!REPLACES_EXISTING[name] || existing === content)) {
      core.debug(`PR #${prNumber}: the ${name} section is up to date`);
    } else {
      const body = setWelcomeSection(current, name, content);
      if (welcome) {
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: welcome.id, body });
        core.info(`Updated the ${name} section of the welcome comment on PR #${prNumber}`);
      } else {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
        core.info(`Posted the welcome comment on PR #${prNumber}`);
      }
    }

    if (legacy) {
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: legacy.id });
    }
  } catch (error) {
    core.warning(
      `Failed to write the ${name} section on PR #${prNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
