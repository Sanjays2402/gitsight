/**
 * Pure helpers for branch-age classification, used by the Branches tree to
 * decorate stale branches.
 *
 * No vscode / no child_process — pure.
 */

import { Branch } from './git';

export type StaleStatus = 'fresh' | 'aging' | 'stale' | 'ancient';

export interface BranchAge {
  branch: Branch;
  status: StaleStatus;
  /** Whole days since the branch's last commit (Infinity when no lastDate). */
  ageDays: number;
}

export interface AgeThresholds {
  agingDays: number;    // anything past this is at least 'aging'
  staleDays: number;    // past this → 'stale'
  ancientDays: number;  // past this → 'ancient'
}

export const DEFAULT_THRESHOLDS: AgeThresholds = {
  agingDays: 30,
  staleDays: 90,
  ancientDays: 365,
};

export function classifyAge(date: Date | undefined, now: Date, t: AgeThresholds = DEFAULT_THRESHOLDS): BranchAge['status'] {
  if (!date) return 'ancient';
  const ms = now.getTime() - date.getTime();
  if (ms < 0) return 'fresh';
  const days = Math.floor(ms / 86_400_000);
  if (days >= t.ancientDays) return 'ancient';
  if (days >= t.staleDays) return 'stale';
  if (days >= t.agingDays) return 'aging';
  return 'fresh';
}

export function ageDays(date: Date | undefined, now: Date): number {
  if (!date) return Infinity;
  const ms = Math.max(0, now.getTime() - date.getTime());
  return Math.floor(ms / 86_400_000);
}

export function classifyBranches(
  branches: Branch[],
  now: Date,
  t: AgeThresholds = DEFAULT_THRESHOLDS,
): BranchAge[] {
  return branches.map(b => ({
    branch: b,
    status: classifyAge(b.lastDate, now, t),
    ageDays: ageDays(b.lastDate, now),
  }));
}

/** Short human label e.g. "stale · 124d" used as the tree-item description. */
export function ageLabel(a: BranchAge): string {
  if (a.status === 'fresh') return '';
  const days = a.ageDays === Infinity ? '?' : `${a.ageDays}d`;
  return `${a.status} · ${days}`;
}

/**
 * Choose a `vscode.ThemeIcon` color id for the badge (returned as a string so
 * the pure module stays vscode-free).
 */
export function colorIdFor(status: StaleStatus): string | undefined {
  switch (status) {
    case 'aging':   return 'charts.yellow';
    case 'stale':   return 'charts.orange';
    case 'ancient': return 'charts.red';
    case 'fresh':
    default:        return undefined;
  }
}
