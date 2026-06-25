/**
 * Repo switcher (W8).
 *
 * A top-bar dropdown listing the repos the companion can serve (the
 * current one plus any found under the configured --root). Picking one
 * fires onPick with its path; main.ts reloads the snapshot with ?repo=.
 * Mirrors the palettePicker interaction model (button + popover listbox,
 * outside-click + Esc to close) for a consistent chrome feel.
 *
 * Hidden entirely when there is only one repo (nothing to switch to), so
 * the single-repo case stays clean.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import type { RepoEntry } from '@shared/repoPicker';

export interface RepoPickerOptions {
  repos: RepoEntry[];
  onPick: (entry: RepoEntry) => void;
}

/** Build the switcher, or null when there's nothing to switch between. */
export function createRepoPicker(opts: RepoPickerOptions): HTMLElement | null {
  if (opts.repos.length <= 1) return null;

  const wrap = el('div', 'repo-picker');
  const current = opts.repos.find(r => r.current) ?? opts.repos[0];

  const button = el('button', 'btn');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const renderButton = (entry: RepoEntry) => {
    button.innerHTML =
      `<span class="icon">${icons.repo}</span>` +
      `<span class="repo-current">${escapeHtml(entry.name)}</span>` +
      `<span class="chevron">${icons.chevron}</span>`;
  };
  renderButton(current);

  const menu = el('div', 'menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  let currentPath = current.path;
  const buildMenu = () => {
    menu.replaceChildren();
    for (const entry of opts.repos) {
      const item = el('button', 'menu-item' + (entry.path === currentPath ? ' selected' : ''));
      item.setAttribute('role', 'option');
      item.title = entry.path;
      item.innerHTML =
        `<span class="icon">${icons.repo}</span>` +
        `<span class="repo-name">${escapeHtml(entry.name)}</span>`;
      item.addEventListener('click', () => {
        currentPath = entry.path;
        renderButton(entry);
        close();
        opts.onPick(entry);
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
