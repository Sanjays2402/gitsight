/**
 * Pure helpers for F139 - PR-body test-impact INSERT auto-offer.
 *
 * Composes with F125 (manual injectTestImpactIntoPr) + F129 (auto-sync
 * fire-and-forget). The gap F139 fills: a user who has never run F125
 * never gets the benefits of auto-sync (F129 only refreshes blocks
 * that ALREADY exist). This controller passively offers to insert the
 * block on first PR view IF the PR meets a "worth it" threshold.
 *
 * Decision shape:
 *
 *   - Body already has the block      -> 'skip-already-present'
 *   - PR has < threshold files        -> 'skip-too-small'   (block is
 *                                        overkill for tiny PRs)
 *   - PR was dismissed this session   -> 'skip-dismissed'
 *   - PR is a draft                   -> 'skip-draft'       (don't
 *                                        offer before the PR is ready)
 *   - User opted out via config       -> 'skip-disabled'
 *   - Verdict 'offer'                 -> show the toast
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/testImpactPrBodyInsertOffer.test.ts.
 */

import { hasTestImpactBlock } from './testImpactPrBody';

export type InsertOfferOutcome =
  | 'offer'
  | 'skip-disabled'
  | 'skip-no-pr'
  | 'skip-already-present'
  | 'skip-too-small'
  | 'skip-dismissed'
  | 'skip-draft';

export interface InsertOfferArgs {
  /** F125 auto-offer feature enabled in user config. */
  enabled: boolean;
  /** PR body as fetched from gh. undefined when no PR exists for the branch. */
  prBody: string | undefined;
  /** Total files changed in the PR. */
  changedFileCount: number;
  /** Minimum file count to trigger the offer. */
  minimumFileCount: number;
  /** Whether the PR is a draft. */
  isDraft: boolean;
  /** Whether the user has previously dismissed this PR in this session. */
  alreadyDismissed: boolean;
}

export function classifyInsertOffer(args: InsertOfferArgs): InsertOfferOutcome {
  if (!args.enabled) return 'skip-disabled';
  if (args.prBody === undefined) return 'skip-no-pr';
  if (hasTestImpactBlock(args.prBody)) return 'skip-already-present';
  if (args.alreadyDismissed) return 'skip-dismissed';
  if (args.isDraft) return 'skip-draft';
  if (args.changedFileCount < Math.max(1, args.minimumFileCount)) return 'skip-too-small';
  return 'offer';
}

/**
 * Render the toast body when we DO offer. The view passes (prNumber,
 * fileCount) so the user sees why the offer is appearing.
 */
export function describeInsertOffer(args: { prNumber: number; fileCount: number }): string {
  return `PR #${args.prNumber} touches ${args.fileCount} files. Insert test-impact summary into the body so reviewers know which tests to run?`;
}

/**
 * One-line "why we skipped" summary - useful for the status-bar
 * breadcrumb when DEBUG=true (and the per-tick session log).
 */
export function describeInsertOfferSkip(outcome: Exclude<InsertOfferOutcome, 'offer'>): string {
  switch (outcome) {
    case 'skip-disabled':        return 'test-impact insert auto-offer is disabled in config';
    case 'skip-no-pr':           return 'no open PR for the current branch';
    case 'skip-already-present': return 'PR body already has a test-impact block';
    case 'skip-dismissed':       return 'user dismissed this PR this session';
    case 'skip-draft':           return 'PR is still a draft';
    case 'skip-too-small':       return 'PR is below the file-count threshold';
  }
}

/**
 * Should the toast remember the dismissal session-wide? Always yes for
 * 'skip' verdicts that the user can affect (dismissed); always no for
 * structural verdicts (no-pr, already-present). The session cache key
 * is the PR URL so a re-checkout or branch-switch doesn't re-prompt.
 */
export function shouldRememberDismissal(outcome: InsertOfferOutcome): boolean {
  // We remember 'offer' too because the user might tap Dismiss in the
  // toast; the view layer marks it after the user clicks. This helper
  // is for the auto-dismiss case - return true so a future tick
  // doesn't re-prompt the same PR if the verdict was an actionable
  // skip the user already saw (draft, too-small).
  return outcome === 'offer' || outcome === 'skip-draft' || outcome === 'skip-too-small';
}

/**
 * Compose the dismissal cache key from a PR URL. Strips trailing
 * slashes + lowercases the host so different gh-cli-version url
 * shapes collide.
 */
export function dismissalCacheKey(prUrl: string): string {
  if (!prUrl) return '';
  const trimmed = prUrl.trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    return `${u.host.toLowerCase()}${u.pathname.toLowerCase()}`;
  } catch {
    // Fall back to a cleaned literal - works for non-URL inputs in tests.
    return trimmed.toLowerCase();
  }
}
