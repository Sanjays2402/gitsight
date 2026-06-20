/**
 * Pure helpers for the Branch Cleanup feature: classify branches as safe to
 * delete versus risky, given the list of merged branch names and the current
 * branch.
 *
 * No vscode / no child_process — pure.
 */

import { Branch } from './git';

export interface CleanupCandidate {
  branch: Branch;
  /** True when the branch is fully merged into the comparison branch. */
  merged: boolean;
  /** Lower-cased reason if the branch is force-protected (current, upstream, etc.). */
  protectedReason?: string;
}

const PROTECTED_NAMES = new Set([
  'main', 'master', 'trunk', 'develop', 'dev', 'release', 'production', 'staging',
]);

export function isProtectedName(name: string): boolean {
  return PROTECTED_NAMES.has(name.toLowerCase());
}

/**
 * Build the cleanup picklist. Inputs:
 *   - allBranches: result of `git.branches(true)` (locals + remotes).
 *   - mergedNames: parsed branch names from `git branch --merged <base>`.
 *   - currentBranch: name of HEAD's branch (never offered).
 *
 * Output: only local, non-protected branches that aren't the current branch.
 * The merged flag is set so the UI can pre-tick or visually separate them.
 */
export function classifyCleanupCandidates(
  allBranches: Branch[],
  mergedNames: Set<string>,
  currentBranch: string,
): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  for (const b of allBranches) {
    if (b.remote) continue;
    if (b.name === currentBranch) continue;
    const protectedReason = isProtectedName(b.name) ? 'protected name' : undefined;
    out.push({
      branch: b,
      merged: mergedNames.has(b.name),
      protectedReason,
    });
  }
  // Order: merged & safe first, then merged & protected, then unmerged.
  out.sort((a, b) => {
    const aw = (a.merged ? 0 : 2) + (a.protectedReason ? 1 : 0);
    const bw = (b.merged ? 0 : 2) + (b.protectedReason ? 1 : 0);
    if (aw !== bw) return aw - bw;
    return a.branch.name.localeCompare(b.branch.name);
  });
  return out;
}

/** Parse the output of `git branch --merged <ref>` into a set of branch names. */
export function parseMergedBranches(out: string): Set<string> {
  const names = new Set<string>();
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    // Lines look like:  "  feature/foo" or "* main" — strip leading flag and spaces.
    const name = raw.replace(/^[*+\s]+/, '').trim();
    if (!name) continue;
    if (name.startsWith('(') && name.endsWith(')')) continue; // detached HEAD lines
    names.add(name);
  }
  return names;
}
