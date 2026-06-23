/**
 * Pure helpers for F121 - merge queue enqueue/dequeue commands.
 *
 * Sister to F115 which surfaces the current state of the queue. This
 * module owns the validation + command-construction logic for the
 * two actions:
 *
 *   - `gh pr merge --auto --merge --queue` to enqueue a PR (or pick
 *     between merge/squash/rebase strategies).
 *   - `gh pr merge --disable-auto` to remove from queue / cancel auto.
 *
 * Validation rules enforced here (pure, testable):
 *
 *   - PR must exist + be in MERGEABLE state (or AWAITING_CHECKS at
 *     minimum; UNKNOWN tolerated with a warning verdict).
 *   - PR base must be the repo's default branch OR a branch that has
 *     merge queue enabled. The caller probes this; we just consume
 *     a `baseBranchSupportsQueue` boolean.
 *   - Strategy must be one of {merge, squash, rebase}; default is
 *     'merge' (matches GitHub's default).
 *   - Same-repo guard: we never enqueue a PR whose `headRepository`
 *     differs from `baseRepository` (different rules apply for
 *     cross-repo PRs).
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/mergeQueueActions.test.ts.
 */

export type MergeStrategy = 'merge' | 'squash' | 'rebase';

export type EnqueueAction = 'enqueue' | 'dequeue';

export type EnqueueVerdict =
  | { kind: 'ok'; warnings: string[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'noop'; reason: string };

export interface PrSnapshot {
  number: number;
  /** Title (used in confirmation copy). */
  title?: string;
  /** Base branch the PR targets. */
  baseRefName?: string;
  /** Repo slug for headRepository (cross-repo guard). */
  headRepoSlug?: string;
  /** Repo slug for baseRepository. */
  baseRepoSlug?: string;
  /** GitHub merge state status (CLEAN / BLOCKED / UNKNOWN / DIRTY / HAS_HOOKS / etc.). */
  mergeStateStatus?: string;
  /**
   * True when the PR already has a queue entry. F115's
   * parseMergeQueueEntry yields the state; we just need a bool here
   * because we're deciding "should we even try to enqueue?"
   */
  alreadyQueued?: boolean;
  /** True when auto-merge is already enabled. */
  autoMergeEnabled?: boolean;
  /**
   * Whether the base branch has merge queue rules enabled. The view
   * layer is responsible for probing this (gh api repos/.../rulesets
   * or default-branch heuristic).
   */
  baseBranchSupportsQueue?: boolean;
  /** True for draft PRs (can't be queued). */
  isDraft?: boolean;
}

export interface EnqueueArgs {
  pr: PrSnapshot;
  strategy: MergeStrategy;
}

/**
 * Decide whether `gh pr merge --queue` is safe to run for this PR.
 *
 * Returns 'blocked' when running the command would either fail or
 * have an undesired side-effect. Returns 'noop' when already enqueued
 * (no need to call gh again). Returns 'ok' with optional warnings.
 */
export function classifyEnqueue(args: EnqueueArgs): EnqueueVerdict {
  const { pr } = args;
  if (pr.isDraft) return { kind: 'blocked', reason: `PR #${pr.number} is a draft - mark ready for review first.` };
  if (pr.baseRepoSlug && pr.headRepoSlug && pr.baseRepoSlug !== pr.headRepoSlug) {
    return { kind: 'blocked', reason: `PR #${pr.number} is cross-repo (${pr.headRepoSlug} -> ${pr.baseRepoSlug}); enqueue from the source repo.` };
  }
  if (pr.alreadyQueued) {
    return { kind: 'noop', reason: `PR #${pr.number} is already in the merge queue.` };
  }
  // CLEAN means all required checks are passing.
  const state = (pr.mergeStateStatus ?? '').toUpperCase();
  if (state === 'DIRTY') return { kind: 'blocked', reason: `PR #${pr.number} has merge conflicts.` };
  if (state === 'BEHIND') return { kind: 'blocked', reason: `PR #${pr.number} is behind base; update branch first.` };
  if (pr.baseBranchSupportsQueue === false) {
    return { kind: 'blocked', reason: `Base branch ${pr.baseRefName ?? '(unknown)'} does not have merge queue enabled.` };
  }
  const warnings: string[] = [];
  if (pr.autoMergeEnabled) {
    warnings.push('auto-merge was already enabled - the queue flag will replace it.');
  }
  if (state === 'BLOCKED') {
    warnings.push('PR is currently BLOCKED; the queue will hold it until blocking checks pass.');
  }
  if (state === 'HAS_HOOKS' || state === 'UNSTABLE') {
    warnings.push(`PR is in ${state} state; the queue may still accept it once checks settle.`);
  }
  if (state === 'UNKNOWN' || state === '') {
    warnings.push('PR mergeStateStatus is unknown; verify in browser before relying on the queue.');
  }
  return { kind: 'ok', warnings };
}

export type DequeueVerdict =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'noop'; reason: string };

