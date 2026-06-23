/**
 * Pure helpers for F120 - "What's stale?" repo dashboard.
 *
 * Composite of four existing per-feature classifiers:
 *
 *   - F25 branchAge (BranchAge[])           - aging/stale/ancient branches
 *   - F67 stashTrash (StashCandidate[])     - stash trash bin
 *   - F64 worktreePruner (WorktreePruneCandidate[]) - dead worktrees
 *   - F94 workspaceSecretAudit-ish counts   - missing-secret repos
 *
 * Each domain already produces a per-item verdict; this module turns
 * them into a single ranked "rot" list the UI can sort and display.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/whatsStale.test.ts.
 *
 * Why this composite instead of a meta-command opening four separate
 * pickers: stale-ness is correlated. When a worktree is dead, its
 * branch is usually stale, with a stash on it. Showing them on one
 * surface lets the user "clean up this whole sub-tree in two clicks"
 * vs running four separate cleanup passes.
 */

import { BranchAge, StaleStatus } from './branchAge';
import { StashCandidate } from './stashTrash';
import { WorktreePruneCandidate } from './worktreePruner';

export type RotKind = 'branch' | 'stash' | 'worktree' | 'secrets';

export type RotSeverity = 'critical' | 'major' | 'minor' | 'informational';

export interface RotItem {
  kind: RotKind;
  /** Stable display label (branch name, stash subject, worktree path). */
  label: string;
  /** Numeric rot score - higher = worse. Used for ordering. */
  score: number;
  severity: RotSeverity;
  /** Days old for items that age out (Infinity when unknown). */
  ageDays?: number;
  /** Short description shown in the picker's description column. */
  description: string;
  /** Optional sub-detail (e.g. branch name for a stash). */
  detail?: string;
  /** Codicon glyph (no emoji). */
  glyph: string;
  /** Free-form payload the UI passes back to the right cleanup command. */
  payload: Record<string, unknown>;
}

export interface WhatsStaleSummary {
  total: number;
  critical: number;
  major: number;
  minor: number;
  informational: number;
  byKind: Record<RotKind, number>;
}

/**
 * Score a branch from its classified age. Ancient branches dominate
 * the picker; younger ones drop off entirely (fresh branches aren't
 * rot).
 *
 *   ancient (>= 365d)   -> critical, score 300 + age
 *   stale  (>= 90d)     -> major,    score 100 + age
 *   aging  (>= 30d)     -> minor,    score 50  + age
 *   fresh               -> filtered out
 */
export function scoreBranch(b: BranchAge): RotItem | undefined {
  if (b.status === 'fresh') return undefined;
  const age = Number.isFinite(b.ageDays) ? b.ageDays : 9999;
  const sev: RotSeverity =
    b.status === 'ancient' ? 'critical' :
    b.status === 'stale'   ? 'major'    : 'minor';
  const base =
    b.status === 'ancient' ? 300 :
    b.status === 'stale'   ? 100 : 50;
  return {
    kind: 'branch',
    label: b.branch.name,
    score: base + Math.min(age, 9999),
    severity: sev,
    ageDays: age,
    description: `${b.status} branch - ${age}d since last commit`,
    detail: b.branch.upstream || undefined,
    glyph: 'git-branch',
    payload: { name: b.branch.name, remote: !!b.branch.remote },
  };
}

/**
 * Score a stash candidate. Drop-safe stashes dominate; review and fresh
 * sit below them.
 *
 *   dropSafe                  -> major,    score 150 + age
 *   sourceBranchGone (stale)  -> major,    score 130 + age
 *   stale-but-review           -> minor,    score 80  + age
 *   fresh                      -> filtered out (not rot yet)
 */
export function scoreStash(s: StashCandidate): RotItem | undefined {
  if (s.ageBucket === 'fresh' && !s.sourceBranchGone) return undefined;
  const age = Number.isFinite(s.ageDays) ? s.ageDays : 9999;
  const sev: RotSeverity =
    s.dropSafe ? 'major' :
    s.sourceBranchGone ? 'major' :
    s.ageBucket === 'stale' ? 'minor' : 'informational';
  const base =
    s.dropSafe ? 150 :
    s.sourceBranchGone ? 130 :
    s.ageBucket === 'stale' ? 80 : 40;
  return {
    kind: 'stash',
    label: s.cleanSubject || `stash@{${s.stash.index}}`,
    score: base + Math.min(age, 9999),
    severity: sev,
    ageDays: age,
    description: stashDescription(s, age),
    detail: s.sourceBranch ?? undefined,
    glyph: 'archive',
    payload: { index: s.stash.index, sourceBranch: s.sourceBranch, dropSafe: s.dropSafe },
  };
}

function stashDescription(s: StashCandidate, age: number): string {
  const parts: string[] = [];
  parts.push(`${s.ageBucket} stash - ${age}d`);
  if (s.sourceBranchGone) parts.push('source branch gone');
  if (s.dropSafe) parts.push('drop-safe');
  return parts.join(' - ');
}

/**
 * Score a worktree candidate. Missing-on-disk dominates; upstream-gone
 * second; stale-only third.
 *
 *   missing-on-disk           -> critical, score 220 + age
 *   upstream-gone             -> major,    score 140 + age
 *   stale-only                -> minor,    score 60  + age
 */
