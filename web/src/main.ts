/**
 * GitSight web — app shell (W2, extended in W4).
 *
 * Builds the chrome (top bar, toolbar, surface, status line) and renders
 * a snapshot via the shared graph renderer. On startup it loads the live
 * snapshot from the companion server (/api/graph) and falls back to the
 * demo snapshot when the server isn't running. Keyboard navigation
 * (j/k/arrows, Enter, /) is wired here.
 */

import './styles.css';
import { renderGraph, selectRow } from './graph';
import { icons } from './icons';
import { el } from './format';
import { DEMO_SNAPSHOT } from './demo';
import { loadSnapshot } from './data';
import { ThemeController } from './theme';
import { createPalettePicker } from './palettePicker';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';

interface AppState {
  snapshot: GraphSnapshot;
  filter: string;
  source: 'demo' | 'live' | 'loading';
}

const theme = new ThemeController();

const state: AppState = {
  snapshot: DEMO_SNAPSHOT,
  filter: '',
  source: 'loading',
};

const root = document.getElementById('app')!;

function mount(): void {
  theme.applyChrome();
  root.replaceChildren(buildTopbar(), buildToolbar(), buildSurface(), buildStatusbar());
  renderInto();
  installKeyboard();
  void boot();
}

/** Load the live snapshot; fall back to demo data if the companion isn't up. */
async function boot(): Promise<void> {
  showLoading();
  const result = await loadSnapshot();
  if (result.ok) {
    state.snapshot = result.snapshot;
    state.source = 'live';
  } else {
    state.snapshot = DEMO_SNAPSHOT;
    state.source = 'demo';
  }
  // Rebuild chrome so the repo name / head chip reflect the loaded repo.
  root.replaceChildren(buildTopbar(), buildToolbar(), buildSurface(), buildStatusbar());
  renderInto();
  if (!result.ok && !result.offline) {
    setStatus(`API error: ${result.error}`);
  }
}

// ── Top bar ──────────────────────────────────────────────────────────
function buildTopbar(): HTMLElement {
  const bar = el('header', 'topbar');
  const brand = el('div', 'brand');
  brand.innerHTML =
    `<span class="mark">${icons.mark}</span>` +
    `<span>GitSight</span>` +
    `<span class="repo">${escapeText(state.snapshot.repo)}</span>`;

  const spacer = el('div', 'spacer');

  const meta = el('div', 'meta');
  meta.innerHTML =
    `<span class="chip">${icons.graph}<span>${escapeText(state.snapshot.head)}</span></span>`;

  // Lane-palette picker.
  const picker = createPalettePicker({
    current: theme.palette,
    onPick: name => {
      theme.setPalette(name);
      renderInto();
    },
  });

  // Chrome light/dark toggle.
  const toggle = el('button', 'btn icon-only');
  const renderToggle = () => {
    toggle.innerHTML = theme.chrome === 'dark' ? icons.sun : icons.moon;
    toggle.title = theme.chrome === 'dark' ? 'Switch to light' : 'Switch to dark';
  };
  renderToggle();
  toggle.addEventListener('click', () => {
    theme.toggleChrome();
    renderToggle();
  });

  bar.append(brand, spacer, meta, picker, toggle);
  return bar;
}

// ── Toolbar ──────────────────────────────────────────────────────────
function buildToolbar(): HTMLElement {
  const bar = el('div', 'toolbar');

  const search = el('div', 'search');
  search.innerHTML = `<span class="icon">${icons.search}</span>`;
  const input = el('input');
  input.id = 'filter-input';
  input.type = 'search';
  input.placeholder = 'Filter commits by subject, author, or sha';
  input.value = state.filter;
  input.setAttribute('aria-label', 'Filter commits');
  let t: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      state.filter = input.value.trim();
      renderInto();
    }, 120);
  });
  search.appendChild(input);

  const refresh = el('button', 'btn icon-only');
  refresh.title = 'Reload from repository';
  refresh.innerHTML = icons.refresh;
  refresh.addEventListener('click', () => void boot());

  bar.append(search, refresh);
  return bar;
}

