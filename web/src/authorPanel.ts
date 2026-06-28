/**
 * Contributor detail panel (W23).
 *
 * A slide-in panel (left edge — the detail panel owns the right) opened by
 * clicking a contributor in the W14 leaderboard. Shows a per-author mini-
 * dashboard: identity, commit count + active span, a 26-week commit
 * sparkline (monochrome bars, accent fill), and the files they touch most
 * (path + commit frequency + churn). A "View commits" action drops to the
 * graph filtered to that author.
 *
 * Fed by /api/author via loadAuthor. The data prep is the shared
 * authorDetail builders (unit-tested); this module owns the DOM only.
 */

import { el } from './format';
import { timeAgo, absoluteTime } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { authorColor } from '@shared/graphPalette';
import type { AuthorSparkline, AuthorFile } from '@shared/authorDetail';
import { splitComparePath } from './compareFormat';
import type { AuthorResult } from './data';

export interface AuthorPanelHandlers {
  /** Fetch one author's detail. */
  load: (email: string) => Promise<AuthorResult>;
  /** Drop to the graph filtered to this author. */
  onViewCommits: (email: string, name: string) => void;
  /** Open the blame view for a file the author touched (W12 reuse). */
  onOpenFile?: (path: string) => void;
}

/**
 * Owns a single panel appended to <body>. `open(email, name)` fetches +
 * shows; `close()` hides. Re-entrant: a second open() aborts the first.
 */
