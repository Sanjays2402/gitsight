/**
 * Pure helpers for F134 - Test-Impact PR Body Diff Verdict.
 *
 * Companion to F125 (test-impact -> PR body sync) and F129 (auto-sync).
 * When an auto-sync rewrites the managed block, we have BOTH the old
 * payload and the new payload. Computing a structured diff between
 * them lets us:
 *
 *   1. Surface a per-row delta in the status bar so the user sees
 *      "GitSight: refreshed test-impact in PR #42 (+2 tests, -1 stale)"
 *      instead of the opaque "refreshed".
 *   2. Optionally post a PR comment with the delta so reviewers
 *      checking notifications see WHY the bot rewrote the body
 *      (no surprise force-edits).
 *
 * Pure - no vscode, no gh. Tests in test/git/testImpactPrBodyDelta.test.ts.
 */

import { TestImpactSummary, TestImpactRow } from './testImpact';

/**
 * Per-test delta in the rewrite.
 *
 *   - 'added'      -> appeared in new but not in old
 *   - 'removed'    -> appeared in old but not in new
 *   - 'rescored'   -> same test, score delta != 0
 *   - 'unchanged'  -> same test, same score
 */
export type TestImpactDeltaKind = 'added' | 'removed' | 'rescored' | 'unchanged';

export interface TestImpactRowDelta {
  testFile: string;
  kind: TestImpactDeltaKind;
  /** Old score (undefined for 'added'). */
  oldScore?: number;
  /** New score (undefined for 'removed'). */
  newScore?: number;
  /** Numeric delta (newScore - oldScore). 0 for unchanged + added. */
  scoreDelta: number;
}

export interface TestImpactDiff {
  added: TestImpactRowDelta[];
  removed: TestImpactRowDelta[];
  rescored: TestImpactRowDelta[];
  unchanged: TestImpactRowDelta[];
  /** Total source count change (newConsidered - oldConsidered). */
  sourceDelta: number;
  /** Orphan count change (newOrphan - oldOrphan). Positive = more orphans. */
  orphanDelta: number;
}

/**
 * Compute the row-level diff between two summaries. Stable, deterministic
 * ordering inside each bucket (testFile asc) so the picker / report
 * layout doesn't jitter between runs with the same data.
 */
export function diffTestImpact(
  oldSummary: TestImpactSummary | undefined,
  newSummary: TestImpactSummary,
): TestImpactDiff {
  const oldRows = oldSummary?.rows ?? [];
  const oldByFile = new Map<string, TestImpactRow>();
  for (const r of oldRows) oldByFile.set(r.testFile, r);
  const newByFile = new Map<string, TestImpactRow>();
  for (const r of newSummary.rows) newByFile.set(r.testFile, r);

  const added: TestImpactRowDelta[] = [];
  const removed: TestImpactRowDelta[] = [];
  const rescored: TestImpactRowDelta[] = [];
  const unchanged: TestImpactRowDelta[] = [];

  for (const [file, nr] of newByFile) {
    const or = oldByFile.get(file);
    if (!or) {
      added.push({ testFile: file, kind: 'added', newScore: nr.score, scoreDelta: 0 });
      continue;
    }
    const delta = nr.score - or.score;
    if (delta === 0) {
      unchanged.push({
        testFile: file, kind: 'unchanged', oldScore: or.score, newScore: nr.score, scoreDelta: 0,
      });
    } else {
      rescored.push({
        testFile: file, kind: 'rescored', oldScore: or.score, newScore: nr.score, scoreDelta: delta,
      });
    }
  }
  for (const [file, or] of oldByFile) {
    if (newByFile.has(file)) continue;
    removed.push({ testFile: file, kind: 'removed', oldScore: or.score, scoreDelta: -or.score });
  }

  added.sort(byFile);
  removed.sort(byFile);
  rescored.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta) || byFile(a, b));
  unchanged.sort(byFile);

  const oldConsidered = oldSummary?.consideredSources ?? 0;
  const oldOrphan = oldSummary?.orphanSources.length ?? 0;
  return {
    added,
    removed,
    rescored,
    unchanged,
    sourceDelta: newSummary.consideredSources - oldConsidered,
    orphanDelta: newSummary.orphanSources.length - oldOrphan,
  };
}

