/**
 * Lightweight context menu (W28).
 *
 * A reusable right-click menu in the app's design language: monochrome
 * glyphs, hairline border, one accent on hover. Pure DOM + lifecycle (open
 * at a point, dismiss on outside-click / Esc / scroll / blur). The caller
 * supplies the item list; this owns positioning (kept inside the viewport)
 * and keyboard nav (Up/Down/Enter). Used by the commit graph rows but
 * generic enough for any surface.
 */

import { el } from './format';
import { icons } from './icons';

export interface ContextMenuItem {
  label: string;
  icon?: keyof typeof icons;
  /** Run when chosen. The menu closes first. */
  run: () => void;
  /** Render disabled (dim, non-interactive). */
  disabled?: boolean;
  /** Draw a hairline separator ABOVE this item. */
  separator?: boolean;
}

let openMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

/** Close any currently-open context menu. */
export function closeContextMenu(): void {
  if (cleanup) cleanup();
  openMenu?.remove();
  openMenu = null;
  cleanup = null;
}

/**
 * Open a context menu at viewport coordinates (clientX/clientY). Replaces
 * any menu already open. Returns nothing; the menu manages its own teardown.
 */
export function openContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  closeContextMenu();
  if (items.length === 0) return;

  const menu = el('div', 'ctx-menu');
  menu.setAttribute('role', 'menu');

  const buttons: HTMLButtonElement[] = [];
  items.forEach(item => {
    if (item.separator) menu.appendChild(el('div', 'ctx-sep'));
    const btn = el('button', 'ctx-item' + (item.disabled ? ' disabled' : ''));
    btn.setAttribute('role', 'menuitem');
    btn.disabled = !!item.disabled;
    const ico = el('span', 'ctx-ico');
    ico.innerHTML = item.icon ? icons[item.icon] : '';
    const label = el('span', 'ctx-label');
    label.textContent = item.label;
    btn.append(ico, label);
    if (!item.disabled) {
      btn.addEventListener('click', () => {
        closeContextMenu();
        item.run();
      });
      btn.addEventListener('pointermove', () => focusItem(buttons.indexOf(btn)));
    }
    menu.appendChild(btn);
    buttons.push(btn);
  });

  // Mount off-screen first so we can measure, then clamp into the viewport.
  menu.style.left = '0';
  menu.style.top = '0';
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  const left = Math.min(x, window.innerWidth - rect.width - pad);
  const top = Math.min(y, window.innerHeight - rect.height - pad);
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
  menu.style.visibility = 'visible';
  menu.classList.add('show');

  openMenu = menu;

  let active = -1;
  function focusItem(i: number): void {
    if (i < 0 || i >= buttons.length || buttons[i].disabled) return;
    active = i;
    buttons.forEach((b, idx) => b.classList.toggle('active', idx === active));
  }
  function moveActive(delta: number): void {
    const n = buttons.length;
    for (let step = 0; step < n; step++) {
      active = (active + delta + n) % n;
      if (!buttons[active].disabled) break;
    }
    buttons.forEach((b, idx) => b.classList.toggle('active', idx === active));
    buttons[active]?.focus();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeContextMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      buttons[active].click();
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
  };
  const onScrollOrBlur = () => closeContextMenu();

  // Defer listener attach a tick so the opening click doesn't self-close.
  setTimeout(() => {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScrollOrBlur, true);
    window.addEventListener('blur', onScrollOrBlur);
    window.addEventListener('resize', onScrollOrBlur);
  }, 0);

  cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('scroll', onScrollOrBlur, true);
    window.removeEventListener('blur', onScrollOrBlur);
    window.removeEventListener('resize', onScrollOrBlur);
  };
}
