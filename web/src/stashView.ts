/**
 * Stash visualizer view (W19) — the web port of stashVisualizer.
 *
 * Lists every stash as a card: index, branch, age, a churn summary, and a
 * per-file change list with lazy unified diffs (via /api/stash-diff + the
 * shared diff renderer). Read-only by design — the web app is a viewer
 * over a local-first data path; mutating actions (apply/pop/drop) stay in
 * the VS Code extension where the working tree lives.
 *
 * Data prep is the shared `buildStashFiles` / `parseStashList` (tested);
 * this module owns the DOM only. Monochrome chrome, no emoji.
 */

import { el } from './format';
import { timeAgo, absoluteTime } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { stashSummary, filterStashes, stashEscapeClears, type StashList, type StashEntry, type StashFile } from '@shared/stashes';
import { compareGlyph, compareLabel, compareChurn, splitComparePath } from './compareFormat';
import { renderFileDiff } from './diffView';
import type { FileDiffResult, StashActionKind } from './data';

export interface StashViewOptions {
  /** Fetch a single stash file's parsed diff (W19). */
  loadDiff?: (index: number, path: string) => Promise<FileDiffResult>;
  /**
   * Run a local-only mutation on a stash (W25). When omitted, the cards are
   * read-only (the mutating endpoint isn't enabled). The handler owns the
   * confirm step + the refresh.
   */
  onAction?: (action: StashActionKind, entry: StashEntry) => void;
  /**
   * Create a new stash (W42). When present (mutations enabled), a compact
   * create form sits above the list. The handler owns the POST + refresh.
   */
  onCreate?: (opts: { message: string; includeUntracked: boolean; keepIndex: boolean }) => void;
  /**
   * Current diff layout mode for the stash surface (W53; per-surface W46):
   * split or unified. When wired alongside `onToggleLayout`, a Split pill in
   * the list header flips it and the file diffs render in the chosen mode.
   */
  diffView?: () => 'split' | 'unified';
  /** Toggle the stash surface's diff layout (W53); re-renders in the new mode. */
  onToggleLayout?: () => void;
  /**
   * Initial filter query (W63) to pre-fill the search box with — from a
   * `#stashes?q=` deep link. When non-empty the box shows even below the
   * threshold (a shared link should always reveal its filter).
   */
  filterQuery?: string;
  /** Fired (debounced by the host) when the filter query changes (W63), so
   * the deep-link in the URL stays in sync. */
  onFilterChange?: (query: string) => void;
}

/** Render the stash list into a detached node. */
export function renderStashes(list: StashList | null, opts: StashViewOptions = {}): HTMLElement {
  const wrap = el('div', 'stashes');

  // Create form (W42) — only when the mutating endpoint is enabled.
  if (opts.onCreate) wrap.appendChild(buildCreateForm(opts.onCreate));

  if (!list || list.total === 0) {
    const empty = el('div', 'stashes-empty');
    empty.innerHTML =
      `<span class="glyph">${icons.archive}</span>` +
      `<h2>No stashes</h2>` +
      `<p>Stash working changes from the GitSight extension or <code>git stash</code>, and they'll appear here.</p>`;
    wrap.appendChild(empty);
    return wrap;
  }

  const head = el('div', 'stashes-head');
  head.innerHTML = `<span class="n">${list.total}</span><span class="l">${list.total === 1 ? 'stash' : 'stashes'}</span>`;
  // Per-surface diff layout toggle (W53): Split vs unified for the stash file
  // diffs, remembered for the stash surface independently of the detail panel
  // and compare view. Only shown when the host wires both accessors.
  if (opts.onToggleLayout && opts.diffView) {
    const split = opts.diffView() === 'split';
    const splitBtn = el('button', 'diff-opt' + (split ? ' on' : ''));
    splitBtn.type = 'button';
    splitBtn.textContent = 'Split';
    splitBtn.title = 'Side-by-side (old | new) diff layout for stash files';
    splitBtn.setAttribute('aria-pressed', String(split));
    splitBtn.addEventListener('click', () => opts.onToggleLayout!());
    head.appendChild(splitBtn);
  }
  wrap.appendChild(head);

  // Above a threshold, a message/branch filter box (W59) narrows the cards so
  // a specific WIP is findable. A deep-linked query (W63) shows the box even
  // below the threshold so a shared link always reveals its filter. Cards
  // render into a re-renderable host, pre-filtered by the initial query.
  const initialQuery = (opts.filterQuery ?? '').trim();
  const cardsHost = el('div', 'stash-cards');
  if (list.stashes.length >= STASH_FILTER_THRESHOLD || initialQuery) {
    wrap.appendChild(buildStashFilter(list.stashes, cardsHost, opts, initialQuery));
  }
  renderStashCards(cardsHost, initialQuery ? filterStashes(list.stashes, initialQuery) : list.stashes, opts);
  wrap.appendChild(cardsHost);
  return wrap;
}

