/**
 * Keyboard help overlay (W37).
 *
 * A discoverable cheat-sheet of every shortcut, opened with `?`. Mirrors the
 * command-palette modal language (scrim + centered card, Esc to dismiss) but
 * is read-only: it lists the shortcuts relevant to the current view, grouped
 * by section, with the keys rendered as <kbd> chips.
 *
 * The catalog + the per-view filter are the pure, unit-tested
 * shortcutCatalog module; this owns the overlay DOM and the open/close
 * lifecycle. The host supplies the current view via a getter so the list
 * reflects wherever the user is when they press `?`.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import {
  buildShortcutCatalog,
  shortcutsForView,
  type HelpView,
} from './shortcutCatalog';

export interface KeyboardHelpHandlers {
  /** The currently-active view, read on every open. */
  view: () => HelpView;
  /** Whether the platform is macOS (drives the Cmd vs Ctrl chip). */
  isMac: boolean;
}

export class KeyboardHelp {
  private root: HTMLElement;
  private list: HTMLElement;
  private handlers: KeyboardHelpHandlers;
  private open = false;

  constructor(handlers: KeyboardHelpHandlers) {
    this.handlers = handlers;

    this.root = el('div', 'help-overlay');
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Keyboard shortcuts');

    const modal = el('div', 'help');

    const head = el('div', 'help-head');
    const title = el('div', 'help-title');
    title.innerHTML = `<span class="help-ico">${icons.command}</span><span>Keyboard shortcuts</span>`;
    const esc = el('kbd', 'help-esc', 'Esc');
    head.append(title, esc);

    this.list = el('div', 'help-body');

    modal.append(head, this.list);
    this.root.appendChild(modal);
    document.body.appendChild(this.root);

    this.root.addEventListener('pointerdown', e => {
      if (e.target === this.root) this.close();
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.renderList();
    this.root.hidden = false;
    this.root.classList.add('show');
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('show');
    this.root.hidden = true;
  }

  private renderList(): void {
    const catalog = buildShortcutCatalog(this.handlers.isMac);
    const groups = shortcutsForView(catalog, this.handlers.view());
    const frag = document.createDocumentFragment();

    for (const group of groups) {
      const section = el('section', 'help-group');
      const h = el('h3', 'help-group-title');
      h.textContent = group.title;
      section.appendChild(h);

      const rows = el('div', 'help-rows');
      for (const s of group.shortcuts) {
        const row = el('div', 'help-row');
        const desc = el('span', 'help-desc');
        desc.textContent = s.description;
        const keys = el('span', 'help-keys');
        keys.innerHTML = s.keys
          .map(k => `<kbd>${escapeHtml(k)}</kbd>`)
          .join('<span class="help-plus">+</span>');
        row.append(desc, keys);
        rows.appendChild(row);
      }
      section.appendChild(rows);
      frag.appendChild(section);
    }

    this.list.replaceChildren(frag);
  }
}
