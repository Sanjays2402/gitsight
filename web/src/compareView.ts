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
import { compareGlyph, compareLabel, compareChurn, splitComparePath, sanitizeRef, filterCompareCommits, stepMatch } from './compareFormat';
import { renderFileDiff } from './diffView';
import type { FileDiffResult } from './data';
import { filterFileChanges } from './fileFilter';

/** Below this many files the compare path-filter box isn't worth it (W50). */
const FILE_FILTER_THRESHOLD = 8;

/**
 * Above this many commits across BOTH columns, the compare commit-list filter
 * box (W54) is worth showing so you can find a specific commit in a wide
 * ahead/behind range.
 */
const COMMIT_FILTER_THRESHOLD = 10;

export interface CompareViewOptions {
  base: string;
  head: string;
  /** Submit a new ref pair (drives a fresh /api/compare load). */
  onCompare: (base: string, head: string) => void;
  /** Fetch a single file's parsed diff for the head ref (W7). */
  loadDiff?: (rev: string, path: string) => Promise<FileDiffResult>;
  /** Current diff layout mode (W38; per-surface W46): split or unified. */
  diffView?: () => 'split' | 'unified';
  /** Toggle this surface's diff layout (W46); re-renders in the new mode. */
  onToggleLayout?: () => void;
  /** Open a commit in the detail panel (W6 reuse). */
  onOpenCommit?: (sha: string) => void;
  /** Copy a sha to the clipboard. */
  onCopySha?: (sha: string) => void;
  /** Copy a shareable deep link to this comparison (W24). */
  onShareLink?: () => void;
  /** Copy the whole comparison as a unified-diff patch (W52). */
  onCopyPatch?: () => void;
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
  // Above a threshold a shared filter box (W54) narrows both columns by
  // subject/author/sha so a specific commit is findable in a wide range.
  const totalCommits = cmp.ahead.length + cmp.behind.length;
  const cols = el('div', 'compare-cols');
  // W70: the current match list (ahead-then-behind order) + the focused index,
  // so Down/Up can step through matches and Enter opens the focused one.
  let matches: CompareCommit[] = [];
  let focusIdx = -1;
  const applyFocusRing = () => {
    cols.querySelectorAll('.compare-commit.kbd-focus').forEach(x => x.classList.remove('kbd-focus'));
    if (focusIdx < 0 || focusIdx >= matches.length) return;
    const sha = matches[focusIdx].sha;
    const row = cols.querySelector<HTMLElement>(`.compare-commit[data-compare-sha="${sha}"]`);
    if (row) {
      row.classList.add('kbd-focus');
      row.scrollIntoView({ block: 'nearest' });
    }
  };
  const renderCols = (query: string) => {
    const ahead = filterCompareCommits(cmp.ahead, query);
    const behind = filterCompareCommits(cmp.behind, query);
    // The flat match list mirrors the firstCompareMatch order (ahead first).
    matches = [...ahead, ...behind];
    focusIdx = -1;
    cols.replaceChildren(
      commitColumn('Only in ' + cmp.head, ahead, cmp.ahead.length, 'ahead', opts),
      commitColumn('Only in ' + cmp.base, behind, cmp.behind.length, 'behind', opts),
    );
  };
  renderCols('');
  if (totalCommits >= COMMIT_FILTER_THRESHOLD) {
    result.appendChild(
      buildCommitFilter(
        totalCommits,
        renderCols,
        () => {
          // W62/W70: Enter opens the focused match if one is ringed, else the
          // first match (ahead column first), so a search resolves to an action.
          const target = focusIdx >= 0 && focusIdx < matches.length ? matches[focusIdx] : matches[0];
          if (target && opts.onOpenCommit) opts.onOpenCommit(target.sha);
        },
        // W70: Down/Up step the focus ring through the current match list.
        delta => {
          focusIdx = stepMatch(matches.length, focusIdx, delta);
          applyFocusRing();
        },
      ),
    );
  }
  result.appendChild(cols);

  // File list with lazy diffs.
  if (cmp.files.length > 0) {
    const filesWrap = el('div', 'compare-files');
    const filesHead = el('div', 'compare-files-head');
    const filesLabel = el('span', 'compare-files-label');
    filesLabel.textContent = `${cmp.filesChanged} ${cmp.filesChanged === 1 ? 'file' : 'files'} changed`;
    filesHead.appendChild(filesLabel);
    // Header actions sit at the right: a per-surface diff layout toggle (W46)
    // and a "Copy as patch" button (W52).
    const headActions = el('div', 'compare-files-actions');
    // Per-surface diff layout toggle (W46): Split vs unified, remembered for
    // the compare surface independently of the detail panel.
    if (opts.onToggleLayout && opts.diffView) {
      const split = opts.diffView() === 'split';
      const splitBtn = el('button', 'diff-opt' + (split ? ' on' : ''));
      splitBtn.type = 'button';
      splitBtn.textContent = 'Split';
      splitBtn.title = 'Side-by-side (old | new) diff layout for this view';
      splitBtn.setAttribute('aria-pressed', String(split));
      splitBtn.addEventListener('click', () => opts.onToggleLayout!());
      headActions.appendChild(splitBtn);
    }
    // Copy the whole comparison as a unified-diff patch (W52). Only shown
    // when there are textual files to assemble + the host wired the handler.
    if (opts.onCopyPatch) {
      const patchBtn = el('button', 'compare-patch-btn');
      patchBtn.type = 'button';
      patchBtn.innerHTML = `${icons.copy}<span>Copy as patch</span>`;
      patchBtn.title = 'Copy the changed files as a unified-diff patch';
      patchBtn.addEventListener('click', () => opts.onCopyPatch!());
      headActions.appendChild(patchBtn);
    }
    if (headActions.childElementCount > 0) filesHead.appendChild(headActions);
    filesWrap.appendChild(filesHead);
    // Path-substring filter (W50): narrow a big changed-file list. Skipped
    // below the threshold. Re-renders the rows host with the matching subset.
    const rowsHost = el('div', 'compare-files-list');
    if (cmp.files.length >= FILE_FILTER_THRESHOLD) {
      filesWrap.appendChild(buildFileFilter(cmp.files, rowsHost, cmp.head, opts));
    }
    renderCompareFileRows(rowsHost, cmp.files, cmp.head, opts);
    filesWrap.appendChild(rowsHost);
    result.appendChild(filesWrap);
  }