/** Above this many stashes the filter box is worth showing (W59). */
const STASH_FILTER_THRESHOLD = 6;

/**
 * Message/branch filter box for the stash list (W59). Mirrors the compare /
 * file filters: a live re-render of the matching subset + an "N of M" count
 * when cards are hidden. Pure matching lives in stashes.filterStashes.
 *
 * W63: pre-fills from a deep-linked query + emits onFilterChange so the host
 * can keep the `#stashes?q=` URL in sync.
 */
function buildStashFilter(
  entries: StashEntry[],
  host: HTMLElement,
  opts: StashViewOptions,
  initialQuery = '',
): HTMLElement {
  const wrap = el('div', 'stash-filter');
  const input = el('input', 'stash-filter-input') as HTMLInputElement;
  input.type = 'search';
  input.placeholder = `Filter ${entries.length} stashes by message or branch\u2026`;
  input.setAttribute('aria-label', 'Filter stashes by message or branch');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  input.value = initialQuery;
  const count = el('span', 'stash-filter-count');
  // Visible "Clear" affordance (W132) so the W127 Esc-clear has a mouse path
  // too. Mirrors the W83 compare clear button; shown only while there's a
  // clearing-worthy query (the same stashEscapeClears guard the Esc path uses).
  const clear = el('button', 'stash-filter-clear') as HTMLButtonElement;
  clear.type = 'button';
  clear.textContent = 'Clear';
  clear.title = 'Clear the stash filter';
  const syncClear = () => {
    clear.hidden = !stashEscapeClears(input.value);
  };
  const apply = () => {
    const matches = filterStashes(entries, input.value);
    renderStashCards(host, matches, opts);
    count.textContent = matches.length === entries.length ? '' : `${matches.length} of ${entries.length}`;
    syncClear();
  };
  input.addEventListener('input', () => {
    apply();
    opts.onFilterChange?.(input.value.trim());
  });
  clear.addEventListener('click', () => {
    input.value = '';
    apply();
    opts.onFilterChange?.('');
    input.focus();
  });
  if (initialQuery) apply();
  else syncClear();
  wrap.append(input, count, clear);
  return wrap;
}

