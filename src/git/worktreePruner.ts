/**
 * Pure helpers for the Worktree Pruner (F64).
 *
 * The mirror of the F52 Branch Staleness Pruner, applied to git worktrees
 * instead of branches. Each worktree is classified along three axes:
 *
 *   1. existsOnDisk     — does the working directory still exist? (Git
 *                          keeps the metadata even when the directory is
 *                          rm -rf'd; `git worktree prune` cleans those.)
 *   2. branchUpstreamGone — is the branch the worktree is on still
 *                            present on `origin`? (a worktree on
 *                            `feature/x` whose upstream was deleted is
 *                            a strong prune candidate)
 *   3. ageDays           — days since the worktree's index was last
 *                            touched. Old worktrees with no upstream are
 *                            almost certainly leftover spikes.
 *
 * The classifier output flags entries as pruneSafe when ALL hold:
 *   - not the current worktree (you can't prune the directory you're in)
 *   - not locked (locked = explicit user intent)
 *   - existsOnDisk OR branchUpstreamGone (otherwise it's just stale; the
 *     user can opt-in to those via includeStaleOnly)
 *   - ageDays >= minAgeDays
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/worktreePruner.test.ts.
 */

import { Worktree } from './git';

export type PruneReason =
  | 'missing-on-disk'    // git metadata says it exists, fs disagrees → prune via `git worktree prune`
  | 'upstream-gone'      // branch's upstream was deleted (e.g. PR merged + remote cleanup)
  | 'stale-only';        // exists + has upstream, but index untouched for ages

export interface WorktreePruneCandidate {
  worktree: Worktree;
  ageDays: number;
  existsOnDisk: boolean;
  branchUpstreamGone: boolean;
  /** Non-empty when there's a recommended prune reason; empty when worktree is healthy/protected. */
  reasons: PruneReason[];
  /** True when default-batch-safe to prune (see classifier rules above). */
  pruneSafe: boolean;
  /** Reason this worktree is NOT pruneSafe, when one exists. */
  protectedReason?: 'current' | 'locked' | 'main' | 'too-young' | 'no-signal';
}

export interface PruneOptions {
  /** Absolute path to the worktree currently active; never offered. */
  currentWorktreePath: string;
  /** Branches whose upstream is currently present on a remote. */
  branchesWithUpstream: Set<string>;
  /** Minimum age in days an entry must reach before pruneSafe. */
  minAgeDays: number;
  /**
   * When true, include entries whose only signal is age (existsOnDisk +
   * upstream both fine) in pruneSafe. Default false — surfaces these as
   * informational rows below the deletion bucket.
   */
  includeStaleOnly?: boolean;
  /** Worktrees flagged as the repo's "main" by `git worktree list` (always skipped). */
  isMain?: (w: Worktree) => boolean;
  /** True when the worktree's directory currently exists on disk. */
  existsOnDisk: (w: Worktree) => boolean;
  /** Age in days since the worktree's index was last touched. */
  ageDaysFor: (w: Worktree) => number;
}

export interface PruneSummary {
  total: number;
  pruneSafe: number;
  missingOnDisk: number;
  upstreamGone: number;
  staleOnly: number;
  protectedCount: number;
}

/**
 * Build the ranked candidate list for the picker. Ordering:
 *   1. missing-on-disk first (those are pure metadata cleanup)
 *   2. upstream-gone next (a branch you can't reach, prime candidate)
 *   3. stale-only after that (only when includeStaleOnly=true)
 *   4. protected (current/locked/main/young) sorted alphabetically last
 *      so the user can still see them in the picker.
 */
