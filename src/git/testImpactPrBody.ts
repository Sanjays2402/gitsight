/**
 * Pure helpers for F125 - Test-Impact -> PR body sync.
 *
 * Companion to F77 (PR draft body sync) and F122 (test impact). After a
 * push to a branch that has an open PR, this feature writes a managed
 * block listing the highest-confidence suggested tests into the PR
 * body so reviewers see "what tests we think you should touch" right
 * inside the description.
 *
 * Body shape (stable so tests can assert on it):
 *
 *   <user prologue, preserved verbatim>
 *
 *   <!-- GITSIGHT:TEST-IMPACT -->
 *   ## Likely-touched tests (N)
 *
 *   - score 32 - `test/foo.spec.ts` (imports `src/foo.ts`)
 *   - score 18 - `__tests__/bar.test.ts` (co-located with `src/bar.ts`)
 *
 *   _N sources covered by suggested tests, M orphan sources._
 *   _Last synced 2026-06-23 06:30 PDT by GitSight._
 *   <!-- /GITSIGHT:TEST-IMPACT -->
 *
 *   <user epilogue, preserved verbatim>
 *
 * The marker sentinels let us round-trip the body cleanly: anything
 * the user typed above or below them is preserved across syncs. Compares
 * with timestamp masked so a no-op rewrite doesn't trigger a redundant
 * gh pr edit.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/testImpactPrBody.test.ts.
 */

import { TestImpactSummary, TestImpactRow } from './testImpact';

export const TEST_IMPACT_OPEN_MARKER = '<!-- GITSIGHT:TEST-IMPACT -->';
export const TEST_IMPACT_CLOSE_MARKER = '<!-- /GITSIGHT:TEST-IMPACT -->';

export interface BuildTestImpactBlockArgs {
  summary: TestImpactSummary;
  /** Local-time string for the footer; caller provides so we don't drag
   *  time-zone deps into a pure helper. */
  syncedAt: string;
  /** Cap on how many test rows appear in the body block. */
  maxRows?: number;
  /** Whether to include orphan sources as a bulleted list below the table. */
  includeOrphans?: boolean;
  /** Cap on orphan rows. */
  maxOrphans?: number;
}

/**
 * Build the canonical "managed block" we splice into the PR body. The
 * block is bracketed by the open/close markers so we can detect and
 * rewrite it on subsequent syncs without touching user-authored prose.
 *
 * No rows -> renders a "_No test impact detected yet._" stub so the
 * reviewer knows the gate ran and found nothing (vs the marker being
 * missing entirely).
 */
export function buildTestImpactBlock(args: BuildTestImpactBlockArgs): string {
  const { summary, syncedAt, maxRows = 12, includeOrphans = true, maxOrphans = 10 } = args;
  const lines: string[] = [TEST_IMPACT_OPEN_MARKER, ''];

  const rows = summary.rows.slice(0, Math.max(0, maxRows));
  if (rows.length === 0) {
    lines.push('## Likely-touched tests');
    lines.push('');
    if (summary.consideredSources === 0) {
      lines.push('_No source files changed._');
    } else {
      lines.push(`_No tests detected for ${summary.consideredSources} changed source file${summary.consideredSources === 1 ? '' : 's'}._`);
    }
  } else {
    lines.push(`## Likely-touched tests (${rows.length}${summary.rows.length > rows.length ? ` of ${summary.rows.length}` : ''})`);
    lines.push('');
    for (const r of rows) {
      const sigBlurb = describeRowSignals(r);
      lines.push(`- score ${r.score} \u2014 \`${r.testFile}\` (${sigBlurb})`);
    }
  }
  lines.push('');

  if (summary.coveredSources > 0 || summary.consideredSources > 0) {
    const oWord = summary.orphanSources.length === 1 ? 'orphan' : 'orphans';
    lines.push(
      `_${summary.coveredSources}/${summary.consideredSources} source${summary.consideredSources === 1 ? '' : 's'} covered, ${summary.orphanSources.length} ${oWord}._`,
    );
  }

  if (includeOrphans && summary.orphanSources.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${summary.orphanSources.length} orphan source${summary.orphanSources.length === 1 ? '' : 's'} (no suggested tests)</summary>`);
    lines.push('');
    for (const o of summary.orphanSources.slice(0, Math.max(0, maxOrphans))) {
      lines.push(`- \`${o}\``);
    }
    if (summary.orphanSources.length > maxOrphans) {
      lines.push(`- _\u2026and ${summary.orphanSources.length - maxOrphans} more._`);
    }
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  lines.push(`_Last synced ${syncedAt} by GitSight._`);
  lines.push(TEST_IMPACT_CLOSE_MARKER);
  return lines.join('\n');
}

