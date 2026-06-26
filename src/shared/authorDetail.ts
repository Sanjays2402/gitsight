/**
 * GitSight shared author-detail logic (W23).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. The pure builders behind
 * the web "contributor detail" drill-down: a per-author mini-dashboard
 * showing their commit sparkline (commits per recent week) and the files
 * they touch most (path + churn + commit count). This is the per-author
 * cousin of the W14 contributors leaderboard.
 *
 *   - The SPARKLINE is folded from the snapshot's commit dates (already in
 *     hand) — `buildAuthorSparkline` buckets a list of ISO dates into N
 *     recent weekly bins.
 *   - The FILE list is folded from `git log --author=<email>
 *     --pretty=format:%x1e%aE --numstat` output — `aggregateAuthorFiles`
 *     sums per-path churn + commit counts, post-filtering to the EXACT
 *     author email (since git's `--author` is a loose regex match).
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/authorDetail.test.ts
 */

const MS_PER_WEEK = 7 * 86_400_000;

/** A weekly commit sparkline for one author. */
export interface AuthorSparkline {
  /** Commit counts, oldest bin first .. most-recent bin last. */
  bins: number[];
  /** Busiest single week's count (>= 1 when any commits exist). */
  max: number;
  /** Total commits counted across the window. */
  total: number;
  /** Number of weekly bins (the window width). */
  weeks: number;
}

export interface SparklineOptions {
  /** Number of weekly bins (window width). Default 26. */
  weeks?: number;
  /** "Now" reference in ms (injectable for tests). Default Date.now(). */
  now?: number;
}

/**
 * Bucket a list of ISO commit dates into N recent weekly bins. Commits
 * older than the window are dropped; the newest bin is "this week". Pure +
 * timezone-stable (parses the absolute instant, buckets by elapsed weeks).
 */
export function buildAuthorSparkline(dates: string[], opts: SparklineOptions = {}): AuthorSparkline {
  const weeks = Math.max(1, Math.floor(opts.weeks ?? 26));
  const now = opts.now ?? Date.now();
  const bins = new Array<number>(weeks).fill(0);
  let total = 0;
  for (const iso of dates) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const weeksAgo = Math.floor((now - t) / MS_PER_WEEK);
    if (weeksAgo < 0 || weeksAgo >= weeks) continue;
    // weeksAgo 0 -> last bin; weeksAgo weeks-1 -> first bin.
    bins[weeks - 1 - weeksAgo]++;
    total++;
  }
  const max = bins.reduce((m, n) => Math.max(m, n), 0);
  return { bins, max, total, weeks };
}

/** One file an author has touched, with aggregated churn + frequency. */
export interface AuthorFile {
  path: string;
  /** Number of the author's commits that touched this file. */
  commits: number;
  insertions: number;
  deletions: number;
}

const RECORD = '\x1e';

/**
 * Normalise a numstat path: `git log --numstat` (no -z) renders renames as
 * `old => new` or `dir/{a => b}/file`. Collapse to the post-rename path so
 * aggregation keys on where the file lives now.
 */
export function normalizeNumstatPath(raw: string): string {
  let p = raw.trim();
  // Brace form: dir/{old => new}/file  ->  dir/new/file
  p = p.replace(/\{[^{}]*=>\s*([^{}]*)\}/g, (_m, to) => String(to).trim());
  // Bare arrow form: old => new  ->  new
  const arrow = p.split('=>');
  if (arrow.length === 2) p = arrow[1].trim();
  // Collapse any doubled slashes the brace removal may leave.
  return p.replace(/\/{2,}/g, '/');
}

/**
 * Aggregate the author's touched files from
 *   git log --author=<email> --pretty=format:%x1e%aE --numstat
 * output. Each \x1e-delimited record begins with the commit's author email
 * (%aE) followed by its numstat rows. We post-filter to the EXACT email
 * (lowercased) because git's `--author` is a loose substring/regex match,
 * then sum per-path churn + commit counts. Ordered by commit frequency,
 * then total churn, then path.
 */
export function aggregateAuthorFiles(stdout: string, email: string): AuthorFile[] {
  const want = (email || '').trim().toLowerCase();
  const byPath = new Map<string, AuthorFile>();

  for (const record of stdout.split(RECORD)) {
    const lines = record.split('\n').map(l => l.replace(/\r$/, ''));
    // Find the header (email) — the first non-empty line of the record.
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) continue;
    const recEmail = lines[i].trim().toLowerCase();
    if (want && recEmail !== want) continue;

    const touched = new Set<string>();
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(lines[j]);
      if (!m) continue;
      const path = normalizeNumstatPath(m[3]);
      if (!path) continue;
      const ins = m[1] === '-' ? 0 : parseInt(m[1], 10);
      const del = m[2] === '-' ? 0 : parseInt(m[2], 10);
      const entry = byPath.get(path) ?? { path, commits: 0, insertions: 0, deletions: 0 };
      entry.insertions += ins;
      entry.deletions += del;
      if (!touched.has(path)) {
        entry.commits += 1;
        touched.add(path);
      }
      byPath.set(path, entry);
    }
  }

  return [...byPath.values()].sort(
    (a, b) =>
      b.commits - a.commits ||
      (b.insertions + b.deletions) - (a.insertions + a.deletions) ||
      a.path.localeCompare(b.path),
  );
}

/** The author identity + their aggregated detail (the API payload shape). */
export interface AuthorDetail {
  name: string;
  email: string;
  commits: number;
  firstDate: string;
  lastDate: string;
  sparkline: AuthorSparkline;
  files: AuthorFile[];
  /** Total files the author has touched (files may be truncated for display). */
  filesTouched: number;
}

/**
 * The git pretty-format the companion uses for the author file read:
 * a RECORD separator (\x1e) then the author email (%aE) as the record
 * header, followed by the commit's --numstat rows.
 */
export const AUTHOR_FILES_FORMAT = '%x1e%aE';
