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
import type { FileDiff } from '@shared/diffParse';
import { gutterFor, signFor } from './diffFormat';

export { gutterFor, signFor, diffHeaderStat } from './diffFormat';

export interface DiffViewOptions {
  /** Soft cap on rendered lines; above it, show a truncation note. */
  maxLines?: number;
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

  const max = opts.maxLines ?? DEFAULT_MAX_LINES;
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
      // Render the sign + content; empty content stays selectable.
      code.innerHTML =
        `<span class="sign">${sign === ' ' ? '&nbsp;' : sign}</span>` +
        `<span class="txt">${escapeHtml(line.text) || '&nbsp;'}</span>` +
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
