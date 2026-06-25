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
import { loadSnapshot, loadCommitDetail, loadFileDiff, loadRepos } from './data';
import { ThemeController } from './theme';
import { createPalettePicker } from './palettePicker';
import { createRepoPicker } from './repoPicker';
import { createRefRail, activeRefFromFilter } from './refRailView';
import { CommitDetailPanel } from './detailPanel';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';
import type { RepoEntry } from '@shared/repoPicker';

interface AppState {
  snapshot: GraphSnapshot;
  filter: string;
  source: 'demo' | 'live' | 'loading';
  /** Repos the companion can serve; empty until /api/repos answers. */
  repos: RepoEntry[];
  /** Path of the repo currently being viewed (?repo= override). */
  repo: string | null;
  /** Whether the left ref rail is shown. */
  railOpen: boolean;
}

const theme = new ThemeController();

const state: AppState = {
  snapshot: DEMO_SNAPSHOT,
  filter: '',
  source: 'loading',
  repos: [],
  repo: null,
  railOpen: true,
};

const root = document.getElementById('app')!;

/** Slide-in commit-detail panel (W6). Fed by /api/commit/<sha>. */
const detailPanel = new CommitDetailPanel({
  load: sha => loadCommitDetail(sha, { repo: state.repo ?? undefined }),
  loadDiff: (rev, path) => loadFileDiff(rev, path, { repo: state.repo ?? undefined }),
  onCopySha: sha => void copySha(sha),
  onOpenSha: sha => openDetailFor(sha),
});

/** Open the detail panel for a sha and mark its row active if present. */
function openDetailFor(sha: string): void {
  void detailPanel.open(sha);
  const row = document.querySelector<HTMLElement>(`.rows-col .row[data-sha="${cssEscape(sha)}"]`);
  if (row) {
    const rowsCol = row.parentElement as HTMLElement;
    selectRow(rowsCol, row);
  }
}

function mount(): void {
  theme.applyChrome();
  root.replaceChildren(buildTopbar(), buildToolbar(), buildMainArea(), buildStatusbar());
  renderInto();
  installKeyboard();
  void boot();
}

/** Load the live snapshot; fall back to demo data if the companion isn't up. */
async function boot(): Promise<void> {
  showLoading();
  detailPanel.close();
  const result = await loadSnapshot({ repo: state.repo ?? undefined });
  if (result.ok) {
    state.snapshot = result.snapshot;
    state.source = 'live';
  } else {
    state.snapshot = DEMO_SNAPSHOT;
    state.source = 'demo';
  }
  // Rebuild chrome so the repo name / head chip reflect the loaded repo.
  root.replaceChildren(buildTopbar(), buildToolbar(), buildMainArea(), buildStatusbar());
  renderInto();
  if (!result.ok && !result.offline) {
    setStatus(`API error: ${result.error}`);
  }
  // Fetch the switchable repo list once (live mode only); refresh chrome
  // if it arrives with more than one repo so the switcher appears.
  if (state.source === 'live' && state.repos.length === 0) {
    const repos = await loadRepos();
    if (repos.ok && repos.repos.length > 0) {
      state.repos = repos.repos;
      if (!state.repo) {
        state.repo = repos.repos.find(r => r.current)?.path ?? null;
      }
      root.replaceChildren(buildTopbar(), buildToolbar(), buildMainArea(), buildStatusbar());
      renderInto();
    }
  }
}

/** Switch the served repo and reload from scratch. */
function switchRepo(entry: RepoEntry): void {
  if (entry.path === state.repo) return;
  state.repo = entry.path;
  state.filter = '';
  // Mark the picked repo current locally so the chrome reflects it pre-fetch.
  state.repos = state.repos.map(r => ({ ...r, current: r.path === entry.path }));
  void boot();
}

