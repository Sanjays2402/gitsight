/**
 * Pure helpers for the Fixture-Author CodeLens (F50).
 *
 * Identifies test fixture / snapshot / golden-file paths and parses the
 * `git log --pretty=format:%H|%h|%aI|%an` output for the file into the
 * "last N authors" summary the CodeLens shows at line 0:
 *
 *   "Last 3 authors: alice (2d ago), bob (3w ago), carol (6mo ago)"
 *
 * The classifier is conservative — only well-known fixture/snapshot
 * conventions trigger the lens. False positives are worse than false
 * negatives here: a CodeLens that fires on a regular source file
 * just adds noise.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/fixtureLens.test.ts.
 */

/**
 * True when the path looks like a test fixture / snapshot / golden file.
 *
 * Recognised patterns (relative path, posix-separator normalised):
 *   - .../__snapshots__/<anything>
 *   - .../__fixtures__/<anything>
 *   - .../fixtures/<anything>      (only when under a tests dir or root-level fixtures/)
 *   - .../snapshots/<anything>     (same gating)
 *   - .../testdata/<anything>      (go convention)
 *   - .../cassettes/<anything>     (vcr-style HTTP fixtures)
 *   - <anything>.snap              (jest/storybook)
 *   - <anything>.snap.ts           (jest)
 *   - <anything>.golden            (go)
 *   - <anything>.expected          (informal but common)
 *   - <anything>.spec.snap.png     (visual regression)
 *
 * The path is expected to be POSIX-style (forward slashes); call
 * `path.relative(repo, file).split(path.sep).join('/')` before passing.
 */
export function isFixtureFile(relPath: string): boolean {
  if (!relPath || relPath.length > 4096) return false;
  const p = relPath.replace(/\\/g, '/');
  const segs = p.split('/');
  if (!segs.length) return false;

  // 1. Path segments — directory-anchored.
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (s === '__snapshots__' || s === '__fixtures__') return true;
    if (s === 'testdata' || s === 'cassettes') return true;
    // 'fixtures' / 'snapshots' must be under a test-y ancestor OR at the root
    // (avoids tagging /docs/snapshots/ as a fixture dir).
    if (s === 'fixtures' || s === 'snapshots') {
      if (i === 0) return true;
      const ancestors = segs.slice(0, i).join('/');
      if (/\b(test|tests|spec|specs|__tests__)\b/.test(ancestors)) return true;
    }
  }

  // 2. Extension/basename signals.
  const base = segs[segs.length - 1];
  if (/\.snap$/i.test(base)) return true;
  if (/\.snap\.(ts|tsx|js|jsx)$/i.test(base)) return true;
  if (/\.snap\.(png|jpg|jpeg|webp)$/i.test(base)) return true;
  if (/\.golden$/i.test(base)) return true;
  if (/\.expected(\.[a-z0-9]+)?$/i.test(base)) return true;
  // "fixture" / "snapshot" appearing inside the basename as a real word.
  if (/(^|[._-])(fixture|snapshot)s?([._-]|$)/i.test(base)) return true;

  return false;
}

/**
 * Parsed log row. The git command:
 *
 *   git log --max-count=N --follow --pretty=format:%H|%h|%aI|%an -- <file>
 *
 * gives one line per commit. Author name can contain '|', so everything
 * after the third separator is joined back together.
 */
export interface FixtureCommit {
  sha: string;
  shortSha: string;
  dateIso: string;
  author: string;
}

export function parseFixtureLog(raw: string): FixtureCommit[] {
  const out: FixtureCommit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const [sha, shortSha, dateIso, ...rest] = parts;
    out.push({ sha, shortSha, dateIso, author: rest.join('|').trim() });
  }
  return out;
}

export interface AuthorBucket {
  author: string;
  /** Most recent commit by this author. */
  latest: FixtureCommit;
  /** All commits by this author (newest first). */
  commits: FixtureCommit[];
}

/**
 * Group commits by author, preserving recency order — the bucket with
 * the most recent commit appears first. Commits within a bucket are
 * newest-first.
 *
 * If a single author has multiple commits, they're still only listed
 * once in the bucket list — the CodeLens shows "last N distinct authors".
 */
export function bucketByAuthor(commits: FixtureCommit[]): AuthorBucket[] {
  const seen = new Map<string, AuthorBucket>();
  for (const c of commits) {
    const key = c.author.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      existing.commits.push(c);
    } else {
      seen.set(key, { author: c.author, latest: c, commits: [c] });
    }
  }
  return Array.from(seen.values());
}

/**
 * Compact relative-time formatter — "2d", "3w", "6mo", "1y", "just now".
 * Chosen to fit the CodeLens line; no localisation (English only).
 */
export function relTime(then: Date | string, now: Date): string {
  const t = typeof then === 'string' ? new Date(then) : then;
  if (Number.isNaN(t.getTime())) return '?';
  const ms = Math.max(0, now.getTime() - t.getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 18) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

export interface FixtureLensLine {
  /** Title rendered by the CodeLens (no leading icon — caller adds). */
  title: string;
  /** Tooltip body when the CodeLens supports hover (currently unused). */
  tooltip: string;
  /** The buckets used to build the title, for downstream consumers. */
  buckets: AuthorBucket[];
}

/**
 * Build the lens row from a freshly-parsed commit list. `topN` controls
 * how many distinct authors get inline mention; the rest collapse into
 * "and N more".
 */
export function buildLensLine(commits: FixtureCommit[], now: Date, topN = 3): FixtureLensLine | undefined {
  if (!commits.length) return undefined;
  const buckets = bucketByAuthor(commits);
  const shown = buckets.slice(0, topN);
  const rest = buckets.length - shown.length;
  const parts = shown.map(b => `${b.author} (${relTime(b.latest.dateIso, now)})`);
  let title = parts.join(', ');
  if (rest > 0) title += `, +${rest} more`;
  const prefix = buckets.length === 1 ? 'Last author' : `Last ${Math.min(topN, buckets.length)} authors`;
  const fullTitle = `${prefix}: ${title}`;
  const tooltipLines = [
    `Fixture/snapshot file — ${commits.length} commit${commits.length === 1 ? '' : 's'} across ${buckets.length} distinct author${buckets.length === 1 ? '' : 's'}.`,
    '',
    ...buckets.map(b => {
      const latest = b.latest;
      return `${b.author} — ${b.commits.length} commit${b.commits.length === 1 ? '' : 's'}, last ${latest.shortSha} ${relTime(latest.dateIso, now)}`;
    }),
  ];
  return {
    title: fullTitle,
    tooltip: tooltipLines.join('\n'),
    buckets,
  };
}
