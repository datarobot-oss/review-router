const FENCED_CODE = /```[\s\S]*?```/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const INLINE_CODE = /`[^`\n]*`/g;
const QUOTED_LINE = /^[ \t]*>.*$/gm;
// A login after a character that can't continue a word, an email or a team path, and not followed by a team slash.
const MENTION = /(?<![\w@/`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![\w/-])/g;

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
  const text = body
    .replace(FENCED_CODE, "")
    .replace(HTML_COMMENT, "")
    .replace(INLINE_CODE, "")
    .replace(QUOTED_LINE, "");
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const login = match[1];
    if (seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    logins.push(login);
  }
  return logins;
}
