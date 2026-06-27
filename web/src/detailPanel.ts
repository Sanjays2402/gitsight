/**
 * Commit-detail panel (W6).
 *
 * A slide-in panel on the right edge that shows the full commit: subject,
 * body, author/committer, parents, refs, and a per-file change list with
 * status glyphs + churn. Fed by /api/commit/<sha> via loadCommitDetail.
 *
 * Pure formatting lives in detailFormat.ts (unit-tested); this module
 * owns the DOM + the open/close lifecycle. The panel reuses the app's
 * design tokens — monochrome chrome, hairline borders, one accent.
 */

import { el } from './format';
import { timeAgo, absoluteTime } from './format';
import { icons } from './icons';
import { authorColor } from '@shared/graphPalette';
import { escapeHtml } from '@shared/graphCore';
import type { CommitDetail, CommitFileChange } from '@shared/commitDetail';
import {
  statusGlyph,
  statusLabel,
  churnParts,
  splitPath,
  diffstatSummary,
} from './detailFormat';
import { renderFileDiff } from './diffView';
import type { FileDiffResult } from './data';
import { filterFileChanges } from './fileFilter';

/** Below this many files the filter box isn't worth the clutter (W50). */
const FILE_FILTER_THRESHOLD = 8;

export interface DetailPanelHandlers {
  /** Fetch a commit's detail. Returns ok/detail or an error. */
  load: (sha: string) => Promise<
    { ok: true; detail: CommitDetail } | { ok: false; error: string; offline: boolean }
  >;
  /** Fetch a single file's parsed diff for a commit (W7). */
  loadDiff?: (rev: string, path: string) => Promise<FileDiffResult>;
  /** Copy a sha to the clipboard. */
  onCopySha?: (sha: string) => void;
  /** Navigate the graph selection to a parent sha (W7 hook-ready). */
  onOpenSha?: (sha: string) => void;
  /** "Compare from here" — open the Compare view with this commit as base (W24). */
  onCompareFrom?: (sha: string) => void;
  /** Copy a #commit/<sha> permalink to the focused commit (W27). */
  onCopyLink?: (sha: string) => void;
  /** Fired after the panel opens a commit (sha) — host syncs the URL (W27). */
  onOpened?: (sha: string) => void;
  /** Fired when the panel closes — host clears the permalink hash (W27). */
  onClosed?: () => void;
  /** Diff display settings + toggles (W31; split added W38). When present,
   *  the files header carries wrap + ignore-whitespace + split controls. */
  diffSettings?: {
    get: () => { wrap: boolean; ignoreWhitespace: boolean; split: boolean };
    toggleWrap: () => void;
    toggleIgnoreWhitespace: () => void;
    toggleSplit: () => void;
  };
}

/**
 * Owns a single panel element appended to <body>. Call `open(sha)` to
 * fetch + show; `close()` to hide. Re-entrant: a second open() aborts the
 * first fetch.
 */
