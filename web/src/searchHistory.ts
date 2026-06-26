/**
 * Search history + saved filters dropdown (W30).
 *
 * A panel that drops under the graph search box listing recent + pinned
 * queries (the structured W10 queries the user has run). Pinned filters
 * sort first and survive the recents cap; each row applies its query on
 * click, with a pin toggle and a remove control. The pure model + rules
 * live in searchStore.ts (unit-tested); this owns the localStorage I/O and
 * the dropdown DOM/lifecycle.
 *
 * The panel opens on focus / typing when there's something to show and
 * filters to a prefix typeahead as the user types, so it doubles as
 * autocomplete for previous searches.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import {
  recordQuery,
  togglePin,
  removeQuery,
  coerceEntries,
  suggestEntries,
  type SearchEntry,
} from './searchStore';

const STORE_KEY = 'gitsight.searchHistory';

export interface SearchHistoryHandlers {
  /** Apply a chosen query (drives the search box + filter). */
  onApply: (query: string) => void;
}

export class SearchHistory {
  private entries: SearchEntry[] = [];
  private handlers: SearchHistoryHandlers;
  private panel: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  constructor(handlers: SearchHistoryHandlers) {
    this.handlers = handlers;
    this.entries = coerceEntries(readJson(STORE_KEY));
  }

  /** Record a query as run (persisted). Called when a search is committed. */
  record(query: string): void {
    this.entries = recordQuery(this.entries, query);
    this.persist();
    if (this.isOpen()) this.refresh();
  }

  hasEntries(): boolean {
    return this.entries.length > 0;
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  /**
   * Attach to a search input + its wrapper. Opens the panel on focus (when
   * there are entries) and re-filters as the user types. The host still
   * owns the input's value + the actual filtering; we only suggest.
   */
  attach(input: HTMLInputElement, anchor: HTMLElement): void {
    // A chrome rebuild swaps the search box; drop any panel bound to the old
    // one (and its document listener) before binding the fresh input.
    this.close();
    this.input = input;
    this.anchor = anchor;
    input.addEventListener('focus', () => {
      if (this.hasEntries()) this.open();
    });
    input.addEventListener('input', () => {
      if (this.isOpen()) this.refresh();
      else if (this.hasEntries()) this.open();
    });
  }

  open(): void {
    if (!this.anchor || this.isOpen()) return;
    const panel = el('div', 'search-history');
    this.anchor.appendChild(panel);
    this.panel = panel;
    this.refresh();
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onOutside, true);
    }, 0);
  }

  close(): void {
    if (!this.panel) return;
    this.panel.remove();
    this.panel = null;
    document.removeEventListener('pointerdown', this.onOutside, true);
  }

  private onOutside = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (this.panel && !this.panel.contains(t) && this.anchor && !this.anchor.contains(t)) {
      this.close();
    }
  };

  private refresh(): void {
    if (!this.panel) return;
    const current = this.input?.value ?? '';
    const rows = suggestEntries(this.entries, current);
    if (rows.length === 0) {
      this.close();
      return;
    }
    this.panel.replaceChildren(this.buildHeader(), ...rows.map(e => this.buildRow(e)));
  }

  private buildHeader(): HTMLElement {
    const head = el('div', 'search-history-head');
    const hasPins = this.entries.some(e => e.pinned);
    head.textContent = hasPins ? 'Pinned & recent searches' : 'Recent searches';
    return head;
  }

  private buildRow(entry: SearchEntry): HTMLElement {
    const row = el('div', 'search-history-row' + (entry.pinned ? ' pinned' : ''));

    const apply = el('button', 'shr-apply');
    apply.type = 'button';
    apply.title = 'Apply this filter';
    apply.innerHTML =
      `<span class="shr-ico">${entry.pinned ? icons.pinned : icons.search}</span>` +
      `<span class="shr-q">${escapeHtml(entry.query)}</span>`;
    apply.addEventListener('click', () => {
      this.close();
      this.handlers.onApply(entry.query);
    });

    const pin = el('button', 'shr-pin' + (entry.pinned ? ' on' : ''));
    pin.type = 'button';
    pin.title = entry.pinned ? 'Unpin' : 'Pin this filter';
    pin.setAttribute('aria-pressed', String(entry.pinned));
    pin.innerHTML = entry.pinned ? icons.pinned : icons.pin;
    pin.addEventListener('click', e => {
      e.stopPropagation();
      this.entries = togglePin(this.entries, entry.query);
      this.persist();
      this.refresh();
    });

    const del = el('button', 'shr-del');
    del.type = 'button';
    del.title = 'Remove from history';
    del.innerHTML = icons.close;
    del.addEventListener('click', e => {
      e.stopPropagation();
      this.entries = removeQuery(this.entries, entry.query);
      this.persist();
      if (!this.hasEntries()) this.close();
      else this.refresh();
    });

    row.append(apply, pin, del);
    return row;
  }

  private persist(): void {
    writeJson(STORE_KEY, this.entries);
  }
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / disabled storage — non-fatal */
  }
}
