/**
 * Contributor comparison panel (W35).
 *
 * A slide-in panel (like the W23 author panel) that sets two contributors
 * side by side: commits, churn, files touched, and their file overlap
 * (shared files + a Jaccard percentage). Fed by two W23 /api/author reads.
 * Pure maths live in contributorCompare.ts (tested); this module owns the
 * DOM + the open/close lifecycle. Monochrome chrome, one accent, no emoji.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { authorColor } from '@shared/graphPalette';
import {
  buildContributorComparison,
  overlapPercent,
  comparePanelKeyAction,
  type ContributorComparison,
  type AuthorSummary,
} from './contributorCompare';
import type { AuthorResult } from './data';

export interface ContributorCompareHandlers {
  /** Fetch one author's W23 detail (reused for both sides). */
  loadAuthor: (email: string) => Promise<AuthorResult>;
  /** Open the Blame view on a shared file (W12 reuse). */
  onOpenFile?: (path: string) => void;
  /** Copy a shareable deep link to this comparison (W47). */
  onShareLink?: () => void;
  /** Swap the two authors' left/right order (W89); re-opens reversed. */
  onSwap?: () => void;
  /**
   * Whether Esc may close the panel right now (W93). Mirrors the W84 day-panel
   * guard: returns false while a higher-priority overlay (the command palette
   * or the keyboard-help sheet) owns Esc, so closing one doesn't also yank the
   * comparison open behind it. Absent = always closeable.
   */
  canCloseOnEsc?: () => boolean;
}

/**
 * Owns a single panel appended to <body>. Call `open(a, b)` with two
 * {email,name} identities; `close()` to hide. Re-entrant.
 */