export class CommitDetailPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private handlers: DetailPanelHandlers;
  private controller: AbortController | null = null;
  private openSha: string | null = null;

  constructor(handlers: DetailPanelHandlers) {
    this.handlers = handlers;
    this.root = el('aside', 'detail-panel');
    this.root.setAttribute('role', 'complementary');
    this.root.setAttribute('aria-label', 'Commit detail');
    this.root.hidden = true;

    const header = el('div', 'detail-head');
    const title = el('div', 'detail-title', 'Commit');
    const close = el('button', 'btn icon-only');
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close commit detail');
    close.innerHTML = icons.close;
    close.addEventListener('click', () => this.close());
    header.append(title, close);

    this.body = el('div', 'detail-body');
    this.root.append(header, this.body);
    document.body.appendChild(this.root);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  currentSha(): string | null {
    return this.openSha;
  }

  async open(sha: string): Promise<void> {
    this.openSha = sha;
    this.root.hidden = false;
    this.root.classList.add('show');
    this.showLoading(sha);
    // Let the host reflect the focused commit in the URL (W27 permalink).
    this.handlers.onOpened?.(sha);

    this.controller?.abort();
    this.controller = new AbortController();
    const result = await this.handlers.load(sha);
    // A newer open() may have superseded this one.
    if (this.openSha !== sha) return;

    if (result.ok) {
      this.render(result.detail);
    } else {
      this.showError(result.error);
    }
  }

  close(): void {
    const wasOpen = !this.root.hidden;
    this.controller?.abort();
    this.controller = null;
    this.openSha = null;
    this.root.classList.remove('show');
    this.root.hidden = true;
    if (wasOpen) this.handlers.onClosed?.();
  }

  private showLoading(sha: string): void {
    this.body.replaceChildren();
    const s = el('div', 'detail-state');
    s.innerHTML = `<span class="spinner"></span><p>Reading ${escapeHtml(sha.slice(0, 9))}…</p>`;
    this.body.appendChild(s);
  }

  private showError(message: string): void {
    this.body.replaceChildren();
    const s = el('div', 'detail-state error');
    s.innerHTML =
      `<span class="glyph">${icons.warn}</span>` +
      `<h3>Could not load commit</h3>` +
      `<p>${escapeHtml(message)}</p>`;
    this.body.appendChild(s);
  }

  private render(d: CommitDetail): void {
    this.body.replaceChildren();

    // Subject + sha chip.
    const subject = el('h2', 'detail-subject');
    subject.textContent = d.subject;
    this.body.appendChild(subject);

    // Identity + sha row.
    const ident = el('div', 'detail-ident');
    const authorSafe = escapeHtml(d.author);
    ident.innerHTML =
      `<span class="who" style="color:${authorColor(d.author)}" title="${escapeHtml(d.email)}">${authorSafe}</span>` +
      `<span class="when" title="${escapeHtml(absoluteTime(d.authorDate))}">${escapeHtml(timeAgo(d.authorDate))}</span>`;
    const shaChip = el('button', 'detail-sha');
    shaChip.textContent = d.shortSha;
    shaChip.title = `Copy ${d.sha}`;
    shaChip.addEventListener('click', () => this.handlers.onCopySha?.(d.sha));
    ident.appendChild(shaChip);
    this.body.appendChild(ident);

    // Quick actions (W24/W27): "Compare from here" sets this commit as the
    // Compare view's base ref; "Copy link" yields a #commit/<sha> permalink.
    // Each is only shown when the host wires its handler.
    if (this.handlers.onCompareFrom || this.handlers.onCopyLink) {
      const actions = el('div', 'detail-actions');
      if (this.handlers.onCompareFrom) {
        const cmp = el('button', 'detail-action');
        cmp.innerHTML = `${icons.gitCompare}<span>Compare from here</span>`;
        cmp.title = 'Compare this commit against HEAD';
        cmp.addEventListener('click', () => this.handlers.onCompareFrom!(d.sha));
        actions.appendChild(cmp);
      }
      if (this.handlers.onCopyLink) {
        const link = el('button', 'detail-action');
        link.innerHTML = `${icons.link}<span>Copy link</span>`;
        link.title = 'Copy a permalink to this commit';
        link.addEventListener('click', () => this.handlers.onCopyLink!(d.sha));
        actions.appendChild(link);
      }
      this.body.appendChild(actions);
    }

    // Committer line (only when it differs from the author).
    if (d.committer && (d.committer !== d.author || d.commitDate !== d.authorDate)) {
      const c = el('div', 'detail-committer');
      c.textContent = `committed by ${d.committer} ${timeAgo(d.commitDate)}`;
      c.title = absoluteTime(d.commitDate);
      this.body.appendChild(c);
    }

    // Refs.
    if (d.refs.length) {
      const refs = el('div', 'detail-refs');
      refs.innerHTML = d.refs
        .map(r => `<span class="ref">${escapeHtml(r.replace(/^tag: /, ''))}</span>`)
        .join('');
      this.body.appendChild(refs);
    }

    // Body paragraph.
    if (d.body.trim()) {
      const bodyEl = el('pre', 'detail-message');
      bodyEl.textContent = d.body;
      this.body.appendChild(bodyEl);
    }

    // Parents.
    if (d.parents.length) {
      const par = el('div', 'detail-parents');
      const label = el('span', 'label', d.parents.length > 1 ? 'parents' : 'parent');
      par.appendChild(label);
      for (const p of d.parents) {
        const chip = el('button', 'parent-chip');
        chip.textContent = p.slice(0, 7);
        chip.title = `Show ${p}`;
        chip.addEventListener('click', () => this.handlers.onOpenSha?.(p));
        par.appendChild(chip);
      }
      this.body.appendChild(par);
    }

    // File list.
    const filesWrap = el('div', 'detail-files');
    const filesHead = el('div', 'files-head');
    const filesLabel = el('span', 'files-head-label');
    filesLabel.textContent = diffstatSummary(d.filesChanged, d.insertions, d.deletions);
    filesHead.appendChild(filesLabel);

    // Diff display toggles (W31): wrap + ignore-whitespace. Toggling flips
    // the host store, which persists + (for whitespace) re-fetches.
    const ds = this.handlers.diffSettings;
    if (ds) {
      const cur = ds.get();
      const opts = el('span', 'diff-opts');
      const wrapBtn = el('button', 'diff-opt' + (cur.wrap ? ' on' : ''));
      wrapBtn.type = 'button';
      wrapBtn.textContent = 'Wrap';
      wrapBtn.title = 'Soft-wrap long diff lines';
      wrapBtn.setAttribute('aria-pressed', String(cur.wrap));
      wrapBtn.addEventListener('click', e => {
        e.stopPropagation();
        ds.toggleWrap();
        wrapBtn.classList.toggle('on');
        wrapBtn.setAttribute('aria-pressed', String(ds.get().wrap));
      });
      const wsBtn = el('button', 'diff-opt' + (cur.ignoreWhitespace ? ' on' : ''));
      wsBtn.type = 'button';
      wsBtn.textContent = 'Ignore whitespace';
      wsBtn.title = 'Hide whitespace-only changes (git -w)';
      wsBtn.setAttribute('aria-pressed', String(cur.ignoreWhitespace));
      wsBtn.addEventListener('click', e => {
        e.stopPropagation();
        ds.toggleIgnoreWhitespace();
      });
      // Split / unified layout toggle (W38).
      const splitBtn = el('button', 'diff-opt' + (cur.split ? ' on' : ''));
      splitBtn.type = 'button';
      splitBtn.textContent = 'Split';
      splitBtn.title = 'Side-by-side (old | new) diff layout';
      splitBtn.setAttribute('aria-pressed', String(cur.split));
      splitBtn.addEventListener('click', e => {
        e.stopPropagation();
        ds.toggleSplit();
      });
      opts.append(wrapBtn, wsBtn, splitBtn);
      filesHead.appendChild(opts);
    }
    filesWrap.appendChild(filesHead);

    // Path-substring filter (W50): on commits that touch many files, a small
    // box narrows the list. Below the threshold it's just clutter, so skip it.
    const rowsHost = el('div', 'detail-files-list');
    if (d.files.length >= FILE_FILTER_THRESHOLD) {
      filesWrap.appendChild(this.fileFilter(d, rowsHost));
    }
    this.renderFileRows(rowsHost, d, d.files);
    filesWrap.appendChild(rowsHost);
    this.body.appendChild(filesWrap);
  }

  /**
   * Build the path-filter box (W50). Filtering re-renders the rows host with
   * the matching subset; an empty query restores the full list. A live count
   * shows "N of M" so it's clear when rows are hidden.
   */
  private fileFilter(d: CommitDetail, rowsHost: HTMLElement): HTMLElement {
    const wrap = el('div', 'file-filter');
    const input = el('input', 'file-filter-input') as HTMLInputElement;
    input.type = 'search';
    input.placeholder = `Filter ${d.files.length} files…`;
    input.setAttribute('aria-label', 'Filter changed files by path');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    const count = el('span', 'file-filter-count');
    count.textContent = '';
    input.addEventListener('input', () => {
      const matches = filterFileChanges(d.files, input.value);
      this.renderFileRows(rowsHost, d, matches);
      count.textContent =
        matches.length === d.files.length ? '' : `${matches.length} of ${d.files.length}`;
    });
    wrap.append(input, count);
    return wrap;
  }

  /** (Re)render the file rows into a host, replacing any prior contents. */
  private renderFileRows(host: HTMLElement, d: CommitDetail, files: CommitFileChange[]): void {
    if (files.length === 0) {
      const empty = el('div', 'file-filter-empty', 'No files match.');
      host.replaceChildren(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of files) frag.appendChild(this.fileEntry(f, d));
    host.replaceChildren(frag);
  }

  /** A file row plus a collapsible diff region beneath it (W7). */
  private fileEntry(f: CommitFileChange, d: CommitDetail): HTMLElement {
    const entry = el('div', 'file-entry');
    const row = this.fileRow(f);
    const diffSlot = el('div', 'file-diff-slot');
    diffSlot.hidden = true;
    let loaded = false;
    let loading = false;

    const collapse = () => {
      diffSlot.hidden = true;
      row.classList.remove('expanded');
    };
    const expand = async () => {
      row.classList.add('expanded');
      diffSlot.hidden = false;
      if (loaded || loading) return;
      // Binary / no loader → static note, no fetch.
      if (f.binary || !this.handlers.loadDiff) {
        diffSlot.replaceChildren(this.diffNote(f.binary ? 'Binary file — no textual diff.' : 'Diff unavailable.'));
        loaded = true;
        return;
      }
      loading = true;
      diffSlot.replaceChildren(this.diffLoading());
      const result = await this.handlers.loadDiff(d.sha, f.path);
      loading = false;
      // The panel may have navigated away while we awaited.
      if (this.openSha !== d.sha) return;
      if (result.ok && result.diff.file) {
        diffSlot.replaceChildren(renderFileDiff(result.diff.file, { view: this.diffView() }));
      } else if (result.ok) {
        diffSlot.replaceChildren(this.diffNote('No diff for this path.'));
      } else {
        diffSlot.replaceChildren(this.diffNote(result.error));
      }
      loaded = true;
    };

    row.addEventListener('click', () => {
      if (diffSlot.hidden) void expand();
      else collapse();
    });

    entry.append(row, diffSlot);
    return entry;
  }

  private diffLoading(): HTMLElement {
    const s = el('div', 'diff-loading');
    s.innerHTML = `<span class="spinner small"></span><span>Loading diff…</span>`;
    return s;
  }

  /** The current diff layout mode (W38): split when enabled, else unified. */
  private diffView(): 'split' | 'unified' {
    return this.handlers.diffSettings?.get().split ? 'split' : 'unified';
  }

  private diffNote(msg: string): HTMLElement {
    const n = el('div', 'diff-empty');
    n.textContent = msg;
    return n;
  }

  private fileRow(f: CommitFileChange): HTMLElement {
    const row = el('button', `file-row status-${f.status}`);
    row.setAttribute('aria-label', `${statusLabel(f.status)}: ${f.path}`);

    const glyph = el('span', 'file-glyph');
    glyph.textContent = statusGlyph(f.status);
    glyph.title = statusLabel(f.status);

    const name = el('span', 'file-name');
    const { dir, name: base } = splitPath(f.path);
    if (f.status === 'renamed' && f.oldPath) {
      const od = splitPath(f.oldPath);
      name.innerHTML =
        `<span class="dir">${escapeHtml(od.dir)}</span><span class="old">${escapeHtml(od.name)}</span>` +
        `<span class="arrow">${icons.arrowRight}</span>` +
        `<span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>`;
    } else {
      name.innerHTML = `<span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>`;
    }

    const churn = el('span', 'file-churn');
    const parts = churnParts(f);
    if (parts.binary) {
      churn.innerHTML = `<span class="bin">binary</span>`;
    } else {
      const segs: string[] = [];
      if (parts.insertions > 0) segs.push(`<span class="add">+${parts.insertions}</span>`);
      if (parts.deletions > 0) segs.push(`<span class="del">-${parts.deletions}</span>`);
      churn.innerHTML = segs.join(' ') || `<span class="zero">0</span>`;
    }

    row.append(glyph, name, churn);
    return row;
  }
}
