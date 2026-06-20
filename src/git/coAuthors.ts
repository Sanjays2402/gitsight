/**
 * Co-authored-by trailer parsing for commit messages.
 *
 * Per Git's documented trailer format, lines like:
 *
 *   Co-authored-by: Alice <alice@example.com>
 *
 * appear at the bottom of a commit body, one per line. Whitespace and case
 * are normalised, and duplicates are folded. This module is pure (no
 * vscode / child_process) so it can be unit-tested in isolation.
 */

export interface CoAuthor {
  name: string;
  email: string;
}

const TRAILER_RE = /^\s*Co-authored-by:\s*([^<]+?)\s*<([^>]+)>\s*$/i;

export function parseCoAuthors(message: string): CoAuthor[] {
  if (!message) return [];
  const seen = new Set<string>();
  const out: CoAuthor[] = [];
  for (const raw of message.split('\n')) {
    const m = TRAILER_RE.exec(raw);
    if (!m) continue;
    const name = m[1].trim();
    const email = m[2].trim().toLowerCase();
    if (!email) continue;
    const key = email;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, email });
  }
  return out;
}

export function formatCoAuthors(authors: CoAuthor[]): string {
  return authors.map(a => `${a.name} <${a.email}>`).join(', ');
}

export function coAuthorTrailerLines(authors: CoAuthor[]): string[] {
  return authors.map(a => `Co-authored-by: ${a.name} <${a.email}>`);
}
