/**
 * GitSight web — app shell (W2).
 *
 * Builds the chrome (top bar, toolbar, surface, status line) and renders
 * a snapshot via the shared graph renderer. W2 uses the demo snapshot;
 * W4 swaps in the live `/api/graph` fetch. The shell + render loop are
 * structured so later slices (filter, keyboard nav, theming) extend
 * without a rewrite.
 */

import './styles.css';
import { renderGraph } from './graph';
import { icons } from './icons';
import { el } from './format';
import { DEMO_SNAPSHOT } from './demo';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';

interface AppState {
  snapshot: GraphSnapshot;
  filter: string;
  theme: string; // lane palette theme
  source: 'demo' | 'live';
}

const state: AppState = {
  snapshot: DEMO_SNAPSHOT,
  filter: '',
  theme: 'default',
  source: 'demo',
};

const root = document.getElementById('app')!;

function mount(): void {
  root.replaceChildren(buildTopbar(), buildToolbar(), buildSurface(), buildStatusbar());
  renderInto();
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
    `<span class="chip">${icons.graph}<span>${state.snapshot.head}</span></span>`;

  bar.append(brand, spacer, meta);
  return bar;
}

// ── Toolbar ──────────────────────────────────────────────────────────
function buildToolbar(): HTMLElement {
  const bar = el('div', 'toolbar');

  const search = el('div', 'search');
  search.innerHTML = `<span class="icon">${icons.search}</span>`;
  const input = el('input');
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
  refresh.title = 'Refresh';
  refresh.innerHTML = icons.refresh;
  refresh.addEventListener('click', () => renderInto());

  bar.append(search, refresh);
  return bar;
}

// ── Surface ──────────────────────────────────────────────────────────
function buildSurface(): HTMLElement {
  const surface = el('section', 'surface');
  surface.id = 'surface';
  return surface;
}

function renderInto(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;

  const result = renderGraph(state.snapshot, {
    theme: state.theme,
    filter: state.filter,
    onSelect: (c: GraphSnapshotCommit) => setStatus(`${c.shortSha}  ${c.subject}`),
    onCopySha: (sha: string) => copySha(sha),
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
  bar.innerHTML =
    `<span class="dot ${state.source}"></span>` +
    `<span id="status-source">${state.source === 'demo' ? 'Demo data' : 'Live'}</span>` +
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
