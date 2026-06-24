/**
 * F144 - Auto-merge integration for the pre-merge checklist.
 *
 * Companion to F138 (pre-merge readiness checklist) + F121 (merge
 * queue enqueue/dequeue). When the F138 verdict is `ready` BUT
 * one or more required status checks are still pending, the user's
 * choice is "babysit the PR until the green tick lands and then
 * click merge" - which is exactly what `gh pr merge --auto` is
 * for. This helper decides when the auto-merge action should be
 * surfaced alongside the regular "Merge now" action in the F138
 * picker, and builds the matching argv.
 *
 * Why a separate slice from F121? F121 wraps the merge QUEUE (the
 * GitHub Merge Queue feature, when the repo has one enabled), which
 * is a heavier ceremony - it requires a configured queue, branches
 * are pre-aggregated, etc. Most repos don't have a queue but still
 * want plain `--auto` so the merge fires the instant CI goes green.
 * This is the "single PR" auto-merge surface.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/preMergeAutoMerge.test.ts.
 */

import { MergeReport, MergeVerdict, StatusCheckVerdict } from './preMergeChecklist';

/**
 * Decision states for offering `gh pr merge --auto`:
 *
 *   - 'offer'         : merge isn't blocked, but at least one required
 *                       check is still PENDING - `--auto` will fire
 *                       the merge when that check goes green. The
 *                       canonical happy path for this surface.
 *   - 'unnecessary'   : verdict is 'ready' AND no pending checks - the
 *                       user can just merge now, --auto is redundant.
 *   - 'blocked'       : the verdict is 'blocked' for a reason --auto
 *                       won't fix (failing checks, conflicts, missing
 *                       approvals, draft state). Auto-merge would just
 *                       sit there indefinitely.
 *   - 'unsupported'   : merge state is UNKNOWN or something else we
 *                       can't reason about safely. Hide the option.
 *   - 'auto-already-on': PR is already in auto-merge mode (the caller
 *                       passes this flag from the gh JSON probe).
 *                       Surface a 'disable' action instead.
 */
export type AutoMergeOfferVerdict =
  | 'offer'
  | 'unnecessary'
  | 'blocked'
  | 'unsupported'
  | 'auto-already-on';

export interface AutoMergeOfferArgs {
  /** The F138 aggregate verdict. */
  verdict: MergeVerdict;
  /** Normalised mergeStateStatus from GitHub (CLEAN / BLOCKED / UNSTABLE / ...). */
  mergeStateStatus: StatusCheckVerdict;
  /** Count of required status checks that are pending/queued/in-progress. */
  pendingCheckCount: number;
  /** True when the PR's autoMergeRequest field is populated. */
  autoMergeEnabled?: boolean;
  /** True when the PR is a draft. Draft PRs can't auto-merge. */
  isDraft?: boolean;
}

export function classifyAutoMergeOffer(args: AutoMergeOfferArgs): AutoMergeOfferVerdict {
  if (args.autoMergeEnabled) return 'auto-already-on';
  if (args.isDraft) return 'blocked';
  if (args.verdict === 'blocked') return 'blocked';
  if (args.mergeStateStatus === 'UNKNOWN') return 'unsupported';
  if (args.mergeStateStatus === 'DIRTY') return 'blocked';
  // The canonical case: not blocked, has pending checks => --auto fires when they pass.
  if (args.pendingCheckCount > 0) return 'offer';
  // Ready and nothing pending - the user can merge straight away.
  if (args.verdict === 'ready') return 'unnecessary';
  // Caution verdict + no pending checks. Auto-merge would still be wrong because
  // the caution is something semantic the user should see first (e.g. base drift,
  // stale test-impact). Suppress.
  return 'unnecessary';
}

/**
 * Strategy options for `gh pr merge --auto`. Mirrors F121 but the
 * --auto path only accepts one strategy at a time (no queue).
 */
export type AutoMergeStrategy = 'merge' | 'squash' | 'rebase';

export function normaliseAutoMergeStrategy(input: string | undefined): { strategy: AutoMergeStrategy; coerced: boolean } {
  const raw = (input ?? '').trim().toLowerCase();
  if (raw === 'squash')        return { strategy: 'squash', coerced: false };
  if (raw === 'rebase')        return { strategy: 'rebase', coerced: false };
  if (raw === 'merge')         return { strategy: 'merge', coerced: false };
  // Empty + unknown shapes all coerce to 'merge' (the safest GitHub default).
  return { strategy: 'merge', coerced: true };
}

export interface BuildAutoMergeArgsArgs {
  prNumber: number;
  strategy: AutoMergeStrategy;
  /** When true, build the `--disable-auto` form instead. */
  disable?: boolean;
  /** Optional explicit subject (--subject=...). Skipped when empty. */
  subject?: string;
  /** Optional explicit body (--body=...). Skipped when empty. */
  body?: string;
}

/**
 * Build the `gh pr merge` argv vector for the auto path.
 *
 * Enabling auto-merge:
 *   gh pr merge 42 --auto --squash
 *
 * Disabling auto-merge:
 *   gh pr merge 42 --disable-auto
 *
 * The `--disable-auto` form takes no strategy flag (GitHub remembers
 * the original choice from when auto was enabled).
 */