function byFile(a: TestImpactRowDelta, b: TestImpactRowDelta): number {
  return a.testFile.localeCompare(b.testFile);
}

/**
 * Concise one-line headline for the status-bar message after auto-sync.
 *
 *   "+2 tests, -1 stale, 3 rescored"
 *   "+1 test, no changes elsewhere"
 *   "no change"
 *
 * Returns "no change" when added + removed + rescored counts are zero
 * (the caller can suppress the status bar entirely in that case).
 */
export function summariseDiffHeadline(diff: TestImpactDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`+${diff.added.length} test${diff.added.length === 1 ? '' : 's'}`);
  }
  if (diff.removed.length > 0) {
    parts.push(`-${diff.removed.length} stale`);
  }
  if (diff.rescored.length > 0) {
    parts.push(`${diff.rescored.length} rescored`);
  }
  if (!parts.length) return 'no change';
  return parts.join(', ');
}

/**
 * Decide whether to post a PR comment about the rewrite. We don't
 * want to spam reviewers every time a row drops by 1 point, so the
 * gate is:
 *
 *   - any added or removed rows (structural change to suggestions)
 *   - OR any rescored row with abs(scoreDelta) >= threshold (default 10)
 *
 * Returns 'post' when we should comment, 'skip' otherwise. The view
 * layer respects an additional user opt-in config (default off because
 * commenting on every push is hostile).
 */
export interface CommentGateArgs {
  diff: TestImpactDiff;
  /** Minimum abs(scoreDelta) on a rescore to count as significant. Default 10. */
  rescoreThreshold?: number;
}

export type CommentGateVerdict = 'post' | 'skip';

export function shouldPostDeltaComment(args: CommentGateArgs): CommentGateVerdict {
  const { diff } = args;
  const threshold = args.rescoreThreshold ?? 10;
  if (diff.added.length > 0 || diff.removed.length > 0) return 'post';
  for (const r of diff.rescored) {
    if (Math.abs(r.scoreDelta) >= threshold) return 'post';
  }
  return 'skip';
}

/**
 * Render the diff as a compact markdown comment body. Sections only
 * appear when they have content - we don't emit empty headers.
 *
 *   ## Test-impact delta
 *
 *   **Added (2)**
 *   - `test/foo.spec.ts` (score 12)
 *   - `test/bar.spec.ts` (score 8)
 *
 *   **Removed (1)**
 *   - `test/old.spec.ts` (was score 5)
 *
 *   **Rescored (1)**
 *   - `test/baz.spec.ts` 18 -> 25 (+7)
 *
 *   _2 sources, 0 orphans._
 */
export interface BuildCommentArgs {
  diff: TestImpactDiff;
  /** Cap on rows per section (default 20). */
  maxPerSection?: number;
  /** When set, prepend a leading header (default true). */
  includeHeader?: boolean;
}

