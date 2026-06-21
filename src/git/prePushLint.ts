/**
 * Pure helpers for the Pre-Push Lint Hook bridge (F14).
 *
 * When the user pushes, we want to catch the embarrassing case: a `WIP`,
 * `fixup!`, or `do-not-merge` commit hiding in the to-push range. We also
 * want to flag commits that contain conflict markers in their patch body,
 * which is the classic "I ran git rebase --continue too eagerly" bug.
 *
 * This module does the classification — given a list of commits and
 * (optionally) their patch text, it returns a list of `PrePushFinding`s
 * grouped by severity so the controller can render a picker:
 *
 *   ERROR    conflict-marker  — patch contains unresolved <<<<<<<
 *   WARN     wip-commit       — subject matches WIP / fixup! / squash! / amend! / etc.
 *   WARN     missing-issue    — subject lacks a configured issue prefix (optional)
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/prePushLint.test.ts.
 */

import { classifySubject, WipKind } from './wipCommits';
import { findConflicts } from './conflictMarkers';

export type PrePushSeverity = 'error' | 'warn';

export type PrePushKind =
  | 'wip-commit'
  | 'conflict-marker'
  | 'missing-issue';

export interface PrePushFinding {
  sha: string;
  shortSha: string;
  subject: string;
  kind: PrePushKind;
  severity: PrePushSeverity;
  /** Free-form details, e.g. "fixup! header" or "1 unresolved <<<<<<< block in src/foo.ts". */
  detail: string;
}

export interface PrePushCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /**
   * Optional patch body (`git show <sha>` output). If supplied we scan it
   * for unresolved conflict markers. If absent, the conflict-marker check
   * is skipped for that commit.
   */
  patch?: string;
}

export interface PrePushLintOptions {
  /**
   * Optional regex string the subject must match (e.g. issue tracker prefix
   * like ^(GH-|ABC-)\\d+). Commits without a match produce a `missing-issue`
   * warning. Undefined = check disabled.
   */
  requireSubjectMatching?: string;
  /** Override which WipKinds count as findings. Defaults to all. */
  wipKinds?: WipKind[];
}

const DEFAULT_WIP_KINDS: WipKind[] = ['wip', 'fixup', 'squash', 'amend', 'tmp', 'do-not-merge'];

/**
 * Walk a list of commits, returning every finding (one commit can produce
 * multiple — a WIP commit with a conflict marker yields two). Output is
 * in commit order, with errors before warnings within each commit.
 */
export function lintPrePush(
  commits: PrePushCommit[],
  options: PrePushLintOptions = {},
): PrePushFinding[] {
  const wipKinds = options.wipKinds ?? DEFAULT_WIP_KINDS;
  const wipSet = new Set(wipKinds);
  const subjectRe = compileSubjectRe(options.requireSubjectMatching);

  const findings: PrePushFinding[] = [];
  for (const c of commits) {
    const local: PrePushFinding[] = [];

    // 1. Conflict markers in the patch body — hard error.
    if (c.patch && hasConflictMarkers(c.patch)) {
      const blocks = findConflicts(stripPatchPrefixes(c.patch));
      local.push({
        sha: c.sha,
        shortSha: c.shortSha,
        subject: c.subject,
        kind: 'conflict-marker',
        severity: 'error',
        detail: `${blocks.length} unresolved conflict block${blocks.length === 1 ? '' : 's'} in commit body`,
      });
    }

    // 2. WIP subjects — warning.
    const verdict = classifySubject(c.subject);
    if (verdict && wipSet.has(verdict.kind)) {
      local.push({
        sha: c.sha,
        shortSha: c.shortSha,
        subject: c.subject,
        kind: 'wip-commit',
        severity: 'warn',
        detail: labelForKind(verdict.kind),
      });
    }

    // 3. Missing issue prefix — warning.
    if (subjectRe && !subjectRe.test(c.subject)) {
      local.push({
        sha: c.sha,
        shortSha: c.shortSha,
        subject: c.subject,
        kind: 'missing-issue',
        severity: 'warn',
        detail: `subject does not match /${subjectRe.source}/`,
      });
    }

    // Sort within the commit: error first, then warn.
    local.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    findings.push(...local);
  }
  return findings;
}

