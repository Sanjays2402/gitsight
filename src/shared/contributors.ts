/**
 * GitSight shared contributor-stats logic (W14).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. Aggregates a snapshot's
 * commits into a contributor leaderboard: per-author commit count, share
 * of the total, and the first/last time they appear in the history. This
 * is the snapshot-side cousin of the extension's `rangeAuthors`
 * summariser (which parses `git shortlog`); here we already hold the
 * parsed commits, so we fold them directly.
 *
 * Authors are keyed by lowercased email (the stable identity) while the
 * displayed name follows the MOST RECENT commit for that email — people
 * rename themselves, and the newest spelling is the one to show.
 *
 * No cross-file runtime import (Node type-strip compatible) — only an
 * `import type`.
 *
 * Tests: test/git/contributors.test.ts
 */

import type { GraphSnapshotCommit } from './graphSnapshot';

export interface Contributor {
  /** Display name (from the author's most-recent commit). */
  name: string;
  /** Lowercased email — the grouping key. */
  email: string;
  commits: number;
  /** 0..1 fraction of the total commits counted. */
  share: number;
  /** ISO date of this author's earliest commit in the snapshot. */
  firstDate: string;
  /** ISO date of this author's latest commit in the snapshot. */
  lastDate: string;
  /**
   * Lines inserted across this author's commits (W60). 0 until a churn fold
   * (`applyChurn`) merges a numstat pass over history — `buildContributors`
   * alone has only commit metadata, no per-line counts.
   */
  insertions: number;
  /** Lines deleted across this author's commits (W60). 0 until churn-folded. */
  deletions: number;
}

export interface ContributorStats {
  contributors: Contributor[];
  totalCommits: number;
  totalAuthors: number;
}

type AuthorCommit = Pick<GraphSnapshotCommit, 'author' | 'email' | 'date'>;

interface Acc {
  name: string;
  email: string;
  commits: number;
  firstDate: string;
  lastDate: string;
  /** Parsed timestamp of the commit that set `name` (newest wins). */
  nameAt: number;
}

/** Parse an ISO date to ms, or NaN. */
function ts(iso: string): number {
  return Date.parse(iso);
}

/**
 * Build the contributor leaderboard from commits. Order: commit count
 * descending, then name A→Z for ties. `share` always sums to ~1 across
 * the list (subject to rounding by the caller).
 */
export function buildContributors(commits: AuthorCommit[]): ContributorStats {
  const byEmail = new Map<string, Acc>();
  let total = 0;

  for (const c of commits) {
    const email = (c.email || '').trim().toLowerCase() || c.author.trim().toLowerCase();
    if (!email && !c.author) continue;
    total++;
    const when = ts(c.date);
    const existing = byEmail.get(email);
    if (!existing) {
      byEmail.set(email, {
        name: c.author.trim() || email,
        email,
        commits: 1,
        firstDate: c.date,
        lastDate: c.date,
        nameAt: Number.isNaN(when) ? -Infinity : when,
      });
      continue;
    }
    existing.commits++;
    // Track the earliest / latest dates seen.
    if (!Number.isNaN(when)) {
      if (Number.isNaN(ts(existing.firstDate)) || when < ts(existing.firstDate)) existing.firstDate = c.date;
      if (Number.isNaN(ts(existing.lastDate)) || when > ts(existing.lastDate)) existing.lastDate = c.date;
      // Newest commit wins the displayed name.
      if (when >= existing.nameAt && c.author.trim()) {
        existing.name = c.author.trim();
        existing.nameAt = when;
      }
    }
  }

  const contributors: Contributor[] = [...byEmail.values()]
    .map(a => ({
      name: a.name,
      email: a.email,
      commits: a.commits,
      share: total ? a.commits / total : 0,
      firstDate: a.firstDate,
      lastDate: a.lastDate,
      // Churn starts at zero; a later `applyChurn` fold fills it from numstat.
      insertions: 0,
      deletions: 0,
    }))
    .sort((x, y) => y.commits - x.commits || x.name.toLowerCase().localeCompare(y.name.toLowerCase()));

  return { contributors, totalCommits: total, totalAuthors: contributors.length };
}

/** Render one contributor's share as a rounded integer percentage. */
export function sharePercent(c: Contributor): number {
  return Math.round(c.share * 100);
}

// ── Churn aggregate + sort (W60) ─────────────────────────────────────

