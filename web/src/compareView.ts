/**
 * Range compare view (W18) — the web port of the extension's rangeDiff.
 *
 * Pick two refs (base + head) and see the symmetric difference: the
 * commits unique to each side, plus the changed-file summary for
 * `base...head` with per-file lazy unified diffs (reusing the W7
 * /api/diff endpoint + shared diff renderer). The data prep is the shared
 * `buildRangeComparison` (tested); this module owns the DOM only.
 *
 * Monochrome chrome, hairline borders, one accent — matches the rest of
 * the app. No emoji.
 */

import { el } from './format';
import { timeAgo, absoluteTime } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { authorColor } from '@shared/graphPalette';
import { compareHeadline, type RangeComparison, type CompareCommit, type CompareFile } from '@shared/rangeCompare';
import { compareGlyph, compareLabel, compareChurn, splitComparePath, sanitizeRef } from './compareFormat';
import { renderFileDiff } from './diffView';
import type { FileDiffResult } from './data';

export interface CompareViewOptions {
  base: string;
  head: string;
  /** Submit a new ref pair (drives a fresh /api/compare load). */
  onCompare: (base: string, head: string) => void;
  /** Fetch a single file's parsed diff for the head ref (W7). */
  loadDiff?: (rev: string, path: string) => Promise<FileDiffResult>;
  /** Current diff layout mode (W38): split when enabled, else unified. */
  diffView?: () => 'split' | 'unified';
  /** Open a commit in the detail panel (W6 reuse). */
  onOpenCommit?: (sha: string) => void;
  /** Copy a sha to the clipboard. */
  onCopySha?: (sha: string) => void;
  /** Copy a shareable deep link to this comparison (W24). */
  onShareLink?: () => void;
}

/**
 * Render the compare surface: the ref-pair form is always present (so the
 * user can re-compare); the result region renders below it. Pass `cmp`
 * null while loading (the caller swaps in a spinner separately).
 */
export function renderCompare(cmp: RangeComparison | null, opts: CompareViewOptions): HTMLElement {
  const wrap = el('div', 'compare');
  wrap.appendChild(buildForm(opts));
  if (cmp) wrap.appendChild(buildResult(cmp, opts));
  return wrap;
}

function buildForm(opts: CompareViewOptions): HTMLElement {
  const form = el('form', 'compare-form');

  const baseField = refField('base', 'Base', opts.base);
  const swap = el('button', 'btn icon-only compare-swap');
  swap.type = 'button';
  swap.title = 'Swap base and head';
  swap.setAttribute('aria-label', 'Swap base and head');
  swap.innerHTML = icons.swap;
  const headField = refField('head', 'Compare', opts.head);

  const submit = el('button', 'btn primary');
  submit.type = 'submit';
  submit.innerHTML = `${icons.gitCompare}<span>Compare</span>`;

  swap.addEventListener('click', () => {
    const b = baseField.input.value;
    baseField.input.value = headField.input.value;
    headField.input.value = b;
  });

  form.append(baseField.wrap, swap, headField.wrap, submit);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const base = sanitizeRef(baseField.input.value);
    const head = sanitizeRef(headField.input.value);
    if (base && head) opts.onCompare(base, head);
  });
  return form;
}

function refField(name: string, label: string, value: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('label', 'compare-field');
  const cap = el('span', 'compare-field-label', escapeHtml(label));
  const input = el('input', 'compare-ref') as HTMLInputElement;
  input.type = 'text';
  input.name = name;
  input.value = value;
  input.placeholder = name === 'base' ? 'main' : 'HEAD';
  input.setAttribute('aria-label', `${label} ref`);
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  wrap.append(cap, input);
  return { wrap, input };
}

function buildResult(cmp: RangeComparison, opts: CompareViewOptions): HTMLElement {
  const result = el('div', 'compare-result');

  // Headline summary.
  const head = el('div', 'compare-head');
  head.innerHTML =
    `<span class="compare-refs"><code>${escapeHtml(cmp.base)}</code>` +
    `<span class="compare-arrow">${icons.arrowRight}</span>` +
    `<code>${escapeHtml(cmp.head)}</code></span>` +
    `<span class="compare-summary">${escapeHtml(compareHeadline(cmp))}` +
    (cmp.insertions || cmp.deletions
      ? ` · <span class="add">+${cmp.insertions}</span> <span class="del">-${cmp.deletions}</span>`
      : '') +
    `</span>`;
  if (opts.onShareLink) {
    const share = el('button', 'btn icon-only compare-share');
    share.title = 'Copy a shareable link to this comparison';
    share.setAttribute('aria-label', 'Copy comparison link');
    share.innerHTML = icons.link;
    share.addEventListener('click', () => opts.onShareLink!());
    head.appendChild(share);
  }
  result.appendChild(head);

  if (cmp.ahead.length === 0 && cmp.behind.length === 0 && cmp.files.length === 0) {
    const empty = el('div', 'compare-empty');
    empty.innerHTML =
      `<span class="glyph">${icons.empty}</span>` +
      `<p>These refs are identical — nothing to compare.</p>`;
    result.appendChild(empty);
    return result;
  }

  // Two commit columns: ahead (what head adds) + behind (what it's missing).
  const cols = el('div', 'compare-cols');
  cols.appendChild(commitColumn('Only in ' + cmp.head, cmp.ahead, 'ahead', opts));
  cols.appendChild(commitColumn('Only in ' + cmp.base, cmp.behind, 'behind', opts));
  result.appendChild(cols);

  // File list with lazy diffs.
  if (cmp.files.length > 0) {
    const filesWrap = el('div', 'compare-files');
    const filesHead = el('div', 'compare-files-head');
    filesHead.textContent = `${cmp.filesChanged} ${cmp.filesChanged === 1 ? 'file' : 'files'} changed`;
    filesWrap.appendChild(filesHead);
    for (const f of cmp.files) filesWrap.appendChild(fileEntry(f, cmp.head, opts));
    result.appendChild(filesWrap);
  }

  return result;
}

