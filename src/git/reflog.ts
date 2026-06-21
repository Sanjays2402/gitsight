/**
 * Pure helpers for the Reflog Explorer (F68).
 *
 * `git reflog` is the underrated recovery surface — every reset, rebase,
 * cherry-pick, amend, and checkout leaves a trail with the pre-action
 * SHA, so undoing a "git reset --hard" is as simple as `git reset --hard
 * <reflog sha>`. The existing F32 Recent Branches picker only mines the
 * `checkout: moving from` subset; this module classifies the full reflog
 * so a single picker can surface everything you might want to undo.
 *
 * The reflog line format we parse:
 *
 *   <sha> HEAD@{<iso-date>}: <action-text>
 *
 * with `git reflog --date=iso-strict`. The action text is what we
 * classify — common shapes:
 *
 *   commit (initial): ...
 *   commit: <subject>
 *   commit (amend): <subject>
 *   reset: moving to HEAD~3
 *   rebase (start): checkout origin/main
 *   rebase (continue): ...
 *   rebase (finish): returning to refs/heads/main
 *   merge feature-x: Fast-forward
 *   cherry-pick: <subject>
 *   pull: Fast-forward
 *   checkout: moving from A to B
 *   pull --rebase: ...
 *
 * Pure — no vscode, no child_process. Tests in test/git/reflog.test.ts.
 */

export type ReflogActionKind =
  | 'commit'
  | 'amend'
  | 'reset'
  | 'rebase'
  | 'merge'
  | 'cherry-pick'
  | 'revert'
  | 'pull'
  | 'checkout'
  | 'clone'
  | 'other';

export interface ReflogEntry {
  /** Object id at this reflog step (where HEAD pointed *after* the action). */
  sha: string;
  /** ISO 8601 timestamp from `HEAD@{iso}`. */
  dateIso: string;
  /** Raw reflog action text (everything after `HEAD@{...}: `). */
  action: string;
  /** Classified kind for icon + filter. */
  kind: ReflogActionKind;
  /** Best-effort short description for the picker label. */
  summary: string;
  /** Index of the entry in the reflog (0 = most recent). */
  index: number;
}

const ACTION_PATTERNS: Array<{
  kind: ReflogActionKind;
  re: RegExp;
  summarise?: (m: RegExpMatchArray, action: string) => string;
}> = [
  // Amend is a special commit subtype; check first so "commit:" doesn't win.
  { kind: 'amend', re: /^commit \(amend\):\s*(.*)$/, summarise: m => m[1] || 'amended commit' },
  { kind: 'commit', re: /^commit(?: \(initial\))?:\s*(.*)$/, summarise: m => m[1] || 'commit' },
  { kind: 'reset', re: /^reset:\s+(?:moving to\s+)?(.*)$/, summarise: m => `reset to ${m[1]}` },
  // Rebase has several "subkinds" — classify them all as rebase but use
  // the parenthesized hint in the summary so the user can tell start /
  // finish apart.
  { kind: 'rebase', re: /^rebase(?:\s+-i)?\s*\(([^)]+)\):?\s*(.*)$/, summarise: m => `rebase (${m[1]})${m[2] ? ' \u2014 ' + m[2] : ''}` },
  { kind: 'rebase', re: /^rebase(?:\s+-i)?(?:\s+\([^)]+\))?:?\s*(.*)$/, summarise: m => `rebase${m[1] ? ' \u2014 ' + m[1] : ''}` },
  { kind: 'merge', re: /^merge\s+([^:]+):\s*(.*)$/, summarise: m => `merge ${m[1]}${m[2] ? ' \u2014 ' + m[2] : ''}` },
  { kind: 'cherry-pick', re: /^cherry-pick:\s*(.*)$/, summarise: m => `cherry-pick ${m[1]}` },
  { kind: 'revert', re: /^revert:\s*(.*)$/, summarise: m => `revert ${m[1]}` },
  { kind: 'pull', re: /^pull(?:\s+--rebase)?(?:\s+[^:]+)?:\s*(.*)$/, summarise: m => `pull \u2014 ${m[1]}` },
  { kind: 'checkout', re: /^checkout:\s+moving from\s+(\S+)\s+to\s+(\S+)/, summarise: m => `checkout ${m[1]} \u2192 ${m[2]}` },
  { kind: 'clone', re: /^clone:\s*(.*)$/, summarise: m => `clone ${m[1]}` },
];

const REFLOG_LINE_RE = /^([0-9a-f]+)\s+HEAD@\{([^}]+)\}:\s*(.*)$/;

/**
 * Parse `git reflog --date=iso-strict -n <N>` stdout into structured
 * entries with classification.
 */
export function parseReflog(raw: string): ReflogEntry[] {
  const out: ReflogEntry[] = [];
  let i = 0;
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const m = REFLOG_LINE_RE.exec(line);
    if (!m) continue;
    const [, sha, dateIso, action] = m;
    const { kind, summary } = classifyAction(action);
    out.push({ sha, dateIso, action, kind, summary, index: i++ });
  }
  return out;
}

function classifyAction(action: string): { kind: ReflogActionKind; summary: string } {
  for (const p of ACTION_PATTERNS) {
    const m = action.match(p.re);
    if (!m) continue;
    const summary = p.summarise ? p.summarise(m, action) : action;
    return { kind: p.kind, summary };
  }
  return { kind: 'other', summary: action };
}

/**
 * Filter entries by kinds. Empty `kinds` set is treated as "all".
 */
export function filterReflog(entries: ReflogEntry[], kinds: Set<ReflogActionKind>): ReflogEntry[] {
  if (kinds.size === 0) return entries;
  return entries.filter(e => kinds.has(e.kind));
}

export interface ReflogSummary {
  total: number;
  byKind: Record<ReflogActionKind, number>;
}

export function summariseReflog(entries: ReflogEntry[]): ReflogSummary {
  const byKind = {
    commit: 0, amend: 0, reset: 0, rebase: 0, merge: 0,
    'cherry-pick': 0, revert: 0, pull: 0, checkout: 0, clone: 0, other: 0,
  } as Record<ReflogActionKind, number>;
  for (const e of entries) byKind[e.kind]++;
  return { total: entries.length, byKind };
}

/**
 * Glyph (no-emoji codicon name) for each reflog kind. The view passes
 * this to `$(...)` in the picker label.
 */
export function glyphForKind(kind: ReflogActionKind): string {
  switch (kind) {
    case 'commit':       return 'git-commit';
    case 'amend':        return 'edit';
    case 'reset':        return 'discard';
    case 'rebase':       return 'list-tree';
    case 'merge':        return 'git-merge';
    case 'cherry-pick':  return 'gift';
    case 'revert':       return 'history';
    case 'pull':         return 'arrow-down';
    case 'checkout':     return 'arrow-swap';
    case 'clone':        return 'cloud-download';
    case 'other':        return 'circle-small';
  }
}

/**
 * Whether the kind represents a HEAD move that's potentially destructive
 * (resets, rebases, merges, pulls). Used by the view to highlight rows
 * the user is more likely to want to undo.
 */
export function isHeadMove(kind: ReflogActionKind): boolean {
  return kind === 'reset' || kind === 'rebase' || kind === 'merge' || kind === 'pull';
}

/**
 * The set of kinds the picker exposes as filter chips. The order is
 * relevance-driven: undo-friendly kinds first, informational ones later.
 */
export const FILTER_KIND_ORDER: ReflogActionKind[] = [
  'reset', 'rebase', 'merge', 'amend', 'cherry-pick', 'revert',
  'commit', 'pull', 'checkout', 'clone', 'other',
];