function describeRowSignals(row: TestImpactRow): string {
  const sigs = row.signals;
  if (sigs.length === 0) return 'no signal';
  const first = sigs[0];
  if (sigs.length === 1) {
    switch (first) {
      case 'import': return `imports ${formatSourceList(row.sourceFiles)}`;
      case 'co-located': return `co-located with ${formatSourceList(row.sourceFiles)}`;
      case 'naming-sibling': return `naming sibling of ${formatSourceList(row.sourceFiles)}`;
    }
  }
  // Multi-signal: pick the strongest then add a small ", + N more" tail.
  const lead = first === 'import' ? 'imports'
             : first === 'co-located' ? 'co-located'
             : 'naming sibling';
  return `${lead} (${sigs.length} signals)`;
}

function formatSourceList(srcs: string[]): string {
  if (srcs.length === 0) return '';
  if (srcs.length === 1) return `\`${srcs[0]}\``;
  if (srcs.length === 2) return `\`${srcs[0]}\`, \`${srcs[1]}\``;
  return `\`${srcs[0]}\`, \`${srcs[1]}\`, +${srcs.length - 2}`;
}

/**
 * Splice the managed block into an existing PR body. If the body
 * already contains a previous block (marker pair), replace it in
 * place; otherwise append the block to the end with a blank line
 * separator.
 *
 * Anything the user wrote outside the markers is preserved
 * byte-for-byte.
 */
