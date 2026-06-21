/**
 * Pure helpers for the WIP Commit Hunter (F37).
 *
 * Classifies commit subjects into the well-known "this should not survive
 * to main" buckets — `WIP`, `fixup!`, `squash!`, `amend!`, plus catch-alls
 * like `tmp:` / `temp:` / `do not merge`. The hunter UI feeds these to an
 * `git rebase --autosquash -i <upstream>` call so the user can clean up in
 * one click; the classification is shared between the picker (so the user
 * sees what was found) and the action (so we only autosquash when there's
 * something autosquash can actually do).
 *
 * Pure — no vscode, no child_process. Tests in test/git/wipCommits.test.ts.
 */

export type WipKind =
  | 'wip'        // ^WIP, ^WIP:, ^wip
  | 'fixup'      // ^fixup!
  | 'squash'     // ^squash!
  | 'amend'      // ^amend!
  | 'tmp'        // ^tmp:, ^temp:, ^TODO:, ^todo:
  | 'do-not-merge'; // matches 'do not merge' / 'DO NOT MERGE' / 'dnm'

export interface WipCommit {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
  kind: WipKind;
  /**
   * For fixup!/squash! commits, the rest of the subject after the prefix —
   * this is what `git rebase --autosquash` matches against an earlier commit's
   * subject. Undefined for non-autosquash kinds.
   */
  autosquashTarget?: string;
}

/**
 * Classify a commit subject into a WipKind, or undefined when it looks like a
 * normal commit. We're deliberately conservative: only well-known prefixes
 * and exact phrases. False positives here mean the user sees commits they
 * didn't expect in the picker, which is more annoying than missing a few
 * sloppy subjects.
 */
export function classifySubject(subject: string): { kind: WipKind; autosquashTarget?: string } | undefined {
  const trimmed = (subject ?? '').trim();
  if (!trimmed) return undefined;

  // Autosquash markers — case-sensitive, matches the format git itself writes.
  let m = /^fixup!\s+(.*)$/.exec(trimmed);
  if (m) return { kind: 'fixup', autosquashTarget: m[1].trim() };
  m = /^squash!\s+(.*)$/.exec(trimmed);
  if (m) return { kind: 'squash', autosquashTarget: m[1].trim() };
  m = /^amend!\s+(.*)$/.exec(trimmed);
  if (m) return { kind: 'amend', autosquashTarget: m[1].trim() };

  // WIP — case-insensitive, accepts `WIP`, `WIP:`, `WIP -`, `WIP foo`.
  if (/^wip\b/i.test(trimmed)) return { kind: 'wip' };

  // "do not merge" sentinels.
  if (/^do\s*not\s*merge\b/i.test(trimmed)) return { kind: 'do-not-merge' };
  if (/^dnm\b/i.test(trimmed)) return { kind: 'do-not-merge' };

  // "tmp:" / "temp:" / "TODO:" — short-lived markers people add and forget.
  if (/^(tmp|temp|todo)\s*[:\s]/i.test(trimmed)) return { kind: 'tmp' };

  return undefined;
}

/**
 * Parse stdout from:
 *
 *   git log --pretty=format:'%H|%h|%an|%aI|%s' <range>
 *
 * The subject can itself contain `|`, so everything after the fourth
 * separator is joined back together.
 */
export function parseLog(raw: string): { sha: string; shortSha: string; author: string; dateIso: string; subject: string }[] {
  const out: { sha: string; shortSha: string; author: string; dateIso: string; subject: string }[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [sha, shortSha, author, dateIso, ...rest] = parts;
    out.push({ sha, shortSha, author, dateIso, subject: rest.join('|') });
  }
  return out;
}

/**
 * Filter a list of raw commits to only the WIP-shaped ones, preserving
 * the original order (newest first, matching git log's default).
 */
export function findWipCommits(
  commits: { sha: string; shortSha: string; author: string; dateIso: string; subject: string }[],
): WipCommit[] {
  const out: WipCommit[] = [];
  for (const c of commits) {
    const verdict = classifySubject(c.subject);
    if (!verdict) continue;
    out.push({ ...c, kind: verdict.kind, autosquashTarget: verdict.autosquashTarget });
  }
  return out;
}

export interface WipSummary {
  total: number;
  byKind: Record<WipKind, number>;
  /** True if any commits are fixup!/squash!/amend! — i.e. autosquash will do work. */
  hasAutosquashable: boolean;
}

const KIND_ORDER: WipKind[] = ['wip', 'fixup', 'squash', 'amend', 'tmp', 'do-not-merge'];

export function summariseWip(commits: WipCommit[]): WipSummary {
  const byKind: Record<WipKind, number> = {
    'wip': 0, 'fixup': 0, 'squash': 0, 'amend': 0, 'tmp': 0, 'do-not-merge': 0,
  };
  for (const c of commits) byKind[c.kind]++;
  return {
    total: commits.length,
    byKind,
    hasAutosquashable: byKind.fixup + byKind.squash + byKind.amend > 0,
  };
}

/**
 * Render a one-line summary used by status messages.
 *
 *   "3 WIP, 2 fixup!"
 *   "1 fixup!, 1 squash!, 1 amend!"
 */
export function describeWip(s: WipSummary): string {
  if (s.total === 0) return 'No WIP commits';
  const bits: string[] = [];
  for (const k of KIND_ORDER) {
    const n = s.byKind[k];
    if (!n) continue;
    bits.push(`${n} ${labelFor(k)}`);
  }
  return bits.join(', ');
}

function labelFor(k: WipKind): string {
  switch (k) {
    case 'wip':          return 'WIP';
    case 'fixup':        return 'fixup!';
    case 'squash':       return 'squash!';
    case 'amend':        return 'amend!';
    case 'tmp':          return 'tmp/temp';
    case 'do-not-merge': return 'do-not-merge';
  }
}

/**
 * Build the human label used by the QuickPick row.
 *   "fixup! refactor parser"  →  "[fixup!] refactor parser"
 *   "WIP scratch"             →  "[WIP] WIP scratch"
 */
export function pickerLabel(c: WipCommit): string {
  return `[${labelFor(c.kind)}] ${c.subject}`;
}