export function scoreWorktree(w: WorktreePruneCandidate): RotItem | undefined {
  if (w.reasons.length === 0) return undefined;
  const age = Number.isFinite(w.ageDays) ? w.ageDays : 9999;
  const sev: RotSeverity =
    w.reasons.includes('missing-on-disk') ? 'critical' :
    w.reasons.includes('upstream-gone')   ? 'major'    : 'minor';
  const base =
    w.reasons.includes('missing-on-disk') ? 220 :
    w.reasons.includes('upstream-gone')   ? 140 : 60;
  return {
    kind: 'worktree',
    label: w.worktree.path,
    score: base + Math.min(age, 9999),
    severity: sev,
    ageDays: age,
    description: worktreeDescription(w, age),
    detail: w.worktree.branch || w.worktree.head || undefined,
    glyph: w.reasons.includes('missing-on-disk') ? 'circle-slash' : 'versions',
    payload: { path: w.worktree.path, reasons: w.reasons.slice() },
  };
}

function worktreeDescription(w: WorktreePruneCandidate, age: number): string {
  const reasons = w.reasons.join(', ');
  return `${reasons} - ${age}d`;
}

/**
 * Synthesise a single "missing secrets" rot item from a count + sample
 * workflow filename. F94 returns per-repo missing-secret summaries; we
 * fold them into one item per repo so the picker doesn't get drowned in
 * one row per secret.
 */
export function scoreSecrets(args: {
  repoName: string;
  missingCount: number;
  workflowCount: number;
  sampleWorkflow?: string;
}): RotItem | undefined {
  if (args.missingCount <= 0) return undefined;
  const sev: RotSeverity =
    args.missingCount >= 5 ? 'critical' :
    args.missingCount >= 2 ? 'major'    : 'minor';
  const base = args.missingCount * 20 + 80;
  return {
    kind: 'secrets',
    label: `${args.missingCount} missing workflow secret${args.missingCount === 1 ? '' : 's'}`,
    score: base,
    severity: sev,
    description: `${args.workflowCount} workflow${args.workflowCount === 1 ? '' : 's'} reference missing secrets`,
    detail: args.sampleWorkflow,
    glyph: 'shield',
    payload: { repoName: args.repoName, missingCount: args.missingCount },
  };
}

/**
 * Compose a unified, ranked rot list. Sort: severity desc (critical
 * first), then score desc, then label asc for stable ordering.
 */
export function aggregateRot(items: Array<RotItem | undefined>): RotItem[] {
  const out = items.filter((x): x is RotItem => x !== undefined);
  const sevRank: Record<RotSeverity, number> = { critical: 4, major: 3, minor: 2, informational: 1 };
  out.sort((a, b) => {
    const sr = sevRank[b.severity] - sevRank[a.severity];
    if (sr !== 0) return sr;
    const sc = b.score - a.score;
    if (sc !== 0) return sc;
    return a.label.localeCompare(b.label);
  });
  return out;
}

export function summariseRot(items: RotItem[]): WhatsStaleSummary {
  const summary: WhatsStaleSummary = {
    total: items.length,
    critical: 0,
    major: 0,
    minor: 0,
    informational: 0,
    byKind: { branch: 0, stash: 0, worktree: 0, secrets: 0 },
  };
  for (const item of items) {
    summary[item.severity] += 1;
    summary.byKind[item.kind] += 1;
  }
  return summary;
}

/**
 * Format the header label for the picker / markdown.
 *
 *   "rot report - 1 critical, 4 major, 7 minor (12 items)"
 *   "no rot detected"
 */
export function formatRotHeader(s: WhatsStaleSummary): string {
  if (s.total === 0) return 'no rot detected';
  const parts: string[] = [];
  if (s.critical) parts.push(`${s.critical} critical`);
  if (s.major) parts.push(`${s.major} major`);
  if (s.minor) parts.push(`${s.minor} minor`);
  if (s.informational) parts.push(`${s.informational} informational`);
  return `rot report - ${parts.join(', ')} (${s.total} item${s.total === 1 ? '' : 's'})`;
}

/**
 * Codicon for a severity tier (for the leading row glyph).
 */
export function glyphForSeverity(sev: RotSeverity): string {
  switch (sev) {
    case 'critical': return 'error';
    case 'major':    return 'warning';
    case 'minor':    return 'info';
    case 'informational': return 'circle-outline';
  }
}

/**
 * Markdown report body for the "Open full report" action.
 */
export function buildRotReport(items: RotItem[], summary: WhatsStaleSummary): string {
  const lines: string[] = [];
  lines.push("# What's stale?");
  lines.push('');
  lines.push(`_${formatRotHeader(summary)}_`);
  lines.push('');
  if (items.length === 0) {
    lines.push('Nothing to clean up. Nice work.');
    return lines.join('\n');
  }
  lines.push('| Kind | Severity | Item | Description | Age |');
  lines.push('| --- | --- | --- | --- | ---:|');
  for (const item of items) {
    const age = item.ageDays === undefined || !Number.isFinite(item.ageDays) ? '-' : `${item.ageDays}d`;
    lines.push(
      `| ${item.kind} | ${item.severity} | \`${escapePipe(item.label)}\` | ${escapePipe(item.description)} | ${age} |`,
    );
  }
  return lines.join('\n');
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }
