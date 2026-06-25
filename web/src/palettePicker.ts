/**
 * Lane-palette picker (W5).
 *
 * A compact dropdown that lists every shared THEME with a live colour
 * swatch preview. Picking one updates the lane palette and re-renders the
 * graph. Pure presentation — the actual palette state lives in
 * ThemeController; this just surfaces it.
 */

import { THEMES, THEME_NAMES, type ThemeName } from '@shared/graphPalette';
import { el } from './format';

export interface PalettePickerOptions {
  current: ThemeName;
  onPick: (name: ThemeName) => void;
}

function swatch(palette: string[]): string {
  return (
    `<span class="swatch">` +
    palette
      .slice(0, 6)
      .map(c => `<i style="background:${c}"></i>`)
      .join('') +
    `</span>`
  );
}

export function createPalettePicker(opts: PalettePickerOptions): HTMLElement {
  const wrap = el('div', 'palette-picker');

  const button = el('button', 'btn');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const renderButton = (name: ThemeName) => {
    button.innerHTML = `${swatch(THEMES[name].palette)}<span>${THEMES[name].name}</span>`;
  };
  renderButton(opts.current);

  const menu = el('div', 'menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  let currentName = opts.current;
  const buildMenu = () => {
    menu.replaceChildren();
    for (const name of THEME_NAMES) {
      const item = el('button', 'menu-item' + (name === currentName ? ' selected' : ''));
      item.setAttribute('role', 'option');
      item.innerHTML = `${swatch(THEMES[name].palette)}<span>${THEMES[name].name}</span>`;
      item.addEventListener('click', () => {
        currentName = name;
        renderButton(name);
        close();
        opts.onPick(name);
      });
      menu.appendChild(item);
    }
  };

  const open = () => {
    buildMenu();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEsc, true);
  };
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  const onOutside = (e: PointerEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      button.focus();
    }
  };

  button.addEventListener('click', () => (menu.hidden ? open() : close()));

  wrap.append(button, menu);
  return wrap;
}
