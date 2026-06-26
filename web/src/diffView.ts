/**
 * Per-file diff view (W7).
 *
 * Renders a parsed FileDiff (from the shared diffParse) as a GitHub-style
 * unified diff: gutter line numbers (old | new), +/- coloured rows, and
 * hunk separators. Pure-ish: takes the FileDiff and returns a detached
 * node the panel mounts. Line-number gutter logic is delegated to the
 * tested pure helpers in diffView so the DOM here stays thin.
 */

import { el } from './format';
import { escapeHtml } from '@shared/graphCore';
import type { FileDiff, DiffLine } from '@shared/diffParse';
import { gutterFor, signFor } from './diffFormat';
import { inlineDiff, shouldInlineDiff, type DiffSegment } from './tokenDiff';
import { splitHunkRows, type SplitRow } from './diffSplit';

export { gutterFor, signFor, diffHeaderStat } from './diffFormat';

export interface DiffViewOptions {
  /** Soft cap on rendered lines; above it, show a truncation note. */
  maxLines?: number;
  /**
   * Highlight changed word spans within paired del/add lines (W34). On by
   * default; disable for very large diffs where the pairing pass isn't worth
   * it.
   */
  wordDiff?: boolean;
  /**
   * Layout (W38): `'unified'` (default) stacks +/- rows in one column;
   * `'split'` renders side-by-side old | new columns. The word-diff spans
   * carry into both layouts.
   */
  view?: 'unified' | 'split';
}

const DEFAULT_MAX_LINES = 2000;

