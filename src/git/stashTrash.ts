/**
 * Pure helpers for the Stash Trash Bin (F67).
 *
 * Stashes accumulate. Engineers run `git stash` ten times during a long
 * refactor, ship the change, and never come back to clean up the reflog.
 * Six months later there's a wall of "WIP on feature/x" entries that
 * outlive the branches they were taken on, and nobody wants to manually
 * pick through `git stash list` to figure out which ones are safe to drop.
 *
 * This module classifies stashes by age + branch survival so the picker
 * can pre-tick the "safe to drop" set:
 *
 *   - DROP-SAFE  age >= staleAfterDays AND source branch is gone OR
 *                age >= ancientAfterDays (180d) regardless of branch
 *   - REVIEW     past staleAfterDays but the source branch still exists
 *                (might still be relevant — show it but don't pre-tick)
 *   - FRESH      younger than staleAfterDays — informational only
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/stashTrash.test.ts.
 *
 * Mirrors the buildPruneCandidates shape from branchPruner.ts so the UI
 * layer feels consistent across the prune-X family of features.
 */

import { Stash } from './git';
import { extractStashBranch, cleanStashSubject, isNamedStash } from './stashSort';

export type StashAgeBucket = 'fresh' | 'stale' | 'ancient';

export interface StashCandidate {
  stash: Stash;
  /** Days since the stash was created (Infinity when the date is bad). */
  ageDays: number;
  ageBucket: StashAgeBucket;
  /** Source branch as recorded in the stash subject (`On <branch>:`). */
  sourceBranch?: string;
  /** True when the source branch is gone from local refs. */
  sourceBranchGone: boolean;
  /** Cleaned subject text (matches the picker convention). */
  cleanSubject: string;
  /** True when the stash was created with `git stash push -m`. */
  named: boolean;
  /** True when default-pick is "drop me" (see file header). */
  dropSafe: boolean;
}

export interface StashTrashOptions {
  /** Past this age, stashes are eligible for the dropSafe set when the source branch is gone. */
  staleAfterDays: number;
  /** Past this age, stashes are dropSafe regardless of branch survival. */
  ancientAfterDays: number;
  /** Set of branch names that currently exist locally. */
  liveBranches: Set<string>;
  /** Optional list of branch names the user wants treated as still-alive. */
  extraLiveBranches?: string[];
}

export interface StashTrashSummary {
  total: number;
  dropSafe: number;
  fresh: number;
  stale: number;
  ancient: number;
  sourceBranchGone: number;
}

/**
 * Build the trash-bin candidate list. Output ordering:
 *   1. dropSafe items first, oldest at the top.
 *   2. stale-but-review items next (oldest first).
 *   3. fresh items last (informational, never pre-ticked).
 */
export function buildStashCandidates(
  stashes: Stash[],
  options: StashTrashOptions,
  now: Date,
): StashCandidate[] {
  const live = new Set([
    ...options.liveBranches,
    ...(options.extraLiveBranches ?? []),
  ]);
  const candidates: StashCandidate[] = stashes.map(s => {
    const days = ageDays(s.date, now);
    const ageBucket =
      days >= options.ancientAfterDays
        ? 'ancient'
        : days >= options.staleAfterDays
          ? 'stale'
          : 'fresh';
    const sourceBranch = extractStashBranch(s.subject) ?? (s.branch || undefined);
    const sourceBranchGone = !!sourceBranch && !live.has(sourceBranch);
    const dropSafe =
      ageBucket === 'ancient' ||
      (ageBucket === 'stale' && sourceBranchGone);
    return {
      stash: s,
      ageDays: days,
      ageBucket,
      sourceBranch,
      sourceBranchGone,
      cleanSubject: cleanStashSubject(s.subject),
      named: isNamedStash(s.subject),
      dropSafe,
    };
  });
  candidates.sort((a, b) => {
    const bucket = (c: StashCandidate) =>
      c.dropSafe ? 0 : c.ageBucket !== 'fresh' ? 1 : 2;
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;
    return a.stash.index - b.stash.index;
  });
  return candidates;
}

/** Compute integer days between `date` and `now`, treating bad dates as Infinity. */
export function ageDays(date: Date | undefined, now: Date): number {
  if (!date || Number.isNaN(date.getTime())) return Infinity;
  const ms = now.getTime() - date.getTime();
  if (ms < 0) return 0;
  return Math.floor(ms / 86400000);
}

export function summariseStashTrash(candidates: StashCandidate[]): StashTrashSummary {
  let dropSafe = 0, fresh = 0, stale = 0, ancient = 0, gone = 0;
  for (const c of candidates) {
    if (c.dropSafe) dropSafe++;
    if (c.ageBucket === 'fresh') fresh++;
    if (c.ageBucket === 'stale') stale++;
    if (c.ageBucket === 'ancient') ancient++;
    if (c.sourceBranchGone) gone++;
  }
  return { total: candidates.length, dropSafe, fresh, stale, ancient, sourceBranchGone: gone };
}

/**
 * Concise picker-title summary.
 *   "12 stashes \u00b7 5 safe to drop \u00b7 3 ancient \u00b7 4 with source branch gone"
 */
export function describeStashTrash(s: StashTrashSummary): string {
  const word = s.total === 1 ? 'stash' : 'stashes';
  const bits = [`${s.total} ${word}`, `${s.dropSafe} safe to drop`];
  if (s.ancient) bits.push(`${s.ancient} ancient`);
  if (s.sourceBranchGone) bits.push(`${s.sourceBranchGone} branch-gone`);
  return bits.join(' \u00b7 ');
}

/**
 * Per-row description suitable for the picker `description:` slot.
 *   "ancient \u00b7 412d \u00b7 branch gone"
 *   "stale \u00b7 124d \u00b7 on feature/x"
 *   "fresh \u00b7 12d \u00b7 on main"
 */
export function formatStashRow(c: StashCandidate): string {
  const age = c.ageDays === Infinity ? '?' : `${c.ageDays}d`;
  const bits = [c.ageBucket, age];
  if (c.sourceBranchGone) bits.push('branch gone');
  else if (c.sourceBranch) bits.push(`on ${c.sourceBranch}`);
  if (c.named) bits.push('named');
  return bits.join(' \u00b7 ');
}
