/**
 * Pure helpers for F119 - Branch Protection Overview.
 *
 * Companion to F71 force-push guard which probes one branch. This one
 * gives a multi-branch overview: for every local branch the repo has,
 * surface the GitHub branch-protection state in a sortable picker so
 * the user can see at-a-glance "what's protected and how" without
 * clicking through six settings pages.
 *
 * Input to this pure module is a list of `BranchProtectionProbe`
 * objects (the result of running `gh api repos/.../branches/<n>/
 * protection` for each branch) plus the local branch list. Output is
 * a ranked, classified `BranchProtectionRow` list ready for the
 * picker.
 *
 * Classification levels:
 *   - locked       = protected AND force-push disallowed AND PR review
 *                    required (or branch lock_branch enabled)
 *   - reviewed     = protected AND PR review required (force allowed
 *                    or no force info) - typical default-branch shape
 *   - guarded      = protected with at least one rule but neither lock
 *                    nor review (e.g. status checks only)
 *   - unprotected  = no protection on this branch
 *   - unknown      = probe failed for a non-404 reason (auth, network)
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/branchProtectionOverview.test.ts.
 */

import { ProtectionDecision, classifyProtection } from './forcePushGuard';

export type ProtectionLevel = 'locked' | 'reviewed' | 'guarded' | 'unprotected' | 'unknown';

export interface BranchProtectionProbe {
  /** Local branch name (e.g. 'main'). */
  branch: string;
  /** stdout from `gh api ...branches/<n>/protection` (may be empty). */
  body: string;
  /** stderr from the same call. */
  stderr: string;
  /** Exit code (0 = ok). */
  exitCode: number;
}

export interface BranchProtectionRow {
  branch: string;
  decision: ProtectionDecision;
  level: ProtectionLevel;
  /** Short, scannable summary text (e.g. "locked - 4 rules"). */
  summary: string;
  /** Codicon glyph for the picker - no emoji. */
  glyph: string;
  /** True when this branch is the current HEAD. */
  isCurrent: boolean;
  /** True when this branch is the repo's default branch (e.g. 'main'). */
  isDefault: boolean;
}

export interface ProtectionOverview {
  rows: BranchProtectionRow[];
  /** Convenience counts by level for the header summary. */
  byLevel: Record<ProtectionLevel, number>;
  /** Default branch name when known (drives the surface order). */
  defaultBranch?: string;
  /** Skipped branches (remote, detached HEAD, etc.). */
  skipped: number;
}

/**
 * Classify the level given a ProtectionDecision. Pure derivative of
 * classifyProtection's output - splits "protected" further along
 * locked / reviewed / guarded axes so the picker can sort cleanly.
 */
export function classifyLevel(decision: ProtectionDecision): ProtectionLevel {
  if (decision.kind === 'unknown') return 'unknown';
  if (decision.kind === 'unprotected') return 'unprotected';
  // protected
  const ruleIds = new Set(decision.rules.filter(r => r.enabled).map(r => r.id));
  const lockOn = ruleIds.has('lock-branch');
  const reviewOn = ruleIds.has('required-reviews');
  const forceOff = !decision.allowsForcePush;
  // locked = strong protection (force off AND review required) OR explicit lock
  if (lockOn) return 'locked';
  if (reviewOn && forceOff) return 'locked';
  if (reviewOn) return 'reviewed';
  // protected without review = guarded (status checks, signatures, etc.)
  return 'guarded';
}

/**
 * Glyph map for the level (codicon ids, NOT emoji).
 *
 *   locked      lock
 *   reviewed    verified
 *   guarded     shield
 *   unprotected unlock
 *   unknown     question
 */
export function glyphForLevel(level: ProtectionLevel): string {
  switch (level) {
    case 'locked': return 'lock';
    case 'reviewed': return 'verified';
    case 'guarded': return 'shield';
    case 'unprotected': return 'unlock';
    case 'unknown': return 'question';
  }
}

/**
 * Short one-line summary used as the picker row description.
 *
 *   "locked - 4 rules"
 *   "reviewed - force allowed"
 *   "guarded - status checks only"
 *   "unprotected"
 *   "unknown - gh CLI is not authenticated"
 */
export function describeRow(row: { decision: ProtectionDecision; level: ProtectionLevel }): string {
  const { decision, level } = row;
  if (decision.kind === 'unknown') {
    return `unknown - ${decision.reason}`;
  }
  if (decision.kind === 'unprotected') return 'unprotected';
  // protected
  const ruleCount = decision.rules.filter(r => r.enabled).length;
  if (level === 'locked') return `locked - ${ruleCount} rule${ruleCount === 1 ? '' : 's'}`;
  if (level === 'reviewed') return `reviewed - ${decision.allowsForcePush ? 'force allowed' : 'force disallowed'}`;
  // guarded
  const names = decision.rules.filter(r => r.enabled).map(r => labelShort(r.id));
  if (names.length === 0) return 'guarded';
  return `guarded - ${names.join(', ')}`;
}

function labelShort(id: string): string {
  switch (id) {
    case 'required-status-checks': return 'status checks';
    case 'required-signatures': return 'signatures';
    case 'required-linear-history': return 'linear';
    case 'enforce-admins': return 'admins included';
    case 'deletions': return 'deletions allowed';
    case 'force-push': return 'force allowed';
    case 'lock-branch': return 'locked';
    case 'required-reviews': return 'reviews';
    default: return id;
  }
}