export class ContributorComparePanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private handlers: ContributorCompareHandlers;
  private token = 0;
  /** Bound document keydown listener (W93), live only while the panel is open. */
  private keyListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(handlers: ContributorCompareHandlers) {
    this.handlers = handlers;
    this.root = el('aside', 'cc-panel');
    this.root.setAttribute('role', 'complementary');
    this.root.setAttribute('aria-label', 'Contributor comparison');
    this.root.hidden = true;

    const header = el('div', 'cc-head');
    const title = el('div', 'cc-title', 'Compare contributors');
    const actions = el('div', 'cc-head-actions');
    // Swap order (W89): flip which author is on the left so the fixed A|B
    // layout (and the W47 shared link) reflects the order the user wants.
    if (handlers.onSwap) {
      const swap = el('button', 'btn icon-only');
      swap.title = 'Swap left and right';
      swap.setAttribute('aria-label', 'Swap comparison order');
      swap.innerHTML = icons.swap;
      swap.addEventListener('click', () => handlers.onSwap!());
      actions.appendChild(swap);
    }
    // Share link (W47): copy a #contributors?vs=a,b deep-link.
    if (handlers.onShareLink) {
      const share = el('button', 'btn icon-only');
      share.title = 'Copy a shareable link to this comparison';
      share.setAttribute('aria-label', 'Copy comparison link');
      share.innerHTML = icons.link;
      share.addEventListener('click', () => handlers.onShareLink!());
      actions.appendChild(share);
    }
    const close = el('button', 'btn icon-only');
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close comparison');
    close.innerHTML = icons.close;
    close.addEventListener('click', () => this.close());
    actions.append(close);
    header.append(title, actions);

    this.body = el('div', 'cc-body');
    this.root.append(header, this.body);
    document.body.appendChild(this.root);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  close(): void {
    this.token++;
    this.root.classList.remove('show');
    this.root.hidden = true;
    this.uninstallKeys();
  }

  async open(a: { email: string; name: string }, b: { email: string; name: string }): Promise<void> {
    this.root.hidden = false;
    this.root.classList.add('show');
    this.installKeys();
    this.showLoading(a.name, b.name);
    const mine = ++this.token;

    const [ra, rb] = await Promise.all([
      this.handlers.loadAuthor(a.email || a.name),
      this.handlers.loadAuthor(b.email || b.name),
    ]);
    if (this.token !== mine) return; // superseded

    if (!ra.ok || !rb.ok) {
      const err = (!ra.ok && ra.error) || (!rb.ok && rb.error) || 'load failed';
      this.showError(String(err));
      return;
    }
    this.render(buildContributorComparison(ra.detail, rb.detail));
  }

  /**
   * Install the document keydown listener (W93). `s` swaps the order (W89), Esc
   * closes — but Esc is gated by `canCloseOnEsc` so it doesn't fire while the
   * command palette or keyboard-help overlay owns Esc. A swap/close key is
   * swallowed (preventDefault + stopPropagation) so it doesn't also reach the
   * app-level keyboard handler. Idempotent.
   */
  private installKeys(): void {
    if (this.keyListener) return;
    this.keyListener = (e: KeyboardEvent) => {
      // Don't hijack keys while the user is typing in a field.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const action = comparePanelKeyAction(e.key);
      if (action === 'swap') {
        if (!this.handlers.onSwap) return;
        e.preventDefault();
        e.stopPropagation();
        this.handlers.onSwap();
      } else if (action === 'close') {
        // Mirror W84: defer to a higher-priority overlay's Esc when guarded.
        if (this.handlers.canCloseOnEsc && !this.handlers.canCloseOnEsc()) return;
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this.keyListener, true);
  }

  /** Remove the keydown listener (W93). Idempotent. */
  private uninstallKeys(): void {
    if (!this.keyListener) return;
    document.removeEventListener('keydown', this.keyListener, true);
    this.keyListener = null;
  }

  private showLoading(a: string, b: string): void {
    this.body.replaceChildren();
    const s = el('div', 'cc-state');
    s.innerHTML = `<span class="spinner"></span><p>Comparing ${escapeHtml(a)} &amp; ${escapeHtml(b)}…</p>`;
    this.body.appendChild(s);
  }

  private showError(message: string): void {
    this.body.replaceChildren();
    const s = el('div', 'cc-state error');
    s.innerHTML =
      `<span class="glyph">${icons.warn}</span>` +
      `<h3>Could not compare</h3>` +
      `<p>${escapeHtml(message)}</p>`;
    this.body.appendChild(s);
  }

  private render(cmp: ContributorComparison): void {
    this.body.replaceChildren();

    // Two identity headers.
    const heads = el('div', 'cc-cols');
    heads.append(this.identity(cmp.a), this.identity(cmp.b));
    this.body.appendChild(heads);

    // Metric rows: a label with both authors' values + a relative bar each.
    const metrics: Array<[string, (s: AuthorSummary) => number, (n: number) => string]> = [
      ['Commits', s => s.commits, n => n.toLocaleString()],
      ['Lines changed', s => s.churn, n => n.toLocaleString()],
      ['Insertions', s => s.insertions, n => `+${n.toLocaleString()}`],
      ['Deletions', s => s.deletions, n => `-${n.toLocaleString()}`],
      ['Files touched', s => s.files, n => n.toLocaleString()],
    ];
    const table = el('div', 'cc-metrics');
    for (const [label, pick, fmt] of metrics) {
      table.appendChild(this.metricRow(label, pick(cmp.a), pick(cmp.b), fmt, cmp));
    }
    this.body.appendChild(table);

    // Overlap summary.
    const overlap = el('div', 'cc-overlap');
    const pct = overlapPercent(cmp.overlap);
    overlap.innerHTML =
      `<div class="cc-overlap-head">` +
      `<span class="cc-overlap-pct">${pct}%</span>` +
      `<span class="cc-overlap-label">file overlap</span></div>` +
      `<div class="cc-overlap-sub">` +
      `${cmp.overlap.shared.length} shared · ${cmp.overlap.onlyA} only ${escapeHtml(firstName(cmp.a.name))} · ${cmp.overlap.onlyB} only ${escapeHtml(firstName(cmp.b.name))}</div>`;
    this.body.appendChild(overlap);

    // Shared file list (the most-collaborated files).
    if (cmp.overlap.shared.length > 0) {
      const list = el('div', 'cc-shared');
      const heading = el('div', 'cc-shared-head', 'Shared files');
      list.appendChild(heading);
      for (const path of cmp.overlap.shared.slice(0, 20)) {
        const row = el(this.handlers.onOpenFile ? 'button' : 'div', 'cc-shared-file');
        const { dir, base } = splitPath(path);
        row.innerHTML = `<span class="dir">${escapeHtml(dir)}</span><span class="base">${escapeHtml(base)}</span>`;
        if (this.handlers.onOpenFile) {
          (row as HTMLButtonElement).type = 'button';
          row.title = `Blame ${path}`;
          row.addEventListener('click', () => this.handlers.onOpenFile!(path));
        }
        list.appendChild(row);
      }
      this.body.appendChild(list);
    }
  }

  private identity(s: AuthorSummary): HTMLElement {
    const col = el('div', 'cc-col');
    col.innerHTML =
      `<span class="cc-dot" style="background:${authorColor(s.name)}"></span>` +
      `<span class="cc-name" title="${escapeHtml(s.email)}">${escapeHtml(s.name)}</span>`;
    return col;
  }

  private metricRow(
    label: string,
    aVal: number,
    bVal: number,
    fmt: (n: number) => string,
    cmp: ContributorComparison,
  ): HTMLElement {
    const max = Math.max(aVal, bVal, 1);
    const row = el('div', 'cc-metric');
    row.innerHTML =
      `<div class="cc-metric-side a">` +
      `<span class="cc-metric-val">${escapeHtml(fmt(aVal))}</span>` +
      `<span class="cc-metric-bar"><span class="fill" style="width:${Math.round((aVal / max) * 100)}%;background:${authorColor(cmp.a.name)}"></span></span>` +
      `</div>` +
      `<div class="cc-metric-label">${escapeHtml(label)}</div>` +
      `<div class="cc-metric-side b">` +
      `<span class="cc-metric-bar right"><span class="fill" style="width:${Math.round((bVal / max) * 100)}%;background:${authorColor(cmp.b.name)}"></span></span>` +
      `<span class="cc-metric-val">${escapeHtml(fmt(bVal))}</span>` +
      `</div>`;
    return row;
  }
}

/** First word of a name for compact overlap copy. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** Split a path into a trailing basename + leading dir (with separator). */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}
