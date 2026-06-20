/**
 * Pure helper: summarise a `git log` output of `%aI\t%an` lines for a single
 * file into a small stats struct used by the per-file commit count CodeLens.
 *
 * Input format (one commit per line):
 *
 *   2026-06-19T10:00:00Z\tAlice
 *
 * Returns commit count, first/last commit dates, contributor count, and a
 * human-friendly span string (e.g. "18mo", "3d", "just now").
 *
 * No vscode / no child_process imports — pure.
 */

export interface FileStats {
  totalCommits: number;
  firstCommit?: Date;
  lastCommit?: Date;
  contributors: number;
  /** Human-friendly span between first and last commit, e.g. "18mo", "<1d". */
  spanText: string;
  /** Top contributor by commit count (name only). */
  topContributor?: string;
}

export function summariseFileStats(logOut: string): FileStats {
  const authors = new Map<string, number>();
  let first: Date | undefined, last: Date | undefined;
  let count = 0;
  for (const raw of logOut.split('\n')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    if (tab < 0) continue;
    const iso = raw.slice(0, tab);
    const author = raw.slice(tab + 1).trim();
    const t = Date.parse(iso);
    if (isNaN(t)) continue;
    const d = new Date(t);
    if (!first || d < first) first = d;
    if (!last || d > last) last = d;
    authors.set(author, (authors.get(author) ?? 0) + 1);
    count++;
  }
  const top = [...authors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    totalCommits: count,
    firstCommit: first,
    lastCommit: last,
    contributors: authors.size,
    spanText: spanBetween(first, last),
    topContributor: top,
  };
}

export function spanBetween(a?: Date, b?: Date): string {
  if (!a || !b) return '';
  const ms = Math.max(0, b.getTime() - a.getTime());
  if (ms < 24 * 3600_000) return '<1d';
  const days = Math.floor(ms / 86_400_000);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}

export function formatStats(s: FileStats): string {
  const parts: string[] = [];
  parts.push(`${s.totalCommits} commit${s.totalCommits === 1 ? '' : 's'}`);
  if (s.spanText) parts.push(`${s.spanText} of history`);
  if (s.contributors > 1) parts.push(`${s.contributors} contributors`);
  else if (s.contributors === 1 && s.topContributor) parts.push(`by ${s.topContributor}`);
  return parts.join('  ·  ');
}
