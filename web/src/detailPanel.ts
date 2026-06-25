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

export interface DetailPanelHandlers {
  /** Fetch a commit's detail. Returns ok/detail or an error. */
  load: (sha: string) => Promise<
    { ok: true; detail: CommitDetail } | { ok: false; error: string; offline: boolean }
  >;
  /** Copy a sha to the clipboard. */
  onCopySha?: (sha: string) => void;
  /** Navigate the graph selection to a parent sha (W7 hook-ready). */
  onOpenSha?: (sha: string) => void;
  /** Called when a file row is activated (W7 wires the diff view here). */
  onOpenFile?: (file: CommitFileChange, detail: CommitDetail) => void;
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
    this.controller?.abort();
    this.controller = null;
    this.openSha = null;
    this.root.classList.remove('show');
    this.root.hidden = true;
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
    filesHead.textContent = diffstatSummary(d.filesChanged, d.insertions, d.deletions);
    filesWrap.appendChild(filesHead);

    for (const f of d.files) {
      filesWrap.appendChild(this.fileRow(f, d));
    }
    this.body.appendChild(filesWrap);
  }

  private fileRow(f: CommitFileChange, d: CommitDetail): HTMLElement {
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
    row.addEventListener('click', () => this.handlers.onOpenFile?.(f, d));
    return row;
  }
}