export function buildDeltaCommentBody(args: BuildCommentArgs): string {
  const cap = args.maxPerSection ?? 20;
  const { diff } = args;
  const lines: string[] = [];
  if (args.includeHeader ?? true) {
    lines.push('## Test-impact delta');
    lines.push('');
  }

  let emittedSection = false;
  if (diff.added.length > 0) {
    emittedSection = true;
    lines.push(`**Added (${diff.added.length})**`);
    for (const r of diff.added.slice(0, cap)) {
      lines.push(`- \`${r.testFile}\` (score ${r.newScore ?? '?'})`);
    }
    if (diff.added.length > cap) lines.push(`- _\u2026and ${diff.added.length - cap} more_`);
    lines.push('');
  }
  if (diff.removed.length > 0) {
    emittedSection = true;
    lines.push(`**Removed (${diff.removed.length})**`);
    for (const r of diff.removed.slice(0, cap)) {
      lines.push(`- \`${r.testFile}\` (was score ${r.oldScore ?? '?'})`);
    }
    if (diff.removed.length > cap) lines.push(`- _\u2026and ${diff.removed.length - cap} more_`);
    lines.push('');
  }
  if (diff.rescored.length > 0) {
    emittedSection = true;
    lines.push(`**Rescored (${diff.rescored.length})**`);
    for (const r of diff.rescored.slice(0, cap)) {
      const sign = r.scoreDelta >= 0 ? '+' : '';
      lines.push(`- \`${r.testFile}\` ${r.oldScore ?? '?'} \u2192 ${r.newScore ?? '?'} (${sign}${r.scoreDelta})`);
    }
    if (diff.rescored.length > cap) lines.push(`- _\u2026and ${diff.rescored.length - cap} more_`);
    lines.push('');
  }
  if (!emittedSection) {
    lines.push('_No structural changes (scores held steady)._');
    lines.push('');
  }

  const meta: string[] = [];
  if (diff.sourceDelta !== 0) {
    const sign = diff.sourceDelta > 0 ? '+' : '';
    meta.push(`${sign}${diff.sourceDelta} source${Math.abs(diff.sourceDelta) === 1 ? '' : 's'} considered`);
  }
  if (diff.orphanDelta !== 0) {
    const sign = diff.orphanDelta > 0 ? '+' : '';
    meta.push(`${sign}${diff.orphanDelta} orphan${Math.abs(diff.orphanDelta) === 1 ? '' : 's'}`);
  }
  if (meta.length > 0) {
    lines.push(`_${meta.join(', ')}._`);
  }
  return lines.join('\n').replace(/\n+$/g, '');
}

/**
 * Compute deltas between two managed test-impact body BLOCKS (the
 * full marker-bracketed strings). Used when the view layer has the
 * body text but not the structured summary object - we parse just
 * enough to extract test rows + their scores.
 *
 * The block layout matches buildTestImpactBlock; rows are matched on
 * the regex anchor:
 *
 *   - score 32 - `path/to/test.ts` (imports `...`)
 *
 * Returns undefined when either block is malformed. Caller treats
 * that as "we can't compare, just show the headline".
 */
const ROW_RX = /^- score (\d+) \u2014 `([^`]+)`/gm;

export function parseRowsFromBlock(block: string): Array<{ testFile: string; score: number }> {
  const out: Array<{ testFile: string; score: number }> = [];
  if (!block) return out;
  const rx = new RegExp(ROW_RX.source, ROW_RX.flags);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(block)) !== null) {
    const score = parseInt(m[1], 10);
    const testFile = m[2];
    if (!testFile || !Number.isFinite(score)) continue;
    out.push({ testFile, score });
  }
  return out;
}

/**
 * Lightweight block-level diff that returns just the row deltas.
 * Useful when the full TestImpactSummary isn't available (e.g. when
 * the auto-sync hook only has the rendered blocks to compare).
 */
export function diffTestImpactBlocks(oldBlock: string, newBlock: string): TestImpactDiff {
  const oldRows = parseRowsFromBlock(oldBlock);
  const newRows = parseRowsFromBlock(newBlock);
  const oldByFile = new Map(oldRows.map(r => [r.testFile, r.score]));
  const newByFile = new Map(newRows.map(r => [r.testFile, r.score]));

  const added: TestImpactRowDelta[] = [];
  const removed: TestImpactRowDelta[] = [];
  const rescored: TestImpactRowDelta[] = [];
  const unchanged: TestImpactRowDelta[] = [];

  for (const [file, score] of newByFile) {
    const old = oldByFile.get(file);
    if (old === undefined) {
      added.push({ testFile: file, kind: 'added', newScore: score, scoreDelta: 0 });
      continue;
    }
    if (old === score) {
      unchanged.push({ testFile: file, kind: 'unchanged', oldScore: old, newScore: score, scoreDelta: 0 });
    } else {
      rescored.push({ testFile: file, kind: 'rescored', oldScore: old, newScore: score, scoreDelta: score - old });
    }
  }
  for (const [file, score] of oldByFile) {
    if (newByFile.has(file)) continue;
    removed.push({ testFile: file, kind: 'removed', oldScore: score, scoreDelta: -score });
  }

  added.sort(byFile);
  removed.sort(byFile);
  rescored.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta) || byFile(a, b));
  unchanged.sort(byFile);

  // Without summary objects we can't compute source / orphan deltas.
  return { added, removed, rescored, unchanged, sourceDelta: 0, orphanDelta: 0 };
}