export function buildWorktreePruneCandidates(
  worktrees: Worktree[],
  options: PruneOptions,
): WorktreePruneCandidate[] {
  const out: WorktreePruneCandidate[] = [];
  for (const w of worktrees) {
    const reasons: PruneReason[] = [];
    const existsOnDisk = options.existsOnDisk(w);
    const isCurrent = w.path === options.currentWorktreePath;
    const isMain = options.isMain ? options.isMain(w) : false;
    const upstreamGone = !w.bare && !w.detached && !!w.branch && !options.branchesWithUpstream.has(w.branch);
    const ageDays = options.ageDaysFor(w);

    if (!existsOnDisk) reasons.push('missing-on-disk');
    if (upstreamGone) reasons.push('upstream-gone');
    if (!reasons.length && options.includeStaleOnly && ageDays >= options.minAgeDays) {
      reasons.push('stale-only');
    }

    let protectedReason: WorktreePruneCandidate['protectedReason'];
    if (isCurrent) protectedReason = 'current';
    else if (w.locked) protectedReason = 'locked';
    else if (isMain) protectedReason = 'main';
    else if (reasons.length === 0) protectedReason = 'no-signal';
    else if (ageDays < options.minAgeDays && !reasons.includes('missing-on-disk')) protectedReason = 'too-young';

    const pruneSafe = !protectedReason && reasons.length > 0;

    out.push({
      worktree: w,
      ageDays,
      existsOnDisk,
      branchUpstreamGone: upstreamGone,
      reasons,
      pruneSafe,
      protectedReason,
    });
  }

  // Sort.
  const reasonRank = (c: WorktreePruneCandidate): number => {
    if (!c.reasons.length) return 9;
    if (c.reasons.includes('missing-on-disk')) return 0;
    if (c.reasons.includes('upstream-gone')) return 1;
    if (c.reasons.includes('stale-only')) return 2;
    return 3;
  };
  out.sort((a, b) => {
    if (a.pruneSafe !== b.pruneSafe) return a.pruneSafe ? -1 : 1;
    const ra = reasonRank(a);
    const rb = reasonRank(b);
    if (ra !== rb) return ra - rb;
    if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;
    return a.worktree.path.localeCompare(b.worktree.path);
  });
  return out;
}

export function summariseWorktreePrune(c: WorktreePruneCandidate[]): PruneSummary {
  const s: PruneSummary = {
    total: c.length,
    pruneSafe: 0,
    missingOnDisk: 0,
    upstreamGone: 0,
    staleOnly: 0,
    protectedCount: 0,
  };
  for (const entry of c) {
    if (entry.pruneSafe) s.pruneSafe++;
    if (entry.reasons.includes('missing-on-disk')) s.missingOnDisk++;
    if (entry.reasons.includes('upstream-gone')) s.upstreamGone++;
    if (entry.reasons.includes('stale-only')) s.staleOnly++;
    if (entry.protectedReason) s.protectedCount++;
  }
  return s;
}

/** One-line picker title. */
export function describeWorktreePrune(s: PruneSummary): string {
  const bits: string[] = [];
  bits.push(`${s.total} worktree${s.total === 1 ? '' : 's'}`);
  bits.push(`${s.pruneSafe} safe to remove`);
  if (s.missingOnDisk) bits.push(`${s.missingOnDisk} missing`);
  if (s.upstreamGone) bits.push(`${s.upstreamGone} upstream gone`);
  if (s.staleOnly) bits.push(`${s.staleOnly} stale`);
  return bits.join(' \u00b7 ');
}

/** Per-row detail string for the picker. */
export function formatRowDetail(c: WorktreePruneCandidate): string {
  const reasonLabels: Record<PruneReason, string> = {
    'missing-on-disk': 'missing on disk',
    'upstream-gone':   'upstream gone',
    'stale-only':      'stale',
  };
  const parts: string[] = [];
  if (!c.existsOnDisk) parts.push('missing on disk');
  else parts.push(`${c.ageDays}d old`);
  for (const r of c.reasons) {
    if (r === 'missing-on-disk') continue; // already represented
    parts.push(reasonLabels[r]);
  }
  if (c.protectedReason) parts.push(`${c.protectedReason}-protected`);
  if (c.worktree.branch) parts.push(`branch=${c.worktree.branch}`);
  return parts.join(' \u00b7 ');
}

/** Build the argv for the prune action against a single worktree. */
export function buildRemoveCommand(c: WorktreePruneCandidate): string[] {
  // Missing-on-disk entries can ONLY be reaped via `git worktree prune`
  // (the metadata stays even after rm -rf). The picker's batch handler
  // groups missing entries and runs prune once.
  if (!c.existsOnDisk) return ['worktree', 'prune'];
  // For existing entries: `git worktree remove --force <path>` is the
  // most reliable form (handles dirty worktrees too when the user picks
  // force). Without --force, dirty trees error out; the controller offers
  // force as an opt-in modal.
  return ['worktree', 'remove', c.worktree.path];
}