export function classifyDequeue(pr: PrSnapshot): DequeueVerdict {
  if (!pr.alreadyQueued && !pr.autoMergeEnabled) {
    return { kind: 'noop', reason: `PR #${pr.number} is not in the queue and has no auto-merge enabled.` };
  }
  if (pr.baseRepoSlug && pr.headRepoSlug && pr.baseRepoSlug !== pr.headRepoSlug) {
    return { kind: 'blocked', reason: `PR #${pr.number} is cross-repo - dequeue from the source repo.` };
  }
  return { kind: 'ok' };
}

/**
 * Build the gh CLI args for an enqueue action.
 *
 *   gh pr merge <num> --queue --merge        (default strategy)
 *   gh pr merge <num> --queue --squash       (squash strategy)
 *   gh pr merge <num> --queue --rebase       (rebase strategy)
 *
 * Note: `--auto` is implied by `--queue` in modern gh; we omit it to
 * keep the arg list minimal. The view layer wraps this in pexec.
 */
export function buildEnqueueArgs(args: EnqueueArgs): string[] {
  const strategyFlag = strategyToFlag(args.strategy);
  return ['pr', 'merge', String(args.pr.number), '--queue', strategyFlag];
}

/**
 * Build the gh CLI args for a dequeue action.
 *
 *   gh pr merge <num> --disable-auto
 */
export function buildDequeueArgs(pr: PrSnapshot): string[] {
  return ['pr', 'merge', String(pr.number), '--disable-auto'];
}

function strategyToFlag(s: MergeStrategy): string {
  switch (s) {
    case 'squash': return '--squash';
    case 'rebase': return '--rebase';
    case 'merge': default: return '--merge';
  }
}

/**
 * Pretty headline used as the modal/confirmation title.
 *
 *   "Add PR #42 to the merge queue (squash)?"
 *   "Remove PR #42 from the merge queue?"
 */
export function actionHeadline(action: EnqueueAction, pr: PrSnapshot, strategy?: MergeStrategy): string {
  if (action === 'dequeue') return `Remove PR #${pr.number} from the merge queue?`;
  const tag = strategy && strategy !== 'merge' ? ` (${strategy})` : '';
  return `Add PR #${pr.number} to the merge queue${tag}?`;
}

/** Render an enqueue verdict's warnings as a single bullet markdown line. */
export function formatVerdictHints(verdict: EnqueueVerdict): string {
  if (verdict.kind === 'ok') {
    if (verdict.warnings.length === 0) return '_No warnings._';
    return verdict.warnings.map(w => `- ${w}`).join('\n');
  }
  if (verdict.kind === 'noop') return `_${verdict.reason}_`;
  return `**Blocked:** ${verdict.reason}`;
}

/**
 * Validate a user-supplied strategy string from a picker or
 * configuration. Returns 'merge' for unknown inputs (graceful default)
 * paired with `coerced: true` so the UI can decide whether to warn.
 */
export function normaliseStrategy(input: unknown): { strategy: MergeStrategy; coerced: boolean } {
  if (typeof input !== 'string') return { strategy: 'merge', coerced: true };
  const lower = input.toLowerCase().trim();
  if (lower === 'merge' || lower === 'squash' || lower === 'rebase') {
    return { strategy: lower as MergeStrategy, coerced: false };
  }
  return { strategy: 'merge', coerced: true };
}
