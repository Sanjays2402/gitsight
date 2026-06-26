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
import { stashSummary, type StashList, type StashEntry, type StashFile } from '@shared/stashes';
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
}

/** Render the stash list into a detached node. */
export function renderStashes(list: StashList | null, opts: StashViewOptions = {}): HTMLElement {
  const wrap = el('div', 'stashes');

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
  wrap.appendChild(head);

  for (const entry of list.stashes) wrap.appendChild(stashCard(entry, opts));
  return wrap;
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
    if (result.ok && result.diff.file) diffSlot.replaceChildren(renderFileDiff(result.diff.file));
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