export function injectTestImpactBlock(existingBody: string, block: string): string {
  const open = existingBody.indexOf(TEST_IMPACT_OPEN_MARKER);
  const close = existingBody.indexOf(TEST_IMPACT_CLOSE_MARKER);
  if (open >= 0 && close > open) {
    const before = existingBody.slice(0, open);
    const after = existingBody.slice(close + TEST_IMPACT_CLOSE_MARKER.length);
    const beforeTrimmed = before.replace(/[ \t]+$/g, '');
    const afterTrimmed = after.replace(/^[\r\n]+/, '\n');
    return `${beforeTrimmed}${block}${afterTrimmed}`;
  }
  const trimmed = (existingBody ?? '').replace(/[\r\n\s]+$/g, '');
  if (!trimmed) return block;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Decide whether the body needs an update. Returns true when:
 *   - the body doesn't yet contain the managed block, OR
 *   - the block contents would differ from the freshly-rendered block
 *     (ignoring the timestamp line, which always changes).
 */
export function needsTestImpactRewrite(currentBody: string, freshBlock: string): boolean {
  const open = currentBody.indexOf(TEST_IMPACT_OPEN_MARKER);
  const close = currentBody.indexOf(TEST_IMPACT_CLOSE_MARKER);
  if (open < 0 || close < open) return true;
  const existingBlock = currentBody.slice(open, close + TEST_IMPACT_CLOSE_MARKER.length);
  return stripTimestamp(existingBlock) !== stripTimestamp(freshBlock);
}

function stripTimestamp(block: string): string {
  return block.replace(/_Last synced [^_]+_/g, '_Last synced TIMESTAMP_');
}

/**
 * Convenience: strip the managed block entirely. Used by the "remove
 * managed block" action so the user can opt out without manually
 * deleting between the markers.
 */
export function stripTestImpactBlock(body: string): string {
  const open = body.indexOf(TEST_IMPACT_OPEN_MARKER);
  const close = body.indexOf(TEST_IMPACT_CLOSE_MARKER);
  if (open < 0 || close < open) return body;
  const before = body.slice(0, open).replace(/[ \t\r\n]+$/g, '');
  const after = body.slice(close + TEST_IMPACT_CLOSE_MARKER.length).replace(/^[\r\n\s]+/, '');
  if (!before && !after) return '';
  if (!before) return after;
  if (!after) return before + '\n';
  return `${before}\n\n${after}`;
}

/**
 * Build the "what's in the body right now" decision shape so the view
 * layer can show an accurate breadcrumb in the picker BEFORE writing.
 */
export type TestImpactSyncDecision =
  | 'no-change'   // existing block matches the fresh block (ignoring timestamp)
  | 'insert'      // no block yet - we'll append
  | 'replace';    // block exists but content differs

export function classifyTestImpactSync(currentBody: string, freshBlock: string): TestImpactSyncDecision {
  const open = currentBody.indexOf(TEST_IMPACT_OPEN_MARKER);
  const close = currentBody.indexOf(TEST_IMPACT_CLOSE_MARKER);
  if (open < 0 || close < open) return 'insert';
  return needsTestImpactRewrite(currentBody, freshBlock) ? 'replace' : 'no-change';
}

/**
 * F129 - Detect whether a body ALREADY has a managed test-impact block.
 *
 * Used by the auto-sync hook to decide whether to run at all - we
 * auto-refresh ONLY when the user has already opted in by inserting
 * the block once via F125. Mirrors how F77 PR-draft sync only fires
 * on actual draft PRs (it's an explicit "you wanted this" signal).
 *
 * Tolerates partial / malformed marker pairs: returns true only when
 * both markers are present AND in the correct order. A lone open
 * marker (e.g. left over from a manual edit gone wrong) reads as
 * absent so we don't get into a half-block append loop.
 */
export function hasTestImpactBlock(body: string): boolean {
  if (!body) return false;
  const open = body.indexOf(TEST_IMPACT_OPEN_MARKER);
  if (open < 0) return false;
  const close = body.indexOf(TEST_IMPACT_CLOSE_MARKER);
  return close > open;
}

/**
 * F129 - End-state result reported back from the fire-and-forget hook.
 *
 * The status-bar uses this to render ONE concise line:
 *   - 'no-pr'         -> silent (the branch may legitimately not have a PR yet)
 *   - 'no-block'      -> silent (user hasn't opted in via F125)
 *   - 'no-change'     -> silent (block already up to date)
 *   - 'refreshed'     -> show "GitSight: refreshed test-impact in PR #N"
 *   - 'failed'        -> show "GitSight: test-impact sync failed (reason)"
 *   - 'skipped'       -> silent (disabled in settings, gh missing, etc.)
 */
export type TestImpactAutoSyncOutcome =
  | 'no-pr'
  | 'no-block'
  | 'no-change'
  | 'refreshed'
  | 'failed'
  | 'skipped';

/**
 * Pure verdict helper - the view layer feeds (currentBody, freshBlock)
 * and gets back the auto-sync verdict + an optional reason. Decouples
 * the decision logic from the gh + fs side effects so it's easy to
 * unit-test the fire-and-forget gate independently.
 */
export interface ClassifyAutoSyncArgs {
  currentBody: string | undefined;
  freshBlock: string;
  /** When true, the hook will skip even if a block exists (e.g. user
   *  flipped the auto-sync config off). */
  enabled: boolean;
}

export function classifyAutoSync(args: ClassifyAutoSyncArgs): {
  outcome: TestImpactAutoSyncOutcome;
  reason?: string;
} {
  if (!args.enabled) return { outcome: 'skipped', reason: 'auto-sync disabled' };
  if (args.currentBody == null) return { outcome: 'no-pr' };
  if (!hasTestImpactBlock(args.currentBody)) return { outcome: 'no-block' };
  const decision = classifyTestImpactSync(args.currentBody, args.freshBlock);
  if (decision === 'no-change') return { outcome: 'no-change' };
  return { outcome: 'refreshed' };
}