/** True when the patch text contains a real, well-formed conflict block. */
export function hasConflictMarkers(patch: string): boolean {
  if (!patch) return false;
  // Cheap pre-filter — no `<<<<<<<` substring means we never call the parser.
  // `git show` output contains the source diff, so a true conflict marker
  // surfaces as a `+<<<<<<<` line. We strip the leading +/-/' ' before
  // running the structural parser so it sees the actual file content.
  if (!/(^|\n)[+ -]?<{7}\s/.test(patch)) return false;
  return findConflicts(stripPatchPrefixes(patch)).length > 0;
}

/**
 * Strip the leading `+` / `-` / ` ` byte that `git show` adds to every
 * patch body line. Lines that don't start with one of those (hunk headers,
 * `diff --git`, commit message rows above the first hunk) are left alone.
 */
export function stripPatchPrefixes(patch: string): string {
  return (patch ?? '')
    .split('\n')
    .map(l => (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')) ? l.slice(1) : l)
    .join('\n');
}

/** Bucket findings by severity for one-glance summary. */
export interface PrePushSummary {
  total: number;
  errors: number;
  warnings: number;
  byKind: Record<PrePushKind, number>;
  /** True if anything is severity=error. The push should require confirmation. */
  blocking: boolean;
}

export function summarisePrePush(findings: PrePushFinding[]): PrePushSummary {
  const byKind: Record<PrePushKind, number> = {
    'wip-commit': 0,
    'conflict-marker': 0,
    'missing-issue': 0,
  };
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    byKind[f.kind]++;
    if (f.severity === 'error') errors++;
    else warnings++;
  }
  return {
    total: findings.length,
    errors,
    warnings,
    byKind,
    blocking: errors > 0,
  };
}

/** Compact one-line description ("3 WIP, 1 conflict marker"). */
export function describePrePush(s: PrePushSummary): string {
  if (s.total === 0) return 'clean — nothing to flag';
  const bits: string[] = [];
  if (s.byKind['conflict-marker']) bits.push(`${s.byKind['conflict-marker']} conflict marker${s.byKind['conflict-marker'] === 1 ? '' : 's'}`);
  if (s.byKind['wip-commit']) bits.push(`${s.byKind['wip-commit']} WIP/fixup`);
  if (s.byKind['missing-issue']) bits.push(`${s.byKind['missing-issue']} missing issue ref`);
  return bits.join(', ');
}

function severityRank(s: PrePushSeverity): number {
  return s === 'error' ? 0 : 1;
}

function labelForKind(k: WipKind): string {
  switch (k) {
    case 'wip':          return 'WIP';
    case 'fixup':        return 'fixup!';
    case 'squash':       return 'squash!';
    case 'amend':        return 'amend!';
    case 'tmp':          return 'tmp/temp';
    case 'do-not-merge': return 'do-not-merge';
  }
}

function compileSubjectRe(src: string | undefined): RegExp | undefined {
  if (!src) return undefined;
  try { return new RegExp(src); } catch { return undefined; }
}

/**
 * Parse `git log --pretty=format:'%H|%h|%s' <range>` output into commits.
 * Patch bodies are not in this output; the controller pairs them up by
 * shelling out to `git show <sha>` only for commits the WIP-subject check
 * didn't already flag (cheap optimisation — if it's WIP we know it's
 * dirty; we don't need to scan the patch).
 */
export function parsePrePushLog(raw: string): PrePushCommit[] {
  const out: PrePushCommit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [sha, shortSha, ...rest] = parts;
    out.push({ sha, shortSha, subject: rest.join('|') });
  }
  return out;
}
