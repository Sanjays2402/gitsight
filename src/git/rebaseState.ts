/**
 * Pure helpers for detecting an in-progress rebase and summarising its state.
 *
 * Git stores rebase state in one of two directories inside `.git/`:
 *
 *   - `rebase-merge/`  — when a `git rebase -i` or `git rebase --merge` is running.
 *   - `rebase-apply/`  — when a classic `git rebase` (or `git am`) is running.
 *
 * For both styles, three pieces of info are useful to surface to the user:
 *
 *   - the operation kind ('interactive' | 'merge' | 'apply')
 *   - progress (current step `msgnum` of total `end`)
 *   - the branch we were on at rebase start (`head-name` or `head`)
 *
 * Conflicted file lists come from `git status` and are handled by the controller;
 * this module is intentionally pure (no `child_process` / `fs`) so it stays
 * trivially unit-testable.
 */

export type RebaseKind = 'interactive' | 'merge' | 'apply';

export interface RebaseState {
  /** Which on-disk style is active. */
  kind: RebaseKind;
  /** 1-based current step. May be 0 before the first pick lands. */
  current: number;
  /** Total number of steps in the rebase. May be 0 when unknown. */
  total: number;
  /** Branch / ref the rebase started from, when known (e.g. 'feature/x'). */
  branch?: string;
  /** SHA of the commit currently being applied, when known. */
  currentSha?: string;
}

/**
 * Build a RebaseState from the raw files Git writes during a rebase.
 * Pass `undefined` for files that don't exist or weren't readable. Returns
 * `undefined` when no rebase appears to be active.
 *
 * @param contents Map of well-known rebase files → their text content. Use the
 *   filenames Git itself uses ('msgnum', 'end', 'head-name', 'head', 'stopped-sha',
 *   'next', 'last', 'interactive', 'apply-mailbox'). Only the ones present matter.
 */
export function parseRebaseState(contents: Record<string, string | undefined>): RebaseState | undefined {
  const hasMerge = 'msgnum' in contents || 'end' in contents || 'head-name' in contents || 'interactive' in contents;
  const hasApply = 'next' in contents || 'last' in contents || 'apply-mailbox' in contents;
  if (!hasMerge && !hasApply) return undefined;

  let kind: RebaseKind;
  let current = 0;
  let total = 0;
  if (hasMerge) {
    kind = contents['interactive'] !== undefined ? 'interactive' : 'merge';
    current = parseIntSafe(contents['msgnum']);
    total = parseIntSafe(contents['end']);
  } else {
    kind = 'apply';
    current = parseIntSafe(contents['next']);
    total = parseIntSafe(contents['last']);
  }

  const headName = (contents['head-name'] ?? '').trim();
  const branch = headName.replace(/^refs\/heads\//, '') || undefined;
  const currentSha = (contents['stopped-sha'] ?? '').trim() || undefined;

  return { kind, current, total, branch, currentSha };
}

function parseIntSafe(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Short status-bar label, e.g. 'rebase 3/7' or 'rebase 2/?'. */
export function shortRebaseLabel(s: RebaseState): string {
  const head = s.kind === 'interactive' ? 'rebase -i' : s.kind === 'apply' ? 'rebase' : 'rebase';
  if (s.total > 0) return `${head} ${s.current}/${s.total}`;
  return `${head} ${s.current || '?'}/?`;
}

/**
 * Parse the output of `git status --porcelain` to extract the list of files
 * currently in a conflicted state. Conflicts are two-char status codes where
 * at least one column is 'U', plus AA/DD per the git docs.
 */
export function parseConflictedFiles(porcelain: string): string[] {
  const out: string[] = [];
  for (const raw of porcelain.split('\n')) {
    if (raw.length < 3) continue;
    const x = raw[0];
    const y = raw[1];
    const both = x + y;
    const isConflict = x === 'U' || y === 'U' || both === 'AA' || both === 'DD';
    if (!isConflict) continue;
    // Drop the renamed-arrow form ("R  old -> new") just in case.
    const path = raw.slice(3).split(' -> ').pop()!.trim();
    if (path) out.push(path);
  }
  return out;
}

/** Compose a one-line description used in the pill tooltip / notification. */
export function describeRebase(s: RebaseState, conflicts: number): string {
  const onto = s.branch ? ` (was on ${s.branch})` : '';
  const steps = s.total > 0 ? `step ${s.current} of ${s.total}` : `step ${s.current || '?'}`;
  const conf = conflicts === 0
    ? 'no conflicts'
    : `${conflicts} conflicted ${conflicts === 1 ? 'file' : 'files'}`;
  return `${s.kind === 'interactive' ? 'Interactive rebase' : 'Rebase'} in progress, ${steps}, ${conf}${onto}.`;
}