function commitColumn(
  title: string,
  commits: CompareCommit[],
  kind: 'ahead' | 'behind',
  opts: CompareViewOptions,
): HTMLElement {
  const col = el('div', `compare-col ${kind}`);
  const head = el('div', 'compare-col-head');
  head.innerHTML = `<span>${escapeHtml(title)}</span><span class="compare-col-count">${commits.length}</span>`;
  col.appendChild(head);

  if (commits.length === 0) {
    const none = el('div', 'compare-col-empty', 'No commits.');
    col.appendChild(none);
    return col;
  }

  const list = el('div', 'compare-commit-list');
  for (const c of commits) {
    const row = el(opts.onOpenCommit ? 'button' : 'div', 'compare-commit');
    row.innerHTML =
      `<span class="compare-commit-subject">${escapeHtml(c.subject)}</span>` +
      `<span class="compare-commit-meta">` +
      `<span class="who" style="color:${authorColor(c.author)}">${escapeHtml(c.author)}</span>` +
      `<span class="ago" title="${escapeHtml(absoluteTime(c.date))}">${escapeHtml(timeAgo(c.date))}</span>` +
      `<span class="sha" title="Copy ${escapeHtml(c.shortSha)}">${escapeHtml(c.shortSha)}</span>` +
      `</span>`;
    const sha = row.querySelector<HTMLElement>('.sha');
    sha?.addEventListener('click', e => {
      e.stopPropagation();
      opts.onCopySha?.(c.sha);
    });
    if (opts.onOpenCommit) {
      row.addEventListener('click', () => opts.onOpenCommit!(c.sha));
    }
    list.appendChild(row);
  }
  col.appendChild(list);
  return col;
}

function fileEntry(f: CompareFile, headRev: string, opts: CompareViewOptions): HTMLElement {
  const entry = el('div', 'compare-file-entry');
  const row = el('button', `compare-file-row status-${f.status}`);
  row.setAttribute('aria-label', `${compareLabel(f.status)}: ${f.path}`);

  const glyph = el('span', 'file-glyph');
  glyph.textContent = compareGlyph(f.status);
  glyph.title = compareLabel(f.status);

  const name = el('span', 'file-name');
  const { dir, name: base } = splitComparePath(f.path);
  if (f.status === 'renamed' && f.oldPath) {
    const od = splitComparePath(f.oldPath);
    name.innerHTML =
      `<span class="dir">${escapeHtml(od.dir)}</span><span class="old">${escapeHtml(od.name)}</span>` +
      `<span class="arrow">${icons.arrowRight}</span>` +
      `<span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>`;
  } else {
    name.innerHTML = `<span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>`;
  }

  const churn = el('span', 'file-churn');
  const parts = compareChurn(f);
  if (parts.binary) churn.innerHTML = `<span class="bin">binary</span>`;
  else {
    const segs: string[] = [];
    if (parts.insertions > 0) segs.push(`<span class="add">+${parts.insertions}</span>`);
    if (parts.deletions > 0) segs.push(`<span class="del">-${parts.deletions}</span>`);
    churn.innerHTML = segs.join(' ') || `<span class="zero">0</span>`;
  }

  row.append(glyph, name, churn);

  const diffSlot = el('div', 'file-diff-slot');
  diffSlot.hidden = true;
  let loaded = false;
  let loading = false;

  const expand = async () => {
    row.classList.add('expanded');
    diffSlot.hidden = false;
    if (loaded || loading) return;
    if (f.binary || f.status === 'deleted' || !opts.loadDiff) {
      diffSlot.replaceChildren(diffNote(f.binary ? 'Binary file — no textual diff.' : f.status === 'deleted' ? 'File deleted in this range.' : 'Diff unavailable.'));
      loaded = true;
      return;
    }
    loading = true;
    diffSlot.replaceChildren(diffLoading());
    const result = await opts.loadDiff(headRev, f.path);
    loading = false;
    if (result.ok && result.diff.file) diffSlot.replaceChildren(renderFileDiff(result.diff.file, { view: opts.diffView?.() ?? 'unified' }));
    else if (result.ok) diffSlot.replaceChildren(diffNote('No diff for this path.'));
    else diffSlot.replaceChildren(diffNote(result.error));
    loaded = true;
  };
  const collapse = () => {
    row.classList.remove('expanded');
    diffSlot.hidden = true;
  };
  row.addEventListener('click', () => (diffSlot.hidden ? void expand() : collapse()));

  entry.append(row, diffSlot);
  return entry;
}

function diffLoading(): HTMLElement {
  const s = el('div', 'diff-loading');
  s.innerHTML = `<span class="spinner small"></span><span>Loading diff…</span>`;
  return s;
}

function diffNote(msg: string): HTMLElement {
  const n = el('div', 'diff-empty');
  n.textContent = msg;
  return n;
}
