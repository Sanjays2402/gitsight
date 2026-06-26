/**
 * Pure side-by-side (split) diff row pairing (W38).
 *
 * DOM-free + framework-free + NO @shared alias, so it's unit-tested under
 * node --test. The unified diff renderer (diffView.ts) lists lines in one
 * column; the split renderer needs them paired into LEFT (old) / RIGHT
 * (new) rows. This module owns that pairing so the DOM renderer stays thin
 * and the alignment logic is covered without a browser.
 *
 * Pairing rules (mirrors the W34 word-diff run pairing so the two features
 * line up):
 *   - a context line -> one row, same line on both sides;
 *   - a run of deletions immediately followed by a run of additions ->
 *     zipped index-for-index (del[k] | add[k]); leftover deletions become
 *     old-only rows, leftover additions become new-only rows;
 *   - a run of additions with no preceding deletion -> new-only rows.
 * Every non-context input line appears in exactly one row.
 *
 * The DiffLine type comes in via a relative .ts import (the same trick
 * diffFormat.ts uses) so Node resolves it at test time without the Vite
 * `@shared` alias.
 *
 * Tests: web/src/diffSplit.test.mjs
 */

import type { DiffLine } from '../../src/shared/diffParse.ts';

/** One row of a side-by-side diff: an old-side line, a new-side line, or both. */
export interface SplitRow {
  /** Old (left) side line, or null when this row is a pure insertion. */
  old: DiffLine | null;
  /** New (right) side line, or null when this row is a pure deletion. */
  new: DiffLine | null;
  /**
   * True when BOTH sides are present AND they're a del/add replacement
   * (not a context line). The renderer uses this to align word-level
   * highlights between the two columns.
   */
  paired: boolean;
}

/**
 * Pair a hunk's lines into side-by-side rows. Context lines map to a row
 * with the same line on both sides; del/add runs zip together; unmatched
 * lines become single-sided rows. Order is preserved.
 */
export function splitHunkRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === 'context') {
      rows.push({ old: line, new: line, paired: false });
      i++;
      continue;
    }
    if (line.kind === 'del') {
      const dels: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const d = dels[k] ?? null;
        const a = adds[k] ?? null;
        rows.push({ old: d, new: a, paired: d !== null && a !== null });
      }
      continue;
    }
    // A bare add run (pure insertion) with no deletion before it.
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    if (adds.length === 0) {
      i++; // defensive: never stall on an unexpected kind
      continue;
    }
    for (const a of adds) rows.push({ old: null, new: a, paired: false });
  }
  return rows;
}

/**
 * Count how many split rows a hunk produces. Handy for the renderer's
 * truncation budget without materialising the rows twice.
 */
export function splitRowCount(lines: DiffLine[]): number {
  return splitHunkRows(lines).length;
}
