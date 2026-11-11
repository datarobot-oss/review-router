// One pass over the text: the first four alternatives are the spans that hide a mention, and they are skipped
// as a whole. A code fence opens and closes at the start of a line, and the closing run is at least as long
// as the opening one, as on GitHub. A fence with no closer runs to the end, which also keeps the scan linear. The last alternative is a login after a character that can't continue a
// word, an email or a team path, and not followed by a team slash. Skipping spans, instead of stripping
// them first, leaves no text behind that could join into a new span.
const SCAN = new RegExp(
  [
    "^ {0,3}(?<fence>`{3,})[^`\\n]*\\n(?:[\\s\\S]*?^ {0,3}\\k<fence>`*[ \\t]*$|[\\s\\S]*)",
    "<!--[\\s\\S]*?-->",
    "`[^`\\n]*`",
    "^[ \\t]*>.*$",
    "(?<![\\w@/`])@(?<login>[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\\w/-])",
  ].join("|"),
  "gm"
);

/** Whether a comment can notify anyone: a bot never does, and the author's own comment does only by mentioning someone. */
export function notifiesAnyone(comment: {
  commenter: string;
  author: string;
  body: string | null | undefined;
  isBot: boolean;
}): boolean {
  if (comment.isBot) return false;
  return comment.commenter !== comment.author || extractMentions(comment.body).length > 0;
}

/**
 * Returns the GitHub logins mentioned in a comment, once each in order of first appearance.
 * Mentions in code, quotes and HTML comments, team mentions and email addresses don't count.
 */
export function extractMentions(body: string | null | undefined): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const match of body.matchAll(SCAN)) {
    const login = match.groups?.login;
    if (login === undefined || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    logins.push(login);
  }
  return logins;
}
