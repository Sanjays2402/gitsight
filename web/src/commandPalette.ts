/**
 * Command palette (W26) — a Cmd-K / Ctrl-K quick-switcher.
 *
 * A keyboard-first overlay (Linear / Raycast style) that fuzzy-matches the
 * union of: every view tab, every branch/remote/tag in the loaded snapshot
 * (jump straight to a ref-filtered graph), and a few global actions
 * (reload, toggle theme, export). Type to filter, Up/Down to move, Enter to
 * run, Esc to dismiss. The fuzzy ranking + highlighting is the pure,
 * unit-tested paletteSearch core; this module owns the modal DOM and the
 * open/close/keyboard lifecycle.
 *
 * The host (main.ts) supplies the item list lazily (so refs reflect the
 * current snapshot) and an `onRun` callback; the palette is otherwise
 * self-contained and appends a single overlay to <body>.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import {
  rankItems,
  highlightRuns,
  type PaletteItem,
  type RankedItem,
} from './paletteSearch';

export interface CommandPaletteHandlers {
  /** Build the current item list (called on every open so refs are fresh). */
  items: () => PaletteItem[];
  /** Run a chosen item. The palette closes first, then calls this. */
  onRun: (item: PaletteItem) => void;
  /**
   * Optional commit-search provider (W32): given the live query, return
   * commit palette items (kind 'commit') to interleave below the commands.
   * Called on every keystroke so it reflects the typed query. The match
   * positions for subject highlighting ride along in `matchPositions`.
   */
  commitSearch?: (query: string) => PaletteCommitItem[];
}

/** A commit-search result enriched with its subject highlight positions. */
export interface PaletteCommitItem extends PaletteItem {
  kind: 'commit';
  /** Positions into `label` to emphasise (subject fuzzy match). */
  matchPositions?: number[];
}

const KIND_GLYPH: Record<PaletteItem['kind'], keyof typeof icons> = {
  view: 'graph',
  ref: 'branch',
  search: 'search',
  action: 'command',
  commit: 'mark',
};

const MAX_RESULTS = 60;
/** Commit results are capped tighter so they never bury the commands. */
const MAX_COMMITS = 8;

export class CommandPalette {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private handlers: CommandPaletteHandlers;
  private ranked: RankedItem[] = [];
  private active = 0;
  private open = false;

  constructor(handlers: CommandPaletteHandlers) {
    this.handlers = handlers;

    this.root = el('div', 'palette-overlay');
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Command palette');

    const modal = el('div', 'palette');

    const head = el('div', 'palette-head');
    head.innerHTML = `<span class="palette-ico">${icons.search}</span>`;
    this.input = el('input', 'palette-input');
    this.input.type = 'text';
    this.input.placeholder = 'Search commits, jump to a view, branch, or action…';
    this.input.setAttribute('aria-label', 'Search commands');
    this.input.setAttribute('spellcheck', 'false');
    this.input.setAttribute('autocomplete', 'off');
    const kbd = el('kbd', 'palette-esc', 'Esc');
    head.append(this.input, kbd);

    this.list = el('div', 'palette-list');
    this.list.setAttribute('role', 'listbox');

    modal.append(head, this.list);
    this.root.appendChild(modal);
    document.body.appendChild(this.root);

    // A click on the scrim (not the modal) dismisses.
    this.root.addEventListener('pointerdown', e => {
      if (e.target === this.root) this.close();
    });
    this.input.addEventListener('input', () => this.refilter());
    this.input.addEventListener('keydown', e => this.onKey(e));
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Toggle the palette (the Cmd-K convention). */
  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.hidden = false;
    this.root.classList.add('show');
    this.input.value = '';
    this.refilter();
    // Focus after paint so the caret lands reliably.
    requestAnimationFrame(() => this.input.focus());
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('show');
    this.root.hidden = true;
    this.input.blur();
  }

  private refilter(): void {
    const query = this.input.value;
    const items = this.handlers.items();
    const commands = rankItems(items, query).slice(0, MAX_RESULTS);

    // Interleave commit-search results (W32) below the commands. They're
    // appended as RankedItems whose positions drive the subject highlight,
    // so renderList stays uniform.
    const commits: RankedItem[] = [];
    if (this.handlers.commitSearch) {
      const matches = this.handlers.commitSearch(query).slice(0, MAX_COMMITS);
      for (const m of matches) {
        commits.push({ item: m, match: { score: 0, positions: m.matchPositions ?? [] } });
      }
    }

    this.ranked = [...commands, ...commits];
    this.active = 0;
    this.renderList();
  }

  private renderList(): void {
    if (this.ranked.length === 0) {
      const empty = el('div', 'palette-empty');
      empty.textContent = 'No matches';
      this.list.replaceChildren(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    this.ranked.forEach((r, i) => {
      const row = el('button', 'palette-item' + (i === this.active ? ' active' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === this.active));
      row.dataset.index = String(i);

      const ico = el('span', 'palette-item-ico');
      ico.innerHTML = icons[KIND_GLYPH[r.item.kind]] ?? icons.command;

      const label = el('span', 'palette-item-label');
      label.innerHTML = highlightRuns(r.item.label, r.match.positions)
        .map(run => (run.match ? `<mark>${escapeHtml(run.text)}</mark>` : escapeHtml(run.text)))
        .join('');

      row.append(ico, label);
      if (r.item.hint) {
        const hint = el('span', 'palette-item-hint');
        hint.textContent = r.item.hint;
        row.appendChild(hint);
      }
      row.addEventListener('click', () => this.run(i));
      // Hover moves the active row so mouse + keyboard stay in sync.
      row.addEventListener('pointermove', () => this.setActive(i));
      frag.appendChild(row);
    });
    this.list.replaceChildren(frag);
  }

  private setActive(i: number): void {
    if (i === this.active) return;
    this.active = i;
    this.list.querySelectorAll('.palette-item').forEach((node, idx) => {
      const on = idx === i;
      node.classList.toggle('active', on);
      node.setAttribute('aria-selected', String(on));
    });
  }

  private move(delta: number): void {
    if (this.ranked.length === 0) return;
    const n = this.ranked.length;
    this.setActive((this.active + delta + n) % n);
    const node = this.list.querySelector<HTMLElement>(`.palette-item[data-index="${this.active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }

  private run(i: number): void {
    const chosen = this.ranked[i];
    if (!chosen) return;
    this.close();
    this.handlers.onRun(chosen.item);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.run(this.active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }
}