export function buildAutoMergeArgs(args: BuildAutoMergeArgsArgs): string[] {
  if (!Number.isFinite(args.prNumber) || args.prNumber <= 0) return [];
  const argv: string[] = ['pr', 'merge', String(args.prNumber)];
  if (args.disable) {
    argv.push('--disable-auto');
    return argv;
  }
  argv.push('--auto');
  switch (args.strategy) {
    case 'squash': argv.push('--squash'); break;
    case 'rebase': argv.push('--rebase'); break;
    case 'merge':  argv.push('--merge'); break;
  }
  if (args.subject && args.subject.trim()) {
    argv.push(`--subject=${args.subject.trim()}`);
  }
  if (args.body && args.body.trim()) {
    argv.push(`--body=${args.body.trim()}`);
  }
  return argv;
}

/**
 * Build the terminal command string the user is dropped into.
 *
 * We DON'T auto-run; same handoff as F121 - the user sees the command,
 * eyeballs it, and hits Enter. This matches the F138 'Merge now' flow.
 */
export function describeAutoMergeCommand(argv: string[]): string {
  if (!argv.length) return '';
  return ['gh', ...argv.map(shellQuoteIfNeeded)].join(' ');
}

function shellQuoteIfNeeded(s: string): string {
  if (!s) return "''";
  if (/^[A-Za-z0-9_.\/=\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Headline copy for the F138 picker row. The view layer formats it
 * with a glyph; this helper produces the label + detail strings.
 */
export interface AutoMergeRowCopy {
  label: string;
  detail: string;
}

export function describeAutoMergeRow(verdict: AutoMergeOfferVerdict, pendingCount: number): AutoMergeRowCopy {
  switch (verdict) {
    case 'offer':
      return {
        label: 'Enable auto-merge',
        detail: pendingCount === 1
          ? 'Will merge automatically when the remaining required check passes.'
          : `Will merge automatically when all ${pendingCount} required checks pass.`,
      };
    case 'unnecessary':
      return {
        label: 'Enable auto-merge (not needed)',
        detail: 'All required checks already passed - just hit "Merge now" instead.',
      };
    case 'auto-already-on':
      return {
        label: 'Disable auto-merge',
        detail: 'Auto-merge is currently enabled on this PR.',
      };
    case 'blocked':
      return {
        label: 'Enable auto-merge (blocked)',
        detail: 'PR has blockers --auto cannot resolve (conflicts, failing checks, draft, or missing approvals).',
      };
    case 'unsupported':
      return {
        label: 'Enable auto-merge (unavailable)',
        detail: 'GitHub has not finished computing merge state. Try again in a few seconds.',
      };
  }
}

/**
 * Quick "should the F138 picker include the auto-merge row at all?"
 * predicate. The 'blocked' / 'unsupported' verdicts get DROPPED from
 * the picker entirely rather than showing as greyed-out (they'd just
 * be noise - the user already sees the blocking gate in the report).
 *
 * The 'unnecessary' verdict is kept (shown grey) for discoverability:
 * if the user is on a green PR and learns the surface exists, they'll
 * remember it for the next non-green case.
 */
export function shouldShowAutoMergeRow(verdict: AutoMergeOfferVerdict): boolean {
  switch (verdict) {
    case 'offer':
    case 'unnecessary':
    case 'auto-already-on':
      return true;
    case 'blocked':
    case 'unsupported':
      return false;
  }
}

/**
 * Generate the report breadcrumb appended below the verdict line when
 * the report ends in 'caution' or 'ready'. Reads naturally inline,
 * not its own block.
 */
export function describeAutoMergeBreadcrumb(args: AutoMergeOfferArgs): string {
  const v = classifyAutoMergeOffer(args);
  switch (v) {
    case 'offer':
      return args.pendingCheckCount === 1
        ? '1 required check still pending - auto-merge will fire on green.'
        : `${args.pendingCheckCount} required checks still pending - auto-merge will fire on all green.`;
    case 'unnecessary':
      return 'All required checks already passed; auto-merge not needed.';
    case 'auto-already-on':
      return 'Auto-merge is already enabled on this PR.';
    case 'blocked':
    case 'unsupported':
      return '';
  }
}

/**
 * Helper for the F138 picker - given a MergeReport + supplementary
 * fields, produce a single tagged row payload the view can splice
 * into its quick-pick list.
 */
export interface AutoMergeRowDecision {
  shown: boolean;
  verdict: AutoMergeOfferVerdict;
  copy: AutoMergeRowCopy;
}

export function decideAutoMergeRow(report: MergeReport, args: Omit<AutoMergeOfferArgs, 'verdict'>): AutoMergeRowDecision {
  const verdict = classifyAutoMergeOffer({ ...args, verdict: report.verdict });
  const shown = shouldShowAutoMergeRow(verdict);
  return {
    shown,
    verdict,
    copy: describeAutoMergeRow(verdict, args.pendingCheckCount),
  };
}