/** (Re)render the stash cards into a host, replacing prior contents (W59). */
function renderStashCards(host: HTMLElement, entries: StashEntry[], opts: StashViewOptions): void {
  if (entries.length === 0) {
    host.replaceChildren(el('div', 'stash-filter-empty', 'No stashes match.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of entries) frag.appendChild(stashCard(entry, opts));
  host.replaceChildren(frag);
}

/**
 * Compact "create stash" form (W42): a message field + two option toggles
 * (include untracked, keep index) + a Stash button. Monochrome chrome.
 */
function buildCreateForm(
  onCreate: (opts: { message: string; includeUntracked: boolean; keepIndex: boolean }) => void,
): HTMLElement {
  const form = el('form', 'stash-create');

  const input = el('input', 'stash-create-msg') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'Stash message (optional)';
  input.setAttribute('aria-label', 'Stash message');
  input.setAttribute('spellcheck', 'false');
  input.maxLength = 500;

  const mkToggle = (label: string, title: string): { wrap: HTMLElement; input: HTMLInputElement } => {
    const wrap = el('label', 'stash-create-opt');
    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    wrap.title = title;
    const text = el('span', undefined, label);
    wrap.append(box, text);
    return { wrap, input: box };
  };
  const untracked = mkToggle('Untracked', 'Include untracked files (-u)');
  const keepIndex = mkToggle('Keep staged', 'Keep staged changes in the index (--keep-index)');

  const btn = el('button', 'btn primary stash-create-btn');
  btn.type = 'submit';
  btn.innerHTML = `${icons.archive}<span>Stash</span>`;

  form.append(input, untracked.wrap, keepIndex.wrap, btn);
  form.addEventListener('submit', e => {
    e.preventDefault();
    onCreate({
      message: input.value.trim(),
      includeUntracked: untracked.input.checked,
      keepIndex: keepIndex.input.checked,
    });
  });
  return form;
}

function stashCard(entry: StashEntry, opts: StashViewOptions): HTMLElement {
  const card = el('div', 'stash-card');

  // Header: ref chip, branch, age, churn summary.
  const header = el('div', 'stash-card-head');
  const left = el('div', 'stash-card-id');
  left.innerHTML =
    `<code class="stash-ref">stash@{${entry.index}}</code>` +
    (entry.branch ? `<span class="stash-branch">${icons.branch}<span>${escapeHtml(entry.branch)}</span></span>` : '');
  const right = el('div', 'stash-card-meta');
  right.innerHTML =
    `<span class="stash-summary">${escapeHtml(stashSummary(entry))}</span>` +
    `<span class="stash-age" title="${escapeHtml(absoluteTime(entry.date))}">${escapeHtml(timeAgo(entry.date))}</span>`;
  header.append(left, right);
  card.appendChild(header);

  // Subject line (the WIP message), cleaned of the "WIP on branch:" prefix
  // when it's just the default so the real content reads first.
  const subject = el('div', 'stash-subject');
  subject.textContent = stashSubjectText(entry);
  card.appendChild(subject);

  // Local-only mutation actions (W25). Only present when the host wired a
  // handler (i.e. the companion's mutating endpoint is enabled).
  if (opts.onAction) {
    const actions = el('div', 'stash-actions');
    const mkBtn = (action: StashActionKind, label: string, danger = false) => {
      const b = el('button', `stash-action${danger ? ' danger' : ''}`);
      b.type = 'button';
      b.textContent = label;
      b.title = `${label} stash@{${entry.index}}`;
      b.addEventListener('click', () => opts.onAction!(action, entry));
      return b;
    };
    actions.append(mkBtn('apply', 'Apply'), mkBtn('pop', 'Pop'), mkBtn('drop', 'Drop', true));
    card.appendChild(actions);
  }

  // File list with lazy diffs.
  if (entry.files.length > 0) {
    const files = el('div', 'stash-files');
    for (const f of entry.files) files.appendChild(fileEntry(entry.index, f, opts));
    card.appendChild(files);
  }

  return card;
}

/** The human subject: strip a redundant default "WIP on <branch>:" prefix. */
function stashSubjectText(entry: StashEntry): string {
  const m = /^(?:WIP on|On) [^:]+:\s*(.*)$/.exec(entry.subject);
  const rest = m ? m[1].trim() : entry.subject;
  return rest || entry.subject;
}

function fileEntry(index: number, f: StashFile, opts: StashViewOptions): HTMLElement {
  const entry = el('div', 'stash-file-entry');
  const row = el('button', `stash-file-row status-${f.status}`);
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
    if (f.binary || !opts.loadDiff) {
      diffSlot.replaceChildren(diffNote(f.binary ? 'Binary file — no textual diff.' : 'Diff unavailable.'));
      loaded = true;
      return;
    }
    loading = true;
    diffSlot.replaceChildren(diffLoading());
    const result = await opts.loadDiff(index, f.path);
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