/** Render a parsed FileDiff into a detached node. */
export function renderFileDiff(file: FileDiff, opts: DiffViewOptions = {}): HTMLElement {
  const wrap = el('div', 'diff-view');

  if (file.binary) {
    const note = el('div', 'diff-empty');
    note.textContent = 'Binary file — no textual diff.';
    wrap.appendChild(note);
    return wrap;
  }

  if (file.hunks.length === 0) {
    const note = el('div', 'diff-empty');
    note.textContent = 'No textual changes (mode or metadata only).';
    wrap.appendChild(note);
    return wrap;
  }

  if ((opts.view ?? 'unified') === 'split') {
    return renderFileDiffSplit(file, opts);
  }

  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
  const wordDiff = opts.wordDiff ?? true;
  const table = el('div', 'diff-table');
  table.setAttribute('role', 'table');
  let emitted = 0;
  let truncated = false;

  outer: for (const hunk of file.hunks) {
    // Hunk header row.
    const head = el('div', 'diff-row hunk');
    const headGutter = el('span', 'diff-gutter');
    headGutter.textContent = '';
    const headText = el('span', 'diff-code');
    headText.textContent =
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` +
      (hunk.section ? ` ${hunk.section}` : '');
    head.append(headGutter, headText);
    table.appendChild(head);

    // Word-level highlight spans for the paired del/add lines (W34).
    const segs = wordDiff ? pairWordDiffs(hunk.lines) : null;

    for (const line of hunk.lines) {
      if (emitted >= max) {
        truncated = true;
        break outer;
      }
      const g = gutterFor(line);
      const row = el('div', `diff-row ${line.kind}`);
      const oldG = el('span', 'diff-gutter old');
      oldG.textContent = g.old;
      const newG = el('span', 'diff-gutter new');
      newG.textContent = g.new;
      const code = el('span', 'diff-code');
      const sign = signFor(line);
      const lineSegs = segs?.get(line);
      const txtHtml = lineSegs ? renderSegments(lineSegs) : escapeHtml(line.text) || '&nbsp;';
      // Render the sign + content; empty content stays selectable.
      code.innerHTML =
        `<span class="sign">${sign === ' ' ? '&nbsp;' : sign}</span>` +
        `<span class="txt">${txtHtml}</span>` +
        (line.noNewline ? `<span class="nonl" title="No newline at end of file">\u29B0</span>` : '');
      row.append(oldG, newG, code);
      table.appendChild(row);
      emitted++;
    }
  }

  wrap.appendChild(table);

  if (truncated) {
    const note = el('div', 'diff-empty');
    note.textContent = `Diff truncated at ${max} lines.`;
    wrap.appendChild(note);
  }

  return wrap;
}

/**
 * Pair each contiguous run of deleted lines with the run of added lines
 * that immediately follows it and compute a word-level diff per matched
 * row (W34). A block of N deletions followed by N additions is the common
 * "edited N lines" shape; we zip them index-for-index and only highlight a
 * pair when it's similar enough (shouldInlineDiff) to be a true edit rather
 * than an unrelated replace. Returns a map from DiffLine -> its segments;
 * lines without a useful pair are absent (rendered plain).
 */
function pairWordDiffs(lines: DiffLine[]): Map<DiffLine, DiffSegment[]> {
  const out = new Map<DiffLine, DiffSegment[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    // Gather the run of deletions, then the run of additions after it.
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    // Zip the overlapping rows; only annotate genuine edits.
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const oldLine = dels[k];
      const newLine = adds[k];
      if (!shouldInlineDiff(oldLine.text, newLine.text)) continue;
      const d = inlineDiff(oldLine.text, newLine.text);
      out.set(oldLine, d.old);
      out.set(newLine, d.new);
    }
  }
  return out;
}

/** Render coalesced word-diff segments as escaped HTML with <mark> spans. */
function renderSegments(segs: DiffSegment[]): string {
  if (segs.length === 0) return '&nbsp;';
  return segs
    .map(s => {
      const html = escapeHtml(s.text);
      return s.changed ? `<mark class="word">${html}</mark>` : html;
    })
    .join('');
}

/**
 * Side-by-side (split) layout (W38). Each hunk's lines are paired into
 * old | new rows by the pure splitHunkRows helper; word-level highlights
 * (W34) carry into both columns so a one-token edit lights up on each side.
 * A blank cell (no line on that side) reads as an inert filler so the two
 * columns stay vertically aligned.
 */
function renderFileDiffSplit(file: FileDiff, opts: DiffViewOptions): HTMLElement {
  const wrap = el('div', 'diff-view split');
  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
  const wordDiff = opts.wordDiff ?? true;
  const table = el('div', 'diff-split-table');
  table.setAttribute('role', 'table');
  let emitted = 0;
  let truncated = false;

  outer: for (const hunk of file.hunks) {
    const head = el('div', 'diff-split-row hunk');
    head.innerHTML =
      `<span class="diff-split-side hunk-head" role="cell">` +
      `${escapeHtml(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)}` +
      (hunk.section ? ` ${escapeHtml(hunk.section)}` : '') +
      `</span>`;
    table.appendChild(head);

    const segs = wordDiff ? pairWordDiffs(hunk.lines) : null;
    const rows = splitHunkRows(hunk.lines);

    for (const row of rows) {
      if (emitted >= max) {
        truncated = true;
        break outer;
      }
      table.appendChild(splitRow(row, segs));
      emitted++;
    }
  }

  wrap.appendChild(table);
  if (truncated) {
    const note = el('div', 'diff-empty');
    note.textContent = `Diff truncated at ${max} lines.`;
    wrap.appendChild(note);
  }
  return wrap;
}

/** Build one side-by-side row: [old gutter | old code] [new gutter | new code]. */
function splitRow(row: SplitRow, segs: Map<DiffLine, DiffSegment[]> | null): HTMLElement {
  const tr = el('div', 'diff-split-row');
  tr.append(splitCell(row.old, 'old', segs), splitCell(row.new, 'new', segs));
  return tr;
}

/** One side of a split row. A null line renders as an inert filler cell. */
function splitCell(line: DiffLine | null, side: 'old' | 'new', segs: Map<DiffLine, DiffSegment[]> | null): HTMLElement {
  if (!line) {
    const filler = el('span', `diff-split-side ${side} filler`);
    filler.setAttribute('role', 'cell');
    filler.innerHTML = `<span class="diff-gutter"></span><span class="diff-code"></span>`;
    return filler;
  }
  const cell = el('span', `diff-split-side ${side} ${line.kind}`);
  cell.setAttribute('role', 'cell');
  const g = gutterFor(line);
  const num = side === 'old' ? g.old : g.new;
  const lineSegs = segs?.get(line);
  const txtHtml = lineSegs ? renderSegments(lineSegs) : escapeHtml(line.text) || '&nbsp;';
  const sign = signFor(line);
  cell.innerHTML =
    `<span class="diff-gutter">${num}</span>` +
    `<span class="diff-code">` +
    `<span class="sign">${sign === ' ' ? '&nbsp;' : sign}</span>` +
    `<span class="txt">${txtHtml}</span>` +
    (line.noNewline ? `<span class="nonl" title="No newline at end of file">\u29B0</span>` : '') +
    `</span>`;
  return cell;
}
