/**
 * Pure helpers for the Branch Staleness Pruner (F52).
 *
 * Extends the existing branchAge (F25) and branchCleanup (F9) helpers to
 * build a batched "delete branches that are BOTH (a) merged into <base>
 * AND (b) older than N days" picker.
 *
 * The classifier:
 *   - Honours the same PROTECTED_NAMES set as branchCleanup so trunk /
 *     main / etc. are never offered.
 *   - Skips remote-tracking branches (we never want to delete `origin/*`
 *     refs locally).
 *   - Skips the current branch (you can't delete the branch you're on).
 *   - Computes an explicit "deleteSafe" verdict: merged AND past the
 *     threshold AND not protected. The UI pre-ticks deleteSafe rows but
 *     still lets the user toggle individually.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/branchPruner.test.ts.
 */

import { Branch } from './git';
import { classifyAge, ageDays, StaleStatus, DEFAULT_THRESHOLDS } from './branchAge';

const PROTECTED_NAMES = new Set([
  'main', 'master', 'trunk', 'develop', 'dev', 'release', 'production', 'staging',
]);

export interface PruneOptions {
  /** Minimum age in days. Branches younger than this are NOT in the deleteSafe set. */
  minAgeDays: number;
  /** Branch names treated as merge baselines (`b is merged into base`). */
  mergedInto: Set<string>;
  /** Branch name of HEAD; never offered. */
  currentBranch: string;
  /** Extra names the user has marked as protected via config. */
  extraProtected?: string[];
  /** When true, also include unmerged branches past the threshold (default false). */
  includeUnmerged?: boolean;
}

export interface PruneCandidate {
  branch: Branch;
  ageDays: number;
  staleStatus: StaleStatus;
  merged: boolean;
  protectedReason?: 'name' | 'extra' | 'current' | 'remote';
  /** True when the branch is safe to delete in a default batch run. */
  deleteSafe: boolean;
}

export interface PruneSummary {
  total: number;
  deleteSafe: number;
  protectedCount: number;
  unmerged: number;
  /** Per-status bucket counts across the candidate list. */
  byStatus: Record<StaleStatus, number>;
}

/**
 * Build the pruner candidate list. The output is ordered:
 *   1. deleteSafe branches first, oldest at the top.
 *   2. then unmerged-but-stale rows.
 *   3. then protected/young rows (informational, shown but not pre-ticked).
 *
 * Branches whose name === currentBranch are dropped entirely (you can't
 * delete the branch you're on, no point cluttering the picker).
 */
export function buildPruneCandidates(
  allBranches: Branch[],
  options: PruneOptions,
  now: Date,
): PruneCandidate[] {
  const out: PruneCandidate[] = [];
  const extraSet = new Set((options.extraProtected ?? []).map(s => s.toLowerCase()));
  const mergedSet = options.mergedInto;
  for (const b of allBranches) {
    if (b.remote) continue;
    if (b.name === options.currentBranch) continue;
    const days = ageDays(b.lastDate, now);
    const staleStatus = classifyAge(b.lastDate, now, DEFAULT_THRESHOLDS);
    const merged = mergedSet.has(b.name);
    let protectedReason: PruneCandidate['protectedReason'] = undefined;
    if (PROTECTED_NAMES.has(b.name.toLowerCase())) protectedReason = 'name';
    else if (extraSet.has(b.name.toLowerCase())) protectedReason = 'extra';

    const meetsAge = days >= options.minAgeDays;
    const deleteSafe = meetsAge && (merged || !!options.includeUnmerged) && !protectedReason;

    out.push({
      branch: b,
      ageDays: days,
      staleStatus,
      merged,
      protectedReason,
      deleteSafe,
    });
  }
  // Ordering: deleteSafe (oldest first) → unmerged stale (oldest first) → rest.
  out.sort((a, b) => {
    const bucket = (c: PruneCandidate) => {
      if (c.deleteSafe) return 0;
      if (c.ageDays >= options.minAgeDays) return 1; // stale but not safe
      return 2;
    };
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays; // oldest first within bucket
    return a.branch.name.localeCompare(b.branch.name);
  });
  return out;
}

/** Summary of a candidate list for the picker header. */
export function summarisePrune(candidates: PruneCandidate[]): PruneSummary {
  const byStatus: Record<StaleStatus, number> = { fresh: 0, aging: 0, stale: 0, ancient: 0 };
  let deleteSafe = 0;
  let protectedCount = 0;
  let unmerged = 0;
  for (const c of candidates) {
    byStatus[c.staleStatus]++;
    if (c.deleteSafe) deleteSafe++;
    if (c.protectedReason) protectedCount++;
    if (!c.merged) unmerged++;
  }
  return { total: candidates.length, deleteSafe, protectedCount, unmerged, byStatus };
}

/**
 * One-line description for the picker title.
 *   "12 local branches · 4 safe to delete · 3 unmerged · 2 protected"
 */
export function describePrune(s: PruneSummary): string {
  const bits = [`${s.total} local branch${s.total === 1 ? '' : 'es'}`];
  bits.push(`${s.deleteSafe} safe to delete`);
  if (s.unmerged) bits.push(`${s.unmerged} unmerged`);
  if (s.protectedCount) bits.push(`${s.protectedCount} protected`);
  return bits.join(' · ');
}

/**
 * Format an age + status description for the row.
 *   "ancient · 423d"
 *   "stale · 124d (unmerged)"
 *   "aging · 31d (merged)"
 */
export function formatRowDetail(c: PruneCandidate): string {
  const ageBit = c.ageDays === Infinity ? '?' : `${c.ageDays}d`;
  const status = c.staleStatus === 'fresh' ? 'fresh' : c.staleStatus;
  const mergeBit = c.merged ? 'merged' : 'unmerged';
  const protBit = c.protectedReason ? ` · ${c.protectedReason}-protected` : '';
  return `${status} · ${ageBit} (${mergeBit})${protBit}`;
}

/**
 * Parse `git branch --merged <base>` output (same shape as the existing
 * branchCleanup parser, but kept here for self-containment).
 */
export function parseMergedBranches(out: string): Set<string> {
  const names = new Set<string>();
  for (const raw of (out ?? '').split('\n')) {
    if (!raw) continue;
    const name = raw.replace(/^[*+\s]+/, '').trim();
    if (!name) continue;
    if (name.startsWith('(') && name.endsWith(')')) continue;
    names.add(name);
  }
  return names;
}