// ── Surface ──────────────────────────────────────────────────────────
function buildSurface(): HTMLElement {
  const surface = el('section', 'surface');
  surface.id = 'surface';
  return surface;
}

function showLoading(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = el('div', 'state');
  s.innerHTML = `<span class="spinner"></span><p>Reading commit history…</p>`;
  surface.replaceChildren(s);
}

function renderInto(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;

  const result = renderGraph(state.snapshot, {
    theme: theme.palette,
    filter: state.filter,
    onSelect: (c: GraphSnapshotCommit) => setStatus(`${c.shortSha}  ${c.subject}`),
    onCopySha: (sha: string) => void copySha(sha),
  });

  if (result.rendered === 0) {
    surface.replaceChildren(emptyState());
  } else {
    surface.replaceChildren(result.node);
  }
  updateCount(result.rendered, result.total);
}

function emptyState(): HTMLElement {
  const s = el('div', 'state');
  s.innerHTML =
    `<span class="glyph">${icons.empty}</span>` +
    `<h2>No matching commits</h2>` +
    `<p>Nothing matches <code>${escapeText(state.filter)}</code>. Clear the filter to see the full graph.</p>`;
  return s;
}

// ── Status bar ───────────────────────────────────────────────────────
function buildStatusbar(): HTMLElement {
  const bar = el('footer', 'statusbar');
  bar.id = 'statusbar';
  const label = state.source === 'live' ? 'Live' : state.source === 'demo' ? 'Demo data' : 'Loading';
  const dotClass = state.source === 'live' ? 'live' : 'demo';
  bar.innerHTML =
    `<span class="dot ${dotClass}"></span>` +
    `<span id="status-source">${label}</span>` +
    `<span id="status-count"></span>` +
    `<span class="spacer" style="flex:1"></span>` +
    `<span id="status-msg"></span>`;
  return bar;
}

function updateCount(rendered: number, total: number): void {
  const c = document.getElementById('status-count');
  if (!c) return;
  c.textContent = rendered === total ? `${total} commits` : `${rendered} of ${total} commits`;
}

function setStatus(msg: string): void {
  const m = document.getElementById('status-msg');
  if (m) m.textContent = msg;
}

// ── Keyboard navigation (W4) ─────────────────────────────────────────
function installKeyboard(): void {
  document.addEventListener('keydown', e => {
    const input = document.getElementById('filter-input') as HTMLInputElement | null;
    // `/` focuses the filter from anywhere.
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input?.focus();
      input?.select();
      return;
    }
    if (document.activeElement === input) {
      if (e.key === 'Escape') {
        input!.blur();
        if (input!.value) {
          input!.value = '';
          state.filter = '';
          renderInto();
        }
      }
      return;
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      const active = document.querySelector('.row.active') as HTMLElement | null;
      active?.click();
    }
  });
}

function moveSelection(delta: number): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.rows-col .row'));
  if (rows.length === 0) return;
  const current = rows.findIndex(r => r.classList.contains('active'));
  let next = current + delta;
  if (current === -1) next = delta > 0 ? 0 : rows.length - 1;
  next = Math.max(0, Math.min(rows.length - 1, next));
  const rowsCol = rows[0].parentElement as HTMLElement;
  selectRow(rowsCol, rows[next]);
  const sha = rows[next].dataset.sha ?? '';
  const subject = rows[next].querySelector('.subject')?.textContent ?? '';
  setStatus(`${sha.slice(0, 7)}  ${subject}`);
}

// ── Helpers ──────────────────────────────────────────────────────────
async function copySha(sha: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sha);
    toast(`Copied ${sha.slice(0, 7)}`);
  } catch {
    toast('Copy failed');
  }
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  let node = document.querySelector('.toast') as HTMLElement | null;
  if (!node) {
    node = el('div', 'toast');
    document.body.appendChild(node);
  }
  node.textContent = msg;
  node.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node!.classList.remove('show'), 1600);
}

function escapeText(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

mount();