/**
 * The git pretty-format the companion uses for the contributor churn fold
 * (W60): a RECORD separator (\x1e) then the author email (%aE) as the record
 * header, followed by the commit's --numstat rows. Mirrors AUTHOR_FILES_FORMAT
 * but folded across ALL authors in one pass rather than scoped to one.
 */
export const CONTRIBUTOR_CHURN_FORMAT = '%x1e%aE';

const CHURN_RECORD = '\x1e';

/** Per-email churn totals folded from a numstat log. */
export interface EmailChurn {
  insertions: number;
  deletions: number;
}

/**
 * Fold `git log --pretty=format:CONTRIBUTOR_CHURN_FORMAT --numstat` output
 * into per-email insertion/deletion totals (W60). Each \x1e-delimited record
 * begins with the commit's author email (%aE) followed by its numstat rows.
 * Emails are lowercased to match the leaderboard's identity key. Binary rows
 * (`-\t-`) contribute nothing. One pass over all authors — far cheaper than a
 * per-author `--author` read each.
 */
export function parseChurnByEmail(stdout: string): Map<string, EmailChurn> {
  const byEmail = new Map<string, EmailChurn>();
  for (const record of (stdout ?? '').split(CHURN_RECORD)) {
    const lines = record.split('\n').map(l => l.replace(/\r$/, ''));
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) continue;
    const email = lines[i].trim().toLowerCase();
    if (!email) continue;
    const entry = byEmail.get(email) ?? { insertions: 0, deletions: 0 };
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^(-|\d+)\t(-|\d+)\t/.exec(lines[j]);
      if (!m) continue;
      if (m[1] !== '-') entry.insertions += parseInt(m[1], 10);
      if (m[2] !== '-') entry.deletions += parseInt(m[2], 10);
    }
    byEmail.set(email, entry);
  }
  return byEmail;
}

/**
 * Merge per-email churn totals onto a contributor list (W60), returning a
 * fresh list (inputs are not mutated). An email with no churn entry keeps its
 * zero totals. Order is preserved — callers sort separately so the fold and
 * the ordering stay independent.
 */
export function applyChurn(contributors: Contributor[], churn: Map<string, EmailChurn>): Contributor[] {
  return contributors.map(c => {
    const ch = churn.get((c.email || '').toLowerCase());
    return ch ? { ...c, insertions: ch.insertions, deletions: ch.deletions } : { ...c };
  });
}

/** How the leaderboard can be ordered (W60). */
export type ContributorSort = 'commits' | 'churn' | 'recent' | 'name';

const CONTRIBUTOR_SORTS: ContributorSort[] = ['commits', 'churn', 'recent', 'name'];

/** True when a string names a supported contributor sort key (W60). */
export function isContributorSort(s: unknown): s is ContributorSort {
  return typeof s === 'string' && (CONTRIBUTOR_SORTS as string[]).includes(s);
}

/** Total churn (insertions + deletions) for a contributor (W60). */
export function contributorChurn(c: Pick<Contributor, 'insertions' | 'deletions'>): number {
  return Math.max(0, c.insertions) + Math.max(0, c.deletions);
}

/**
 * Sort a contributor list by a chosen key (W60), returning a fresh array
 * (the input is not mutated). Every ordering breaks ties by name A→Z so the
 * result is stable + deterministic:
 *   - commits: most commits first (the default leaderboard order);
 *   - churn:   most lines changed first (needs a prior `applyChurn` fold);
 *   - recent:  most-recently-active first (latest lastDate);
 *   - name:    alphabetical by display name.
 */
export function sortContributors(contributors: Contributor[], key: ContributorSort): Contributor[] {
  const byName = (x: Contributor, y: Contributor) =>
    x.name.toLowerCase().localeCompare(y.name.toLowerCase());
  const list = contributors.slice();
  switch (key) {
    case 'churn':
      return list.sort((x, y) => contributorChurn(y) - contributorChurn(x) || byName(x, y));
    case 'recent':
      return list.sort((x, y) => {
        const dx = Date.parse(x.lastDate);
        const dy = Date.parse(y.lastDate);
        const ny = Number.isNaN(dy) ? -Infinity : dy;
        const nx = Number.isNaN(dx) ? -Infinity : dx;
        return ny - nx || byName(x, y);
      });
    case 'name':
      return list.sort(byName);
    case 'commits':
    default:
      return list.sort((x, y) => y.commits - x.commits || byName(x, y));
  }
}