/** Numeric rank for sorting - higher = more notable. */
function levelRank(level: ProtectionLevel): number {
  switch (level) {
    case 'locked': return 4;
    case 'reviewed': return 3;
    case 'guarded': return 2;
    case 'unprotected': return 1;
    case 'unknown': return 0;
  }
}

/**
 * Compose the overview from probe results + a few branch-set hints.
 *
 * Sort order:
 *   1. default branch first (if present)
 *   2. current branch second (if not the default)
 *   3. then by levelRank descending (locked first), unknown last
 *   4. inside a level, alphabetical
 */
export function buildOverview(args: {
  probes: BranchProtectionProbe[];
  currentBranch?: string;
  defaultBranch?: string;
}): ProtectionOverview {
  const rows: BranchProtectionRow[] = [];
  const byLevel: Record<ProtectionLevel, number> = {
    locked: 0, reviewed: 0, guarded: 0, unprotected: 0, unknown: 0,
  };
  let skipped = 0;

  for (const p of args.probes) {
    if (!p.branch) { skipped++; continue; }
    const decision = classifyProtection(p.body, p.stderr, p.exitCode);
    const level = classifyLevel(decision);
    const row: BranchProtectionRow = {
      branch: p.branch,
      decision,
      level,
      summary: describeRow({ decision, level }),
      glyph: glyphForLevel(level),
      isCurrent: !!args.currentBranch && args.currentBranch === p.branch,
      isDefault: !!args.defaultBranch && args.defaultBranch === p.branch,
    };
    rows.push(row);
    byLevel[level] += 1;
  }

  rows.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const lr = levelRank(b.level) - levelRank(a.level);
    if (lr !== 0) return lr;
    return a.branch.localeCompare(b.branch);
  });

  return { rows, byLevel, defaultBranch: args.defaultBranch, skipped };
}

/**
 * Format the picker header summary - rendered as a separator label.
 *
 *   "branch protection - 1 locked, 2 reviewed, 5 unprotected (8 branches)"
 *   "no branches"
 */
export function formatOverviewHeader(o: ProtectionOverview): string {
  const total = o.byLevel.locked + o.byLevel.reviewed + o.byLevel.guarded
              + o.byLevel.unprotected + o.byLevel.unknown;
  if (total === 0) return 'no branches';
  const parts: string[] = [];
  if (o.byLevel.locked) parts.push(`${o.byLevel.locked} locked`);
  if (o.byLevel.reviewed) parts.push(`${o.byLevel.reviewed} reviewed`);
  if (o.byLevel.guarded) parts.push(`${o.byLevel.guarded} guarded`);
  if (o.byLevel.unprotected) parts.push(`${o.byLevel.unprotected} unprotected`);
  if (o.byLevel.unknown) parts.push(`${o.byLevel.unknown} unknown`);
  return `branch protection - ${parts.join(', ')} (${total} branch${total === 1 ? '' : 'es'})`;
}

/**
 * Build a markdown report body for the "Open report" action.
 *
 * Sections:
 *   # Branch Protection Overview
 *   _summary line_
 *   | Branch | Level | Summary | Rules |
 *
 * Rules are joined comma-separated, with `*` annotation on the current
 * branch and `(default)` on the default branch.
 */
export function buildOverviewReport(o: ProtectionOverview): string {
  const lines: string[] = [];
  lines.push('# Branch Protection Overview');
  lines.push('');
  lines.push(`_${formatOverviewHeader(o)}_`);
  lines.push('');
  lines.push('| Branch | Level | Summary | Rules |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of o.rows) {
    const name = `\`${escapePipe(r.branch)}\``
      + (r.isCurrent ? ' (current)' : '')
      + (r.isDefault ? ' (default)' : '');
    const rules = r.decision.kind === 'protected'
      ? r.decision.rules.filter(x => x.enabled).map(x => x.label).join('; ')
      : '-';
    lines.push(`| ${name} | ${r.level} | ${escapePipe(r.summary)} | ${escapePipe(rules) || '-'} |`);
  }
  return lines.join('\n');
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }

/**
 * Heuristic limit on how many branches to probe per invocation. GitHub
 * branch-protection requires admin scope and one round-trip per branch;
 * we cap at 20 by default and surface the rest as a "scan-more" action.
 */
export const DEFAULT_PROBE_LIMIT = 20;

/**
 * Pick the branches to probe given a full local-branch list and a
 * limit. Order:
 *   1. default branch
 *   2. current branch (if not default)
 *   3. branches with `protected: true` in their metadata (from `gh api
 *      repos/.../branches`)
 *   4. recent branches by lastDate
 * Caller passes already-sorted candidates; this fn just dedups + caps.
 */
export function selectBranchesToProbe(
  candidates: string[],
  args: { currentBranch?: string; defaultBranch?: string; limit?: number },
): string[] {
  const limit = Math.max(1, args.limit ?? DEFAULT_PROBE_LIMIT);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (b?: string) => {
    if (!b) return;
    if (seen.has(b)) return;
    seen.add(b);
    out.push(b);
  };
  push(args.defaultBranch);
  push(args.currentBranch);
  for (const c of candidates) {
    if (out.length >= limit) break;
    push(c);
  }
  return out.slice(0, limit);
}
