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
    }))
    .sort((x, y) => y.commits - x.commits || x.name.toLowerCase().localeCompare(y.name.toLowerCase()));

  return { contributors, totalCommits: total, totalAuthors: contributors.length };
}

/** Render one contributor's share as a rounded integer percentage. */
export function sharePercent(c: Contributor): number {
  return Math.round(c.share * 100);
}
