/**
 * Pure summariser for `git shortlog -sne` output, used by the "Show Authors of
 * Range" command. Input format (one row per author):
 *
 *     <commits>\t<Name> <<email>>
 *
 * Returns rows sorted by commit count (desc), plus the total commits across
 * everyone — handy for rendering percentages.
 *
 * No vscode / no child_process imports — pure.
 */

export interface RangeAuthor {
  name: string;
  email: string;
  commits: number;
  /** 0–1 fraction of the range's total commits. */
  share: number;
}

export interface RangeAuthorSummary {
  authors: RangeAuthor[];
  totalCommits: number;
  totalAuthors: number;
}

const ROW_RE = /^\s*(\d+)\s+(.+?)\s+<([^>]+)>\s*$/;

export function summariseRangeAuthors(shortlogOut: string): RangeAuthorSummary {
  const rows: { name: string; email: string; commits: number }[] = [];
  let total = 0;
  for (const raw of shortlogOut.split('\n')) {
    if (!raw.trim()) continue;
    const m = ROW_RE.exec(raw);
    if (!m) continue;
    const commits = parseInt(m[1], 10);
    if (!Number.isFinite(commits) || commits <= 0) continue;
    rows.push({ name: m[2].trim(), email: m[3].trim().toLowerCase(), commits });
    total += commits;
  }
  rows.sort((a, b) => b.commits - a.commits);
  return {
    authors: rows.map(r => ({
      name: r.name,
      email: r.email,
      commits: r.commits,
      share: total ? r.commits / total : 0,
    })),
    totalCommits: total,
    totalAuthors: rows.length,
  };
}

/** Render one short line per author, e.g. `Alice — 42 (38%)`. */
export function formatRangeAuthorLine(a: RangeAuthor): string {
  const pct = Math.round(a.share * 100);
  return `${a.name} — ${a.commits} (${pct}%)`;
}

/**
 * Validate a `from..to` (or `from...to`) range expression. We accept the dotted
 * forms only; bare refs are rejected so callers don't accidentally pass HEAD.
 */
export function isRangeExpr(s: string): boolean {
  if (!s) return false;
  return /^[^\s]+(\.\.\.?)[^\s]+$/.test(s);
}