export class AuthorPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private titleEl: HTMLElement;
  private handlers: AuthorPanelHandlers;
  private controller: AbortController | null = null;
  private openEmail: string | null = null;
  /** When true, the next render scrolls + flashes the files section (W73). */
  private focusFilesOnRender = false;

  constructor(handlers: AuthorPanelHandlers) {
    this.handlers = handlers;
    this.root = el('aside', 'author-panel');
    this.root.setAttribute('role', 'complementary');
    this.root.setAttribute('aria-label', 'Contributor detail');
    this.root.hidden = true;

    const header = el('div', 'author-head');
    this.titleEl = el('div', 'author-title', 'Contributor');
    const close = el('button', 'btn icon-only');
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close contributor detail');
    close.innerHTML = icons.close;
    close.addEventListener('click', () => this.close());
    header.append(this.titleEl, close);

    this.body = el('div', 'author-body');
    this.root.append(header, this.body);
    document.body.appendChild(this.root);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  currentEmail(): string | null {
    return this.openEmail;
  }

  async open(email: string, name: string, opts: { focusFiles?: boolean } = {}): Promise<void> {
    this.openEmail = email;
    this.focusFilesOnRender = !!opts.focusFiles;
    this.root.hidden = false;
    this.root.classList.add('show');
    this.titleEl.textContent = name || email;
    this.showLoading(name || email);

    this.controller?.abort();
    this.controller = new AbortController();
    const result = await this.handlers.load(email);
    if (this.openEmail !== email) return; // superseded

    if (result.ok) this.render(result.detail);
    else this.showError(result.error);
  }

  close(): void {
    this.controller?.abort();
    this.controller = null;
    this.openEmail = null;
    this.focusFilesOnRender = false;
    this.root.classList.remove('show');
    this.root.hidden = true;
  }

  private showLoading(who: string): void {
    const s = el('div', 'author-state');
    s.innerHTML = `<span class="spinner"></span><p>Reading ${escapeHtml(who)}'s history…</p>`;
    this.body.replaceChildren(s);
  }

  private showError(message: string): void {
    const s = el('div', 'author-state error');
    s.innerHTML =
      `<span class="glyph">${icons.warn}</span>` +
      `<h3>Could not load contributor</h3>` +
      `<p>${escapeHtml(message)}</p>`;
    this.body.replaceChildren(s);
  }

  private render(d: {
    name: string;
    email: string;
    commits: number;
    firstDate: string;
    lastDate: string;
    sparkline: AuthorSparkline;
    files: AuthorFile[];
    filesTouched: number;
  }): void {
    this.body.replaceChildren();

    // Identity card.
    const ident = el('div', 'author-ident');
    const dot = el('span', 'author-ident-dot');
    dot.style.background = authorColor(d.name);
    const idMain = el('div', 'author-ident-main');
    const nameEl = el('div', 'author-ident-name', escapeHtml(d.name));
    const emailEl = el('div', 'author-ident-email', escapeHtml(d.email));
    idMain.append(nameEl, emailEl);
    ident.append(dot, idMain);
    this.body.appendChild(ident);

    // Stat row.
    const stats = el('div', 'author-stats');
    stats.innerHTML =
      `<div class="author-stat"><span class="n">${d.commits}</span><span class="l">commits</span></div>` +
      `<div class="author-stat"><span class="n">${d.filesTouched}</span><span class="l">files touched</span></div>`;
    if (d.firstDate && d.lastDate) {
      const span = el('div', 'author-span');
      span.textContent =
        d.firstDate === d.lastDate
          ? timeAgo(d.lastDate)
          : `${timeAgo(d.firstDate)} \u2192 ${timeAgo(d.lastDate)}`;
      span.title = `${absoluteTime(d.firstDate)} \u2192 ${absoluteTime(d.lastDate)}`;
      stats.appendChild(span);
    }
    this.body.appendChild(stats);

    // Sparkline.
    this.body.appendChild(this.sparkline(d.sparkline, d.name));

    // Files.
    const filesWrap = el('div', 'author-files');
    const filesHead = el('div', 'author-files-head');
    filesHead.textContent =
      d.filesTouched > d.files.length
        ? `Top ${d.files.length} of ${d.filesTouched} files`
        : `${d.files.length} ${d.files.length === 1 ? 'file' : 'files'}`;
    filesWrap.appendChild(filesHead);
    if (d.files.length === 0) {
      filesWrap.appendChild(el('div', 'author-files-empty', 'No file changes recorded.'));
    } else {
      for (const f of d.files) filesWrap.appendChild(this.fileRow(f));
    }
    this.body.appendChild(filesWrap);

    // View-commits action.
    const action = el('button', 'btn author-graph-btn');
    action.innerHTML = `${icons.graph}<span>View commits in graph</span>`;
    action.addEventListener('click', () => {
      this.close();
      this.handlers.onViewCommits(d.email, d.name);
    });
    this.body.appendChild(action);

    // W73: when opened via a churn-bar click ("what drove this churn?"), scroll
    // the files section into view + flash it so the most-touched files — the
    // files that produced the churn — are the immediate focus. One-shot.
    if (this.focusFilesOnRender) {
      this.focusFilesOnRender = false;
      requestAnimationFrame(() => {
        filesWrap.scrollIntoView({ block: 'nearest' });
        filesWrap.classList.add('flash');
        setTimeout(() => filesWrap.classList.remove('flash'), 1200);
      });
    }
  }

  /** A 26-bar commit sparkline (monochrome track, accent bars). */
  private sparkline(sp: AuthorSparkline, name: string): HTMLElement {
    const wrap = el('div', 'author-sparkline');
    const head = el('div', 'author-sparkline-head');
    head.innerHTML =
      `<span class="l">Last ${sp.weeks} weeks</span>` +
      `<span class="n">${sp.total} commits</span>`;
    wrap.appendChild(head);

    const chart = el('div', 'author-spark-bars');
    chart.style.setProperty('--spark-accent', authorColor(name));
    const max = Math.max(1, sp.max);
    sp.bins.forEach((count, i) => {
      const bar = el('span', 'author-spark-bar');
      const pct = Math.round((count / max) * 100);
      bar.style.height = `${count === 0 ? 2 : Math.max(6, pct)}%`;
      if (count === 0) bar.classList.add('empty');
      // Week index from the end: 0 = oldest, weeks-1 = most recent.
      const weeksAgo = sp.weeks - 1 - i;
      bar.title = weeksAgo === 0 ? `this week: ${count}` : `${weeksAgo}w ago: ${count}`;
      chart.appendChild(bar);
    });
    wrap.appendChild(chart);
    return wrap;
  }

  private fileRow(f: AuthorFile): HTMLElement {
    const row = el(this.handlers.onOpenFile ? 'button' : 'div', 'author-file');
    const name = el('span', 'author-file-name');
    const { dir, name: base } = splitComparePath(f.path);
    name.innerHTML = `<span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>`;

    const freq = el('span', 'author-file-freq');
    freq.textContent = `${f.commits}\u00d7`;
    freq.title = `${f.commits} ${f.commits === 1 ? 'commit' : 'commits'} touched this file`;

    const churn = el('span', 'author-file-churn');
    const segs: string[] = [];
    if (f.insertions > 0) segs.push(`<span class="add">+${f.insertions}</span>`);
    if (f.deletions > 0) segs.push(`<span class="del">-${f.deletions}</span>`);
    churn.innerHTML = segs.join(' ') || `<span class="zero">0</span>`;

    row.append(name, freq, churn);
    if (this.handlers.onOpenFile) {
      row.setAttribute('aria-label', `Blame ${f.path}`);
      row.addEventListener('click', () => this.handlers.onOpenFile!(f.path));
    }
    return row;
  }
}