  return result;
}

/**
 * Path-filter box for the compare file list (W50). Mirrors the detail
 * panel's filter: live re-render of the matching subset + an "N of M" count
 * when rows are hidden. Pure matching lives in fileFilter.filterFileChanges.
 */
function buildFileFilter(
  files: CompareFile[],
  rowsHost: HTMLElement,
  headRev: string,
  opts: CompareViewOptions,
): HTMLElement {
  const wrap = el('div', 'file-filter');
  const input = el('input', 'file-filter-input') as HTMLInputElement;
  input.type = 'search';
  input.placeholder = `Filter ${files.length} files…`;
  input.setAttribute('aria-label', 'Filter changed files by path');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  const count = el('span', 'file-filter-count');
  input.addEventListener('input', () => {
    const matches = filterFileChanges(files, input.value);
    renderCompareFileRows(rowsHost, matches, headRev, opts);
    count.textContent = matches.length === files.length ? '' : `${matches.length} of ${files.length}`;
  });
  wrap.append(input, count);
  return wrap;
}

/** (Re)render the compare file rows into a host, replacing prior contents. */
function renderCompareFileRows(
  host: HTMLElement,
  files: CompareFile[],
  headRev: string,
  opts: CompareViewOptions,
): void {
  if (files.length === 0) {
    host.replaceChildren(el('div', 'file-filter-empty', 'No files match.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of files) frag.appendChild(fileEntry(f, headRev, opts));
  host.replaceChildren(frag);
}

/**
 * Shared filter box above the two commit columns (W54). Narrows both the
 * ahead and behind lists by a subject/author/sha substring so a specific
 * commit is findable in a wide range. Pure matching lives in
 * compareFormat.filterCompareCommits; this only owns the input + re-render.
 *
 * W62: pressing Enter resolves the query to an action — `onEnter` is fired so
 * the host opens the focused/first matching commit's detail.
 * W70: Down/Up step a focus ring through the match list — `onStep(delta)` is
 * fired so the host moves the ring; Enter then opens the focused one.
 */
function buildCommitFilter(
  total: number,
  render: (query: string) => void,
  onEnter: () => void,
  onStep: (delta: number) => void,
): HTMLElement {
  const wrap = el('div', 'compare-commit-filter');
  const input = el('input', 'compare-commit-filter-input') as HTMLInputElement;
  input.type = 'search';
  input.placeholder = `Filter ${total} commits by subject, author, or sha\u2026`;
  input.setAttribute('aria-label', 'Filter compare commits');
  input.title = 'Up/Down step matches, Enter opens the focused one';
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => render(input.value));
  // Enter -> open the focused/first match (W62/W70). Down/Up -> step the ring
  // (W70). preventDefault stops a form-ish submit + caret movement in the box.
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onStep(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      onStep(-1);
    }
  });
  wrap.appendChild(input);
  return wrap;
}

function commitColumn(
  title: string,
  commits: CompareCommit[],
  total: number,
  kind: 'ahead' | 'behind',
  opts: CompareViewOptions,
): HTMLElement {
  const col = el('div', `compare-col ${kind}`);
  const head = el('div', 'compare-col-head');
  // Show "N of M" when the filter has hidden some rows, else the plain count.
  const countText = commits.length === total ? String(total) : `${commits.length} of ${total}`;
  head.innerHTML = `<span>${escapeHtml(title)}</span><span class="compare-col-count">${countText}</span>`;
  col.appendChild(head);

  if (total === 0) {
    const none = el('div', 'compare-col-empty', 'No commits.');
    col.appendChild(none);
    return col;
  }
  if (commits.length === 0) {
    const none = el('div', 'compare-col-empty', 'No commits match.');
    col.appendChild(none);
    return col;
  }

  const list = el('div', 'compare-commit-list');
  for (const c of commits) {
    const row = el(opts.onOpenCommit ? 'button' : 'div', 'compare-commit');
    // W70: address rows by sha so keyboard stepping can ring the focused one.
    row.dataset.compareSha = c.sha;
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
