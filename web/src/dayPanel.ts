/**
 * Activity day drill-down panel (W22).
 *
 * A slide-in panel (left edge — the detail panel owns the right) that lists
 * the commits made on one author-local day, opened by clicking a populated
 * cell in the Activity calendar. Each row shows the subject, author (in
 * their graph colour), short sha, and time; clicking a row opens the full
 * commit detail (reusing the W6 panel). A "View in graph" action drops to
 * the graph filtered to that day.
 *
 * Fed by /api/day via loadDay. Pure formatting lives in dayFormat.ts
 * (unit-tested); this module owns the DOM + open/close lifecycle.
 */

import { el } from './format';
import { timeAgo, absoluteTime } from './format';
import { icons } from './icons';
import { authorColor } from '@shared/graphPalette';
import { escapeHtml } from '@shared/graphCore';
import type { GraphSnapshotCommit } from '@shared/graphSnapshot';
import { formatDayHeading, commitCountLabel, dayAuthorTally } from './dayFormat';
import type { DayResult } from './data';

export interface DayPanelHandlers {
  /** Fetch one day's commits. */
  load: (date: string) => Promise<DayResult>;
  /** Open the full commit detail for a sha (reuses W6). */
  onOpenCommit: (sha: string) => void;
  /** Drop to the graph filtered to this day. */
  onViewInGraph: (date: string) => void;
  /** Copy a sha to the clipboard. */
  onCopySha?: (sha: string) => void;
  /** Fired after the panel opens for a date (W79) — host syncs the deep link. */
  onOpened?: (date: string) => void;
  /** Fired after the panel closes (W79) — host clears the deep link. */
  onClosed?: () => void;
  /**
   * Whether this panel may handle an Escape keypress (W84). When a higher-
   * priority overlay (command palette, keyboard-help) is open, it owns Escape,
   * so the day panel must NOT also close on that same Esc — otherwise it would
   * silently drop its day= deep link out from under the other overlay. Absent =
   * the panel always handles Esc (its prior behaviour).
   */
  canCloseOnEsc?: () => boolean;
}

/**
 * Owns a single panel appended to <body>. `open(date)` fetches + shows;
 * `close()` hides. Re-entrant: a second open() aborts the first fetch.
 */
export class DayPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private titleEl: HTMLElement;
  private handlers: DayPanelHandlers;
  private controller: AbortController | null = null;
  private openDate: string | null = null;

  constructor(handlers: DayPanelHandlers) {
    this.handlers = handlers;
    this.root = el('aside', 'day-panel');
    this.root.setAttribute('role', 'complementary');
    this.root.setAttribute('aria-label', 'Commits on day');
    this.root.hidden = true;

    const header = el('div', 'day-head');
    this.titleEl = el('div', 'day-title', 'Day');
    const close = el('button', 'btn icon-only');
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close day panel');
    close.innerHTML = icons.close;
    close.addEventListener('click', () => this.close());
    header.append(this.titleEl, close);

    this.body = el('div', 'day-body');
    this.root.append(header, this.body);
    document.body.appendChild(this.root);

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.isOpen()) return;
      // W84: defer to a higher-priority overlay that owns Escape (palette /
      // help). Closing here on the same Esc would drop the day= deep link.
      if (this.handlers.canCloseOnEsc && !this.handlers.canCloseOnEsc()) return;
      this.close();
    });
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  currentDate(): string | null {
    return this.openDate;
  }

  async open(date: string): Promise<void> {
    this.openDate = date;
    this.root.hidden = false;
    this.root.classList.add('show');
    this.titleEl.textContent = formatDayHeading(date);
    this.showLoading();
    // W79: announce the open date so the host can sync the #activity?day= link
    // before the fetch resolves (the panel is already visible).
    this.handlers.onOpened?.(date);

    this.controller?.abort();
    this.controller = new AbortController();
    const result = await this.handlers.load(date);
    if (this.openDate !== date) return; // superseded

    if (result.ok) this.render(result.day.date, result.day.commits);
    else this.showError(result.error);
  }

  close(): void {
    const wasOpen = !this.root.hidden;
    this.controller?.abort();
    this.controller = null;
    this.openDate = null;
    this.root.classList.remove('show');
    this.root.hidden = true;
    // W79: only notify on a real close so a redundant close() (e.g. switchView
    // closing every panel) doesn't clobber another view's deep link.
    if (wasOpen) this.handlers.onClosed?.();
  }

  private showLoading(): void {
    const s = el('div', 'day-state');
    s.innerHTML = `<span class="spinner"></span><p>Reading the day's commits…</p>`;
    this.body.replaceChildren(s);
  }

  private showError(message: string): void {
    const s = el('div', 'day-state error');
    s.innerHTML =
      `<span class="glyph">${icons.warn}</span>` +
      `<h3>Could not load that day</h3>` +
      `<p>${escapeHtml(message)}</p>`;
    this.body.replaceChildren(s);
  }

  private render(date: string, commits: GraphSnapshotCommit[]): void {
    this.body.replaceChildren();

    // Subheading: count + author summary + a "view in graph" action.
    const summary = el('div', 'day-summary');
    const count = el('span', 'day-count', commitCountLabel(commits.length));
    summary.appendChild(count);
    const authors = dayAuthorTally(commits);
    if (authors.length) {
      const who = el('span', 'day-authors');
      who.textContent = authors
        .slice(0, 3)
        .map(a => `${a.name} (${a.count})`)
        .join(', ') + (authors.length > 3 ? `, +${authors.length - 3}` : '');
      summary.appendChild(who);
    }
    this.body.appendChild(summary);

    if (commits.length === 0) {
      const empty = el('div', 'day-empty', 'No commits on this day.');
      this.body.appendChild(empty);
    } else {
      const list = el('div', 'day-list');
      list.setAttribute('role', 'list');
      for (const c of commits) list.appendChild(this.commitRow(c));
      this.body.appendChild(list);
    }

    const action = el('button', 'btn day-graph-btn');
    action.innerHTML = `${icons.graph}<span>View in graph</span>`;
    action.addEventListener('click', () => {
      this.close();
      this.handlers.onViewInGraph(date);
    });
    this.body.appendChild(action);
  }

  private commitRow(c: GraphSnapshotCommit): HTMLElement {
    const row = el('button', 'day-commit');
    row.setAttribute('role', 'listitem');
    row.innerHTML =
      `<span class="day-commit-subject">${escapeHtml(c.subject)}</span>` +
      `<span class="day-commit-meta">` +
      `<span class="who" style="color:${authorColor(c.author)}">${escapeHtml(c.author)}</span>` +
      `<span class="ago" title="${escapeHtml(absoluteTime(c.date))}">${escapeHtml(timeAgo(c.date))}</span>` +
      `<span class="sha" title="Copy ${escapeHtml(c.shortSha)}">${escapeHtml(c.shortSha)}</span>` +
      `</span>`;
    const sha = row.querySelector<HTMLElement>('.sha');
    sha?.addEventListener('click', e => {
      e.stopPropagation();
      this.handlers.onCopySha?.(c.sha);
    });
    row.addEventListener('click', () => this.handlers.onOpenCommit(c.sha));
    return row;
  }
}