// ── Top bar ──────────────────────────────────────────────────────────
function buildTopbar(): HTMLElement {
  const bar = el('header', 'topbar');
  const brand = el('div', 'brand');
  brand.innerHTML =
    `<span class="mark">${icons.mark}</span>` +
    `<span>GitSight</span>`;
  // Repo switcher when >1 repo is available; otherwise a static repo name.
  const picker = createRepoPicker({
    repos: state.repos,
    onPick: entry => switchRepo(entry),
  });
  if (picker) {
    const sep = el('span', 'brand-sep', '/');
    brand.append(sep, picker);
  } else {
    const name = el('span', 'repo');
    name.textContent = state.snapshot.repo;
    brand.appendChild(name);
  }

  const spacer = el('div', 'spacer');

  const meta = el('div', 'meta');
  meta.innerHTML =
    `<span class="chip">${icons.graph}<span>${escapeText(state.snapshot.head)}</span></span>`;

  // Lane-palette picker.
  const palettePicker = createPalettePicker({
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

  bar.append(brand, spacer, meta, palettePicker, toggle);
  return bar;
}

// ── Toolbar ──────────────────────────────────────────────────────────
function buildToolbar(): HTMLElement {
  const bar = el('div', 'toolbar');

  // Ref-rail toggle.
  const railToggle = el('button', 'btn icon-only' + (state.railOpen ? ' on' : ''));
  railToggle.title = state.railOpen ? 'Hide ref sidebar' : 'Show ref sidebar';
  railToggle.setAttribute('aria-label', 'Toggle ref sidebar');
  railToggle.setAttribute('aria-pressed', String(state.railOpen));
  railToggle.innerHTML = icons.sidebar;
  railToggle.addEventListener('click', () => {
    state.railOpen = !state.railOpen;
    railToggle.classList.toggle('on', state.railOpen);
    railToggle.setAttribute('aria-pressed', String(state.railOpen));
    railToggle.title = state.railOpen ? 'Hide ref sidebar' : 'Show ref sidebar';
    rebuildMainArea();
    renderInto();
  });

  const search = el('div', 'search');
  search.innerHTML = `<span class="icon">${icons.search}</span>`;
  const input = el('input');
  input.id = 'filter-input';
  input.type = 'search';
  input.placeholder = 'Search — try author:ada grep:fix ref:main since:2026-01-01';
  input.value = state.filter;
  input.setAttribute('aria-label', 'Search commits');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  let t: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      state.filter = input.value.trim();
      // Keep the rail's active highlight in sync with a typed ref: query.
      rebuildMainArea();
      renderInto();
    }, 120);
  });
  search.appendChild(input);

  // Query-syntax help popover trigger.
  const help = el('button', 'btn icon-only');
  help.title = 'Search syntax';
  help.setAttribute('aria-label', 'Search syntax help');
  help.innerHTML = icons.help;
  help.addEventListener('click', () => toggleSearchHelp(help));

  const refresh = el('button', 'btn icon-only');
  refresh.title = 'Reload from repository';
  refresh.innerHTML = icons.refresh;
  refresh.addEventListener('click', () => void boot());

  bar.append(railToggle, search, help, refresh);
  return bar;
}

const SEARCH_HELP_ROWS: Array<[string, string]> = [
  ['author:ada', 'name or email'],
  ['grep:fix', 'subject text'],
  ['ref:main', 'branch / tag / HEAD'],
  ['sha:a1b2', 'sha prefix'],
  ['since:2026-01-01', 'on or after a date'],
  ['until:2026-06-30', 'on or before a date'],
  ['"two words"', 'quote multi-word values'],
];

let searchHelpEl: HTMLElement | null = null;
function toggleSearchHelp(anchor: HTMLElement): void {
  if (searchHelpEl) {
    closeSearchHelp();
    return;
  }
  const pop = el('div', 'search-help');
  pop.innerHTML =
    `<div class="search-help-title">Search syntax — terms AND together</div>` +
    SEARCH_HELP_ROWS.map(
      ([code, desc]) =>
        `<div class="search-help-row"><code>${escapeText(code)}</code><span>${escapeText(desc)}</span></div>`,
    ).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  pop.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  searchHelpEl = pop;
  setTimeout(() => {
    document.addEventListener('pointerdown', onSearchHelpOutside, true);
    document.addEventListener('keydown', onSearchHelpEsc, true);
  }, 0);
}
function closeSearchHelp(): void {
  searchHelpEl?.remove();
  searchHelpEl = null;
  document.removeEventListener('pointerdown', onSearchHelpOutside, true);
  document.removeEventListener('keydown', onSearchHelpEsc, true);
}
function onSearchHelpOutside(e: PointerEvent): void {
  if (searchHelpEl && !searchHelpEl.contains(e.target as Node)) closeSearchHelp();
}
function onSearchHelpEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeSearchHelp();
}

// ── Surface (rail + graph) ───────────────────────────────────────────
function buildMainArea(): HTMLElement {
  const area = el('div', 'main-area');
  if (state.railOpen) {
    const rail = createRefRail({
      snapshot: state.snapshot,
      activeRef: activeRefFromFilter(state.filter),
      onPick: query => applyFilter(query),
      onClear: () => applyFilter(''),
    });
    if (rail) area.appendChild(rail);
  }
  const surface = el('section', 'surface');
  surface.id = 'surface';
  area.appendChild(surface);
  return area;
}

/** Set the filter (from a rail click), sync the input, and re-render. */
function applyFilter(query: string): void {
  state.filter = query;
  const input = document.getElementById('filter-input') as HTMLInputElement | null;
  if (input) input.value = query;
  // Rebuild the rail so the active highlight follows the new filter.
  rebuildMainArea();
  renderInto();
}

/** Replace just the main area (rail + surface) in place. */
function rebuildMainArea(): void {
  const old = document.querySelector('.main-area');
  if (old) old.replaceWith(buildMainArea());
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
    onSelect: (c: GraphSnapshotCommit) => {
      setStatus(`${c.shortSha}  ${c.subject}`);
      void detailPanel.open(c.sha);
    },
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
    `<p>Nothing matches <code>${escapeText(state.filter)}</code>. Clear the search or try a single term like <code>author:</code> or <code>grep:</code>.</p>`;
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
          rebuildMainArea();
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
    } else if (e.key === 'Escape' && detailPanel.isOpen()) {
      detailPanel.close();
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

/** CSS.escape with a safe fallback (older browsers / jsdom). */
function cssEscape(s: string): string {
  const c = window.CSS;
  if (c && typeof c.escape === 'function') return c.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

mount();
