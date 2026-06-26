/**
 * GitSight web — app shell (W2; extended through W15).
 *
 * Builds the chrome (top bar, view tabs, toolbar, surface, status line)
 * and renders one of four views via the shared modules:
 *   - Graph        — the commit graph (shared graphCore) + search + rail.
 *   - Activity     — contribution calendar (shared activity).
 *   - Contributors — author leaderboard (shared contributors).
 *   - Blame        — per-file age heatmap (shared blame).
 * The graph view also exports a standalone SVG (W15, shared graphExport)
 * and adapts responsively (W11) — the ref rail collapses into an overlay
 * drawer and rows tighten below width breakpoints.
 */

import './styles.css';
import { renderGraph, type GraphController } from './graph';
import { icons } from './icons';
import { el } from './format';
import { DEMO_SNAPSHOT } from './demo';
import {
  loadSnapshot,
  loadCommitDetail,
  loadFileDiff,
  loadRepos,
  loadActivity,
  loadContributors,
  loadAuthor,
  loadBlame,
  loadCompare,
  loadStashes,
  loadStashDiff,
  loadDay,
  loadHealth,
  runStashAction,
  type StashActionKind,
  type ActivityPayload,
  type ContributorsPayload,
  type BlamePayload,
  type ComparePayload,
  type StashesPayload,
} from './data';
import { ThemeController } from './theme';
import { createPalettePicker } from './palettePicker';
import { createRepoPicker } from './repoPicker';
import { createRefRail, activeRefFromFilter } from './refRailView';
import { openRefDetail } from './refDetailPopover';
import type { RailRef } from '@shared/refRail';
import { CommitDetailPanel } from './detailPanel';
import { DayPanel } from './dayPanel';
import { renderActivity } from './activityView';
import { renderContributors } from './contributorsView';
import { AuthorPanel } from './authorPanel';
import { renderBlame } from './blameView';
import { parseBlameTarget } from './blameWindow';
import { renderCompare } from './compareView';
import { renderStashes } from './stashView';
import { downloadGraphSvg } from './exportGraph';
import { buildHash, parseHash, hashChanged, type Route } from './hashRoute';
import { layoutFor, layoutChanged, type Layout } from './responsive';
import { LiveClient, type LiveStatus } from './live';
import { CommandPalette } from './commandPalette';
import type { PaletteItem } from './paletteSearch';
import { openContextMenu, type ContextMenuItem } from './contextMenu';
import { SearchHistory } from './searchHistory';
import { buildRailSections, refQuery } from '@shared/refRail';
import { commitWebUrl } from '@shared/remoteUrl';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';
import type { RepoEntry } from '@shared/repoPicker';

type AppView = 'graph' | 'activity' | 'contributors' | 'blame' | 'compare' | 'stashes';

interface AsyncSlot<T> {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: T | null;
  error: string;
}

function slot<T>(): AsyncSlot<T> {
  return { status: 'idle', data: null, error: '' };
}

interface AppState {
  snapshot: GraphSnapshot;
  filter: string;
  source: 'demo' | 'live' | 'loading';
  repos: RepoEntry[];
  repo: string | null;
  railOpen: boolean;
  /** Active primary view. */
  view: AppView;
  /** Current responsive layout mode. */
  layout: Layout;
  /** Lazy-loaded view payloads. */
  activity: AsyncSlot<ActivityPayload>;
  contributors: AsyncSlot<ContributorsPayload>;
  blame: AsyncSlot<BlamePayload>;
  /** The file path currently being blamed. */
  blamePath: string | null;
  /** The revision currently being blamed (default HEAD; W28 blame-at-commit). */
  blameRev: string;
  /** 1-based line to reveal after the blame loads (W21 jump-to-line). */
  blameLine: number | null;
  /** Live-refresh connection status (W17). */
  live: LiveStatus;
  /** Range-compare payload + the ref pair (W18). */
  compare: AsyncSlot<ComparePayload>;
  compareBase: string;
  compareHead: string;
  /** Stash list payload (W19). */
  stashes: AsyncSlot<StashesPayload>;
  /** Whether the companion permits local stash mutations (W25). */
  allowMutations: boolean;
}

const theme = new ThemeController();

const state: AppState = {
  snapshot: DEMO_SNAPSHOT,
  filter: '',
  source: 'loading',
  repos: [],
  repo: null,
  railOpen: true,
  view: 'graph',
  layout: layoutFor(typeof window !== 'undefined' ? window.innerWidth : 1280),
  activity: slot<ActivityPayload>(),
  contributors: slot<ContributorsPayload>(),
  blame: slot<BlamePayload>(),
  blamePath: null,
  blameRev: 'HEAD',
  blameLine: null,
  live: 'disconnected',
  compare: slot<ComparePayload>(),
  compareBase: 'main',
  compareHead: 'HEAD',
  stashes: slot<StashesPayload>(),
  allowMutations: false,
};

const root = document.getElementById('app')!;

/** Slide-in commit-detail panel (W6). Fed by /api/commit/<sha>. */
const detailPanel = new CommitDetailPanel({
  load: sha => loadCommitDetail(sha, { repo: state.repo ?? undefined }),
  loadDiff: (rev, path) => loadFileDiff(rev, path, { repo: state.repo ?? undefined }),
  onCopySha: sha => void copySha(sha),
  onOpenSha: sha => openDetailFor(sha),
  onCompareFrom: sha => compareFromCommit(sha),
  onCopyLink: sha => void copyCommitLink(sha),
  // Keep the URL in sync with the focused commit so it's a shareable
  // permalink (W27); clearing on close drops the #commit/<sha> fragment.
  onOpened: () => {
    if (state.view === 'graph') syncHash();
  },
  onClosed: () => {
    if (state.view === 'graph') syncHash();
  },
});

/** The live graph controller (W16) — owns selection + scroll recycling. */
let graphController: GraphController | null = null;

/**
 * Activity day drill-down panel (W22). Opened from an Activity calendar
 * cell; lists that day's commits and routes into the detail panel / graph.
 */
const dayPanel = new DayPanel({
  load: date => loadDay(date, { repo: state.repo ?? undefined }),
  onOpenCommit: sha => openDetailFor(sha),
  onViewInGraph: date => {
    state.view = 'graph';
    rebuildChrome();
    applyFilter(`since:${date} until:${date}`);
  },
  onCopySha: sha => void copySha(sha),
});

/**
 * Contributor detail panel (W23). Opened from a leaderboard row; shows the
 * author's sparkline + most-touched files and routes into graph / blame.
 */
const authorPanel = new AuthorPanel({
  load: email => loadAuthor(email, { repo: state.repo ?? undefined }),
  onViewCommits: (email, name) => {
    state.view = 'graph';
    rebuildChrome();
    const value = email || name;
    applyFilter(/\s/.test(value) ? `author:"${value}"` : `author:${value}`);
  },
  onOpenFile: path => {
    state.view = 'blame';
    rebuildChrome();
    void loadBlamePath(path);
  },
});

/**
 * Live-refresh client (W17). Re-pulls the snapshot when the companion
 * reports the watched repo's graph changed, and reflects connection state
 * in the status bar. Auto-refresh only triggers in live mode; demo data
 * has no backend to watch.
 */
const live = new LiveClient({
  onRefresh: () => void onLiveRefresh(),
  onStatus: status => {
    state.live = status;
    updateLiveIndicator();
  },
});

/** Open the detail panel for a sha and mark its row active if present. */
function openDetailFor(sha: string): void {
  void detailPanel.open(sha);
  graphController?.selectSha(sha);
}

/**
 * Command palette (W26) — Cmd-K quick switcher. Its item list is rebuilt
 * on every open (via the handler) so branch/tag entries reflect the
 * currently-loaded snapshot. Running an item routes to a view, applies a
 * ref filter, or fires a global action.
 */
const palette = new CommandPalette({
  items: () => buildPaletteItems(),
  onRun: item => runPaletteItem(item),
});

/**
 * Search history + saved filters (W30). Persists the structured queries the
 * user runs (recent + pinned) and surfaces them as a dropdown under the
 * graph search box. Applying a row drives the same filter path as typing.
 */
const searchHistory = new SearchHistory({
  onApply: query => {
    const input = document.getElementById('filter-input') as HTMLInputElement | null;
    if (input) input.value = query;
    state.filter = query;
    searchHistory.record(query);
    rebuildMainArea();
    renderView();
  },
});

/** Assemble the palette's searchable items: views + refs + actions. */
function buildPaletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [];
  // Views (skip the one we're already on so the list stays useful).
  for (const tab of TABS) {
    if (tab.id === state.view) continue;
    items.push({ id: `view:${tab.id}`, kind: 'view', label: tab.label, hint: 'View', value: `view:${tab.id}`, weight: 0 });
  }
  // Branch / remote / tag refs from the live snapshot -> ref-filtered graph.
  for (const section of buildRailSections(state.snapshot.commits)) {
    for (const ref of section.refs) {
      items.push({
        id: `ref:${ref.group}:${ref.name}`,
        kind: 'ref',
        label: ref.name,
        hint: section.label.replace(/e?s$/, ''),
        value: refQuery(ref),
        weight: 1,
      });
    }
  }
  // Global actions.
  const actions: Array<[string, string, string]> = [
    ['reload', 'Reload from repository', 'Action'],
    ['theme', `Switch to ${theme.chrome === 'dark' ? 'light' : 'dark'} theme`, 'Action'],
    ['export', 'Export graph as SVG', 'Action'],
  ];
  for (const [id, label, hint] of actions) {
    items.push({ id: `action:${id}`, kind: 'action', label, hint, value: `action:${id}`, weight: 2 });
  }
  return items;
}

/** Execute a palette selection. */
function runPaletteItem(item: PaletteItem): void {
  if (item.kind === 'view') {
    switchView(item.value.slice('view:'.length) as AppView);
  } else if (item.kind === 'ref') {
    if (state.view !== 'graph') {
      state.view = 'graph';
      rebuildChrome();
      syncHash();
    }
    applyFilter(item.value);
  } else if (item.kind === 'action') {
    const id = item.value.slice('action:'.length);
    if (id === 'reload') void boot();
    else if (id === 'theme') {
      theme.toggleChrome();
      rebuildChrome();
    } else if (id === 'export') {
      if (state.view !== 'graph') switchView('graph');
      exportSvg();
    }
  }
}

/**
 * "Compare from here" (W24): set a commit as the compare base (vs HEAD),
 * jump to the Compare tab, and run it. Uses the short sha so the resulting
 * deep link stays compact + readable.
 */
function compareFromCommit(sha: string): void {
  detailPanel.close();
  const base = sha.slice(0, 12);
  state.view = 'compare';
  rebuildChrome();
  syncHash();
  void runCompare(base, 'HEAD');
}

/**
 * Right-click context menu for a commit row (W28). Copy SHA / Copy message
 * / open the detail / Compare from here / Blame at this commit / Copy
 * permalink / Open on remote (host-detected from the snapshot's origin).
 * Mirrors the detail-panel actions but reachable straight from the graph.
 */
function showCommitMenu(c: GraphSnapshotCommit, e: MouseEvent): void {
  const items: ContextMenuItem[] = [
    { label: 'Open commit detail', icon: 'graph', run: () => openDetailFor(c.sha) },
    { label: 'Copy SHA', icon: 'copy', run: () => void copySha(c.sha) },
    { label: 'Copy message', icon: 'copy', run: () => void copyText(c.subject, 'Message copied') },
    { label: 'Copy permalink', icon: 'link', separator: true, run: () => void copyCommitLink(c.sha) },
    { label: 'Compare from here', icon: 'gitCompare', run: () => compareFromCommit(c.sha) },
    { label: 'Blame at this commit', icon: 'blame', run: () => blameAtCommit(c.sha) },
  ];

  // "Open on remote" only when the snapshot carries a mappable origin (W28).
  const target = commitWebUrl(state.snapshot.remote, c.sha);
  items.push(
    target
      ? {
          label: `Open on ${target.label}`,
          icon: 'globe',
          separator: true,
          run: () => window.open(target.url, '_blank', 'noopener,noreferrer'),
        }
      : { label: 'Open on remote', icon: 'globe', separator: true, disabled: true, run: () => {} },
  );

  openContextMenu(e.clientX, e.clientY, items);
}

/**
 * Blame the first file this commit touched, AT this commit (W28). We don't
 * carry the file list in the snapshot, so fetch the commit detail, pick its
 * first changed file, and open the Blame view scoped to that path. Falls
 * back to a toast when the commit changed no files (e.g. an empty/merge).
 */
async function blameAtCommit(sha: string): Promise<void> {
  const res = await loadCommitDetail(sha, { repo: state.repo ?? undefined });
  if (!res.ok) {
    toast(`Could not read ${sha.slice(0, 7)}`);
    return;
  }
  const file = res.detail.files.find(f => f.status !== 'deleted') ?? res.detail.files[0];
  if (!file) {
    toast('Commit touched no files to blame');
    return;
  }
  state.view = 'blame';
  rebuildChrome();
  syncHash();
  // Blame the path at this revision so the heatmap reflects history up to it.
  await loadBlameAt(sha, file.path);
}

function mount(): void {
  theme.applyChrome();
  // Restore the deep-linked view/compare refs from the URL hash (W24)
  // BEFORE the first paint so a shared compare link opens on its tab.
  applyInitialRoute();
  rebuildChrome();
  installKeyboard();
  installResize();
  installHashRouting();
  void boot();
}

/** Rebuild the whole chrome (topbar, tabs, toolbar, main area, statusbar). */
function rebuildChrome(): void {
  root.dataset.view = state.view;
  root.dataset.compact = String(state.layout.compact);
  root.replaceChildren(
    buildTopbar(),
    buildTabs(),
    buildToolbar(),
    buildMainArea(),
    buildStatusbar(),
  );
  renderView();
}

/** Load the live snapshot; fall back to demo data if the companion isn't up. */
async function boot(): Promise<void> {
  state.source = 'loading';
  showLoading();
  detailPanel.close();
  dayPanel.close();
  authorPanel.close();
  const result = await loadSnapshot({ repo: state.repo ?? undefined });
  if (result.ok) {
    state.snapshot = result.snapshot;
    state.source = 'live';
  } else {
    state.snapshot = DEMO_SNAPSHOT;
    state.source = 'demo';
  }
  // Switching repos / reloading invalidates the cached view payloads.
  state.activity = slot<ActivityPayload>();
  state.contributors = slot<ContributorsPayload>();
  state.blame = slot<BlamePayload>();
  state.blamePath = null;
  state.blameLine = null;
  state.compare = slot<ComparePayload>();
  state.stashes = slot<StashesPayload>();
  rebuildChrome();
  if (!result.ok && !result.offline) {
    setStatus(`API error: ${result.error}`);
  }
  // Fetch the switchable repo list once (live mode only).
  if (state.source === 'live' && state.repos.length === 0) {
    const repos = await loadRepos();
    if (repos.ok && repos.repos.length > 0) {
      state.repos = repos.repos;
      if (!state.repo) {
        state.repo = repos.repos.find(r => r.current)?.path ?? null;
      }
      rebuildChrome();
    }
  }
  // Learn whether the companion permits local stash mutations (W25).
  if (state.source === 'live') {
    const health = await loadHealth();
    const allow = health.ok && health.health.allowMutations;
    if (allow !== state.allowMutations) {
      state.allowMutations = allow;
      if (state.view === 'stashes') rebuildChrome();
    }
  }
  // Open (or re-point) the live-refresh stream now we know the repo (W17).
  if (state.source === 'live') live.restart(state.repo);
  else live.stop();

  // Open a commit permalink once the snapshot is in hand (W27). Only on the
  // graph view, and only if the row still exists in the loaded history.
  if (pendingCommitSha && state.view === 'graph') {
    const sha = pendingCommitSha;
    pendingCommitSha = null;
    if (state.snapshot.commits.some(c => c.sha.toLowerCase().startsWith(sha))) {
      openDetailFor(sha);
    }
  }
}

/**
 * The companion reported the repo's graph changed (W17). Re-pull the
 * snapshot and re-render the active view in place. We preserve the current
 * filter, selection sha, and scroll position so a refresh while the user
 * reads a commit doesn't yank them around.
 */
let liveRefreshing = false;
async function onLiveRefresh(): Promise<void> {
  if (state.source !== 'live' || liveRefreshing) return;
  liveRefreshing = true;
  try {
    const result = await loadSnapshot({ repo: state.repo ?? undefined });
    if (!result.ok) return;
    state.snapshot = result.snapshot;
    // Invalidate cached per-view payloads — they're derived from history.
    state.activity = slot<ActivityPayload>();
    state.contributors = slot<ContributorsPayload>();
    state.compare = slot<ComparePayload>();
    state.stashes = slot<StashesPayload>();
    // Re-render the active view; graph keeps the user's place via the
    // controller's selection + the surface's scrollTop.
    const keepSha = graphController?.selectedSha() ?? null;
    if (state.view === 'graph') {
      renderGraphView();
      if (keepSha) graphController?.selectSha(keepSha);
    } else if (state.view === 'activity') {
      void ensureActivity();
    } else if (state.view === 'contributors') {
      void ensureContributors();
    } else if (state.view === 'compare') {
      void ensureCompare();
    } else if (state.view === 'stashes') {
      void ensureStashes();
    }
    // Refresh the HEAD chip in the top bar.
    refreshHeadChip();
    flashLiveIndicator();
  } finally {
    liveRefreshing = false;
  }
}

/** Switch the served repo and reload from scratch. */
function switchRepo(entry: RepoEntry): void {
  if (entry.path === state.repo) return;
  state.repo = entry.path;
  state.filter = '';
  state.view = 'graph';
  state.repos = state.repos.map(r => ({ ...r, current: r.path === entry.path }));
  void boot();
}

// ── Top bar ──────────────────────────────────────────────────────────
function buildTopbar(): HTMLElement {
  const bar = el('header', 'topbar');
  const brand = el('div', 'brand');
  brand.innerHTML = `<span class="mark">${icons.mark}</span><span>GitSight</span>`;
  const picker = createRepoPicker({ repos: state.repos, onPick: entry => switchRepo(entry) });
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
  meta.innerHTML = `<span class="chip">${icons.graph}<span>${escapeText(state.snapshot.head)}</span></span>`;

  const palettePicker = createPalettePicker({
    current: theme.palette,
    onPick: name => {
      theme.setPalette(name);
      renderView();
    },
  });

  // Command-palette trigger (W26) — discoverable Cmd-K affordance.
  const cmdBtn = el('button', 'btn cmdk-btn');
  cmdBtn.title = 'Command palette';
  cmdBtn.setAttribute('aria-label', 'Open command palette');
  const cmdKey = isApplePlatform() ? '\u2318K' : 'Ctrl K';
  cmdBtn.innerHTML = `<span class="icon">${icons.command}</span><kbd>${cmdKey}</kbd>`;
  cmdBtn.addEventListener('click', () => palette.show());

  const toggle = el('button', 'btn icon-only');
  const renderToggle = () => {
    toggle.innerHTML = theme.chrome === 'dark' ? icons.sun : icons.moon;
    toggle.title = theme.chrome === 'dark' ? 'Switch to light' : 'Switch to dark';
  };
  renderToggle();
  toggle.addEventListener('click', () => {
    theme.toggleChrome();
    renderToggle();
    renderView();
  });

  bar.append(brand, spacer, meta, palettePicker, cmdBtn, toggle);
  return bar;
}

// ── View tabs ────────────────────────────────────────────────────────
const TABS: Array<{ id: AppView; label: string; icon: keyof typeof icons }> = [
  { id: 'graph', label: 'Graph', icon: 'graph' },
  { id: 'activity', label: 'Activity', icon: 'calendar' },
  { id: 'contributors', label: 'Contributors', icon: 'users' },
  { id: 'blame', label: 'Blame', icon: 'blame' },
  { id: 'compare', label: 'Compare', icon: 'gitCompare' },
  { id: 'stashes', label: 'Stashes', icon: 'archive' },
];

function buildTabs(): HTMLElement {
  const nav = el('nav', 'tabs');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Views');
  for (const tab of TABS) {
    const btn = el('button', 'tab' + (state.view === tab.id ? ' active' : ''));
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(state.view === tab.id));
    btn.innerHTML = `<span class="tab-ico">${icons[tab.icon]}</span><span class="tab-label">${tab.label}</span>`;
    btn.addEventListener('click', () => switchView(tab.id));
    nav.appendChild(btn);
  }
  return nav;
}

function switchView(view: AppView): void {
  if (state.view === view) return;
  state.view = view;
  detailPanel.close();
  dayPanel.close();
  authorPanel.close();
  rebuildChrome();
  syncHash();
  // Lazily kick off the data load for the freshly-opened view.
  if (view === 'activity') void ensureActivity();
  if (view === 'contributors') void ensureContributors();
  if (view === 'compare') void ensureCompare();
  if (view === 'stashes') void ensureStashes();
}

// ── Toolbar (search + actions) ───────────────────────────────────────
function buildToolbar(): HTMLElement {
  const bar = el('div', 'toolbar');

  // The toolbar only carries graph controls; other views render their
  // own controls in their surface. Keep a slim bar with the source label.
  if (state.view !== 'graph') {
    const note = el('div', 'toolbar-note');
    note.textContent = TABS.find(t => t.id === state.view)?.label ?? '';
    bar.appendChild(note);
    const spacer = el('div', 'spacer');
    spacer.style.flex = '1';
    bar.appendChild(spacer);
    return bar;
  }

  // Ref-rail toggle.
  const railToggle = el('button', 'btn icon-only' + (state.railOpen ? ' on' : ''));
  railToggle.title = state.railOpen ? 'Hide ref sidebar' : 'Show ref sidebar';
  railToggle.setAttribute('aria-label', 'Toggle ref sidebar');
  railToggle.setAttribute('aria-pressed', String(state.railOpen));
  railToggle.innerHTML = icons.sidebar;
  railToggle.addEventListener('click', () => toggleRail());

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
  let recordTimer: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      state.filter = input.value.trim();
      rebuildMainArea();
      renderView();
    }, 120);
    // Record the query as a recent only after the user pauses typing, so we
    // don't store every intermediate keystroke (W30).
    window.clearTimeout(recordTimer);
    recordTimer = window.setTimeout(() => {
      if (state.filter) searchHistory.record(state.filter);
    }, 900);
  });
  search.appendChild(input);
  // Surface recent/pinned filters as a dropdown under the box (W30).
  searchHistory.attach(input, search);

  const help = el('button', 'btn icon-only');
  help.title = 'Search syntax';
  help.setAttribute('aria-label', 'Search syntax help');
  help.innerHTML = icons.help;
  help.addEventListener('click', () => toggleSearchHelp(help));

  // Export the current graph view as a standalone SVG (W15).
  const exportBtn = el('button', 'btn icon-only');
  exportBtn.title = 'Export graph as SVG';
  exportBtn.setAttribute('aria-label', 'Export graph as SVG');
  exportBtn.innerHTML = icons.download;
  exportBtn.addEventListener('click', () => exportSvg());

  const refresh = el('button', 'btn icon-only');
  refresh.title = 'Reload from repository';
  refresh.innerHTML = icons.refresh;
  refresh.addEventListener('click', () => void boot());

  bar.append(railToggle, search, help, exportBtn, refresh);
  return bar;
}

/** Toggle the ref rail (or its drawer, on narrow viewports). */
function toggleRail(): void {
  state.railOpen = !state.railOpen;
  rebuildMainArea();
  renderView();
  // Keep the toolbar button's pressed state in sync.
  const btn = document.querySelector<HTMLElement>('.toolbar .btn.icon-only');
  if (btn) {
    btn.classList.toggle('on', state.railOpen);
    btn.setAttribute('aria-pressed', String(state.railOpen));
  }
}

/** Build + download the current graph as a standalone SVG (W15). */
function exportSvg(): void {
  const colours = exportColours();
  const name = downloadGraphSvg(state.snapshot, {
    theme: theme.palette,
    filter: state.filter,
    colours,
  });
  if (name) toast(`Saved ${name}`);
  else toast('Nothing to export');
}

/** Read the current chrome colours so the export matches the on-screen theme. */
function exportColours(): { background: string; foreground: string; muted: string } {
  const style = getComputedStyle(document.documentElement);
  const pick = (v: string, fallback: string) => {
    const c = style.getPropertyValue(v).trim();
    return /^#[0-9a-f]{3,8}$/i.test(c) ? c : fallback;
  };
  return {
    background: pick('--bg', '#0d1117'),
    foreground: pick('--fg', '#e6edf3'),
    muted: pick('--fg-faint', '#7d8590'),
  };
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

// ── Main area (rail + surface) ───────────────────────────────────────
function buildMainArea(): HTMLElement {
  const area = el('div', 'main-area');
  // The ref rail only belongs to the graph view.
  if (state.view === 'graph' && state.railOpen) {
    const rail = createRefRail({
      snapshot: state.snapshot,
      activeRef: activeRefFromFilter(state.filter),
      onPick: query => applyFilter(query),
      onClear: () => applyFilter(''),
      onShowDetail: (ref, anchor) => showRefDetail(ref, anchor),
    });
    if (rail) {
      if (state.layout.railIsDrawer) rail.classList.add('drawer');
      area.appendChild(rail);
      // A scrim closes the drawer on outside click (drawer mode only).
      if (state.layout.railIsDrawer) {
        const scrim = el('div', 'rail-scrim');
        scrim.addEventListener('click', () => toggleRail());
        area.appendChild(scrim);
      }
    }
  }
  const surface = el('section', 'surface');
  surface.id = 'surface';
  area.appendChild(surface);
  return area;
}

/** Set the filter (from a rail/cell click), sync the input, and re-render. */
function applyFilter(query: string): void {
  state.filter = query;
  const input = document.getElementById('filter-input') as HTMLInputElement | null;
  if (input) input.value = query;
  // A deliberate filter (rail click, ref jump, search-syntax) is worth
  // remembering; an empty clear is not (W30).
  if (query) searchHistory.record(query);
  rebuildMainArea();
  renderView();
}

/** Replace just the main area (rail + surface) in place + re-render. */
function rebuildMainArea(): void {
  const old = document.querySelector('.main-area');
  if (old) old.replaceWith(buildMainArea());
}

/**
 * Find HEAD's tip sha in the loaded snapshot (W29). HEAD is the commit
 * carrying a `HEAD -> ` decoration, or a bare `HEAD` ref; falls back to the
 * newest commit so ahead/behind still has a sensible baseline.
 */
function headTipSha(): string {
  const commits = state.snapshot.commits;
  const head = commits.find(c =>
    c.refs.some(r => /^HEAD\b/.test(r.trim()) || r.trim() === 'HEAD'),
  );
  return head?.sha ?? commits[0]?.sha ?? '';
}

/**
 * Open the ref-detail popover (W29) for a rail ref: tip commit + ahead/
 * behind vs HEAD (computed client-side), with filter / open-tip / compare
 * actions. All data comes from the loaded snapshot — no backend call.
 */
function showRefDetail(ref: RailRef, anchor: HTMLElement): void {
  openRefDetail(ref, anchor, state.snapshot.commits, headTipSha(), {
    onFilter: r => applyFilter(refQueryFor(r)),
    onOpenTip: sha => openDetailFor(sha),
    onCompare: r => compareRefToHead(r),
  });
}

/** The `ref:` query for a rail ref (quote when the name needs it). */
function refQueryFor(ref: RailRef): string {
  return /[\s"]/.test(ref.name) ? `ref:"${ref.name}"` : `ref:${ref.name}`;
}

/** Compare a ref against HEAD in the Compare view (W29 action). */
function compareRefToHead(ref: RailRef): void {
  state.view = 'compare';
  rebuildChrome();
  syncHash();
  void runCompare(ref.name, 'HEAD');
}

function showLoading(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = el('div', 'state');
  s.innerHTML = `<span class="spinner"></span><p>Reading commit history…</p>`;
  surface.replaceChildren(s);
}

// ── View dispatch ────────────────────────────────────────────────────
function renderView(): void {
  switch (state.view) {
    case 'graph':
      return renderGraphView();
    case 'activity':
      return renderActivityView();
    case 'contributors':
      return renderContributorsView();
    case 'blame':
      return renderBlameView();
    case 'compare':
      return renderCompareView();
    case 'stashes':
      return renderStashesView();
  }
}

function renderGraphView(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  graphController?.dispose();
  const result = renderGraph(state.snapshot, {
    theme: theme.palette,
    filter: state.filter,
    scrollContainer: surface,
    onSelect: (c: GraphSnapshotCommit) => {
      setStatus(`${c.shortSha}  ${c.subject}`);
      void detailPanel.open(c.sha);
    },
    onCopySha: (sha: string) => void copySha(sha),
    onContextMenu: (c: GraphSnapshotCommit, e: MouseEvent) => showCommitMenu(c, e),
  });
  graphController = result.controller;
  if (result.rendered === 0) {
    graphController.dispose();
    graphController = null;
    surface.replaceChildren(emptyState());
  } else {
    surface.replaceChildren(result.node);
  }
  updateCount(result.rendered, result.total);
}

function renderActivityView(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = state.activity;
  if (s.status === 'loading' || s.status === 'idle') {
    surface.replaceChildren(loadingState('Counting commits per day…'));
    void ensureActivity();
    return;
  }
  if (s.status === 'error' || !s.data) {
    surface.replaceChildren(errorState('Could not load activity', s.error));
    return;
  }
  const node = renderActivity(s.data, {
    onPickDay: day => {
      void dayPanel.open(day.date);
    },
  });
  surface.replaceChildren(node);
  updateCount(s.data.total, s.data.total, 'commits');
}

function renderContributorsView(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = state.contributors;
  if (s.status === 'loading' || s.status === 'idle') {
    surface.replaceChildren(loadingState('Tallying contributors…'));
    void ensureContributors();
    return;
  }
  if (s.status === 'error' || !s.data) {
    surface.replaceChildren(errorState('Could not load contributors', s.error));
    return;
  }
  const node = renderContributors(s.data, {
    onPick: c => {
      void authorPanel.open(c.email || c.name, c.name);
    },
  });
  surface.replaceChildren(node);
  updateCount(s.data.totalAuthors, s.data.totalAuthors, 'contributors');
}

function renderBlameView(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = state.blame;
  const opts = {
    path: state.blamePath ?? undefined,
    onLoad: (path: string) => loadBlamePath(path),
    revealLine: state.blameLine,
    rev: state.blameRev,
  };
  if (s.status === 'loading') {
    const wrap = el('div', 'blame');
    wrap.appendChild(loadingState(`Blaming ${state.blamePath ?? ''}…`));
    surface.replaceChildren(renderBlame(null, opts), wrap);
    return;
  }
  if (s.status === 'error') {
    surface.replaceChildren(renderBlame(null, opts));
    setStatus(`Blame error: ${s.error}`);
    return;
  }
  surface.replaceChildren(renderBlame(s.data, opts));
  if (s.data) updateCount(s.data.totalLines, s.data.totalLines, 'lines');
}

function renderCompareView(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = state.compare;
  const opts = {
    base: state.compareBase,
    head: state.compareHead,
    onCompare: (base: string, head: string) => runCompare(base, head),
    loadDiff: (rev: string, path: string) => loadFileDiff(rev, path, { repo: state.repo ?? undefined }),
    onOpenCommit: (sha: string) => openDetailFor(sha),
    onCopySha: (sha: string) => void copySha(sha),
    onShareLink: () => void shareCompareLink(),
  };
  if (s.status === 'loading') {
    const wrap = el('div', 'compare-loading-wrap');
    wrap.appendChild(loadingState(`Comparing ${state.compareBase} \u2194 ${state.compareHead}…`));
    surface.replaceChildren(renderCompare(null, opts), wrap);
    return;
  }
  if (s.status === 'error') {
    surface.replaceChildren(renderCompare(null, opts));
    setStatus(`Compare error: ${s.error}`);
    return;
  }
  surface.replaceChildren(renderCompare(s.data, opts));
  if (s.data) updateCount(s.data.filesChanged, s.data.filesChanged, 'files');
}

function renderStashesView(): void {
  const surface = document.getElementById('surface');
  if (!surface) return;
  const s = state.stashes;
  if (s.status === 'loading' || s.status === 'idle') {
    surface.replaceChildren(loadingState('Reading stashes…'));
    void ensureStashes();
    return;
  }
  if (s.status === 'error' || !s.data) {
    surface.replaceChildren(errorState('Could not load stashes', s.error));
    return;
  }
  const node = renderStashes(s.data, {
    loadDiff: (index: number, path: string) => loadStashDiff(index, path, { repo: state.repo ?? undefined }),
    onAction: state.allowMutations ? (action, entry) => void runStashMutation(action, entry) : undefined,
  });
  surface.replaceChildren(node);
  updateCount(s.data.total, s.data.total, s.data.total === 1 ? 'stash' : 'stashes');
}

// ── Lazy data loaders ────────────────────────────────────────────────
async function ensureActivity(): Promise<void> {
  if (state.activity.status === 'loading' || state.activity.status === 'ready') return;
  state.activity.status = 'loading';
  const res = await loadActivity({ repo: state.repo ?? undefined });
  if (res.ok) state.activity = { status: 'ready', data: res.activity, error: '' };
  else state.activity = { status: 'error', data: null, error: res.error };
  if (state.view === 'activity') renderActivityView();
}

async function ensureContributors(): Promise<void> {
  if (state.contributors.status === 'loading' || state.contributors.status === 'ready') return;
  state.contributors.status = 'loading';
  const res = await loadContributors({ repo: state.repo ?? undefined });
  if (res.ok) state.contributors = { status: 'ready', data: res.stats, error: '' };
  else state.contributors = { status: 'error', data: null, error: res.error };
  if (state.view === 'contributors') renderContributorsView();
}

/** Lazily load the default compare (base...head) when the tab first opens. */
async function ensureCompare(): Promise<void> {
  if (state.compare.status === 'loading' || state.compare.status === 'ready') return;
  await runCompare(state.compareBase, state.compareHead);
}

/** Run a fresh comparison for a ref pair (W18). */
async function runCompare(base: string, head: string): Promise<void> {
  state.compareBase = base;
  state.compareHead = head;
  state.compare = { status: 'loading', data: null, error: '' };
  // Reflect the ref pair in the URL so the comparison is shareable (W24).
  syncHash();
  if (state.view === 'compare') renderCompareView();
  const res = await loadCompare(base, head, { repo: state.repo ?? undefined });
  if (res.ok) state.compare = { status: 'ready', data: res.comparison, error: '' };
  else state.compare = { status: 'error', data: null, error: res.error };
  if (state.view === 'compare') renderCompareView();
}

/**
 * Copy a shareable deep link to the current comparison (W24). Ensures the
 * hash is current, then copies the full URL.
 */
async function shareCompareLink(): Promise<void> {
  syncHash();
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Comparison link copied');
  } catch {
    toast('Copy failed');
  }
}

/** Lazily load the stash list when the tab first opens (W19). */
async function ensureStashes(): Promise<void> {
  if (state.stashes.status === 'loading' || state.stashes.status === 'ready') return;
  state.stashes.status = 'loading';
  const res = await loadStashes({ repo: state.repo ?? undefined });
  if (res.ok) state.stashes = { status: 'ready', data: res.stashes, error: '' };
  else state.stashes = { status: 'error', data: null, error: res.error };
  if (state.view === 'stashes') renderStashesView();
}

/**
 * Run a confirmed local-only stash mutation (W25). Apply/pop/drop all
 * touch the working tree, so each goes through a confirm() gate first; on
 * success we re-render from the fresh list the companion returns and toast
 * the outcome.
 */
async function runStashMutation(
  action: StashActionKind,
  entry: { index: number; branch: string },
): Promise<void> {
  const verb = action === 'apply' ? 'Apply' : action === 'pop' ? 'Pop' : 'Drop';
  const ref = `stash@{${entry.index}}`;
  const warn =
    action === 'drop'
      ? `Drop ${ref}? This permanently discards the stash and cannot be undone.`
      : action === 'pop'
        ? `Pop ${ref}? This applies it to your working tree and removes the stash.`
        : `Apply ${ref} to your working tree? The stash is kept.`;
  if (typeof confirm === 'function' && !confirm(warn)) return;

  const res = await runStashAction(action, entry.index, { repo: state.repo ?? undefined });
  if (res.ok) {
    state.stashes = { status: 'ready', data: { stashes: res.result.stashes, total: res.result.total }, error: '' };
    renderStashesView();
    const past = action === 'apply' ? 'applied' : action === 'pop' ? 'popped' : 'dropped';
    toast(`Stash ${past}`);
  } else {
    toast(`${verb} failed: ${res.error}`);
  }
}

async function loadBlamePath(input: string): Promise<void> {
  // Accept `path`, `path:42`, or `path#L42` so the user can jump to a line.
  const target = parseBlameTarget(input);
  if (!target.path) return;
  // A manual path entry blames at HEAD; W28 blame-at-commit uses loadBlameAt.
  await runBlame('HEAD', target.path, target.line);
}

/** Blame a path at a specific revision (W28 "Blame at this commit"). */
async function loadBlameAt(rev: string, path: string): Promise<void> {
  await runBlame(rev, path, null);
}

/** Shared blame loader: fetch `path` at `rev`, optionally revealing a line. */
async function runBlame(rev: string, path: string, line: number | null): Promise<void> {
  state.blamePath = path;
  state.blameRev = rev;
  state.blameLine = line;
  state.blame = { status: 'loading', data: null, error: '' };
  renderBlameView();
  const res = await loadBlame(rev, path, { repo: state.repo ?? undefined });
  if (res.ok) state.blame = { status: 'ready', data: res.blame, error: '' };
  else state.blame = { status: 'error', data: null, error: res.error };
  if (state.view === 'blame') renderBlameView();
}

// ── Shared surface states ────────────────────────────────────────────
function loadingState(msg: string): HTMLElement {
  const s = el('div', 'state');
  s.innerHTML = `<span class="spinner"></span><p>${escapeText(msg)}</p>`;
  return s;
}

function errorState(title: string, detail: string): HTMLElement {
  const s = el('div', 'state error');
  s.innerHTML =
    `<span class="glyph">${icons.warn}</span>` +
    `<h2>${escapeText(title)}</h2>` +
    `<p>${escapeText(detail)}</p>`;
  return s;
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
    `<span id="status-msg"></span>` +
    `<span id="status-live" class="status-live" hidden>` +
    `<span class="live-dot"></span><span class="live-label"></span></span>`;
  updateLiveIndicator(bar);
  return bar;
}

/** Live-refresh status pill text (W17). */
const LIVE_LABEL: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Watching',
  disconnected: 'Offline',
};

/** Reflect the live connection status into the status-bar pill. */
function updateLiveIndicator(scope: HTMLElement | Document = document): void {
  const pill = scope.querySelector<HTMLElement>('#status-live');
  if (!pill) return;
  // The live pill only makes sense against a real backend.
  if (state.source !== 'live') {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.dataset.state = state.live;
  const label = pill.querySelector<HTMLElement>('.live-label');
  if (label) label.textContent = LIVE_LABEL[state.live];
  pill.title =
    state.live === 'connected'
      ? 'Watching the repository for changes — the graph refreshes automatically.'
      : state.live === 'connecting'
        ? 'Connecting to the live-refresh stream…'
        : 'Live refresh offline — retrying.';
}

/** Briefly pulse the live pill to acknowledge an auto-refresh (W17). */
function flashLiveIndicator(): void {
  const pill = document.querySelector<HTMLElement>('#status-live');
  if (!pill) return;
  pill.classList.remove('pulse');
  // Force a reflow so re-adding the class restarts the animation.
  void pill.offsetWidth;
  pill.classList.add('pulse');
}

/** Repaint the HEAD chip in the top bar after a live refresh (W17). */
function refreshHeadChip(): void {
  const chip = document.querySelector<HTMLElement>('.topbar .meta .chip span');
  if (chip) chip.textContent = state.snapshot.head;
}

function updateCount(rendered: number, total: number, noun = 'commits'): void {
  const c = document.getElementById('status-count');
  if (!c) return;
  c.textContent = rendered === total ? `${total} ${noun}` : `${rendered} of ${total} ${noun}`;
}

function setStatus(msg: string): void {
  const m = document.getElementById('status-msg');
  if (m) m.textContent = msg;
}

// ── Keyboard navigation (W4) ─────────────────────────────────────────
function installKeyboard(): void {
  document.addEventListener('keydown', e => {
    // Cmd-K / Ctrl-K toggles the command palette from anywhere (W26).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette.toggle();
      return;
    }
    // While the palette is open it owns the keyboard.
    if (palette.isOpen()) return;
    const input = document.getElementById('filter-input') as HTMLInputElement | null;
    if (e.key === '/' && document.activeElement !== input && state.view === 'graph') {
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
          renderView();
        }
      }
      return;
    }
    if (state.view !== 'graph') return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      graphController?.activateSelected();
    } else if (e.key === 'Escape' && detailPanel.isOpen()) {
      detailPanel.close();
    }
  });
}

function moveSelection(delta: number): void {
  if (!graphController) return;
  const commit = graphController.move(delta);
  if (commit) setStatus(`${commit.shortSha}  ${commit.subject}`);
}

// ── Deep-link hash routing (W24) ─────────────────────────────────────
/**
 * Apply the URL hash to the initial state (before first paint). A
 * `#compare?base=..&head=..` link opens the Compare tab pre-loaded with
 * that ref pair; a bare `#stashes` etc opens that tab.
 */
function applyInitialRoute(): void {
  const route = parseHash(typeof location !== 'undefined' ? location.hash : '');
  if (!route) return;
  state.view = route.view;
  if (route.view === 'compare' && route.base && route.head) {
    state.compareBase = route.base;
    state.compareHead = route.head;
  }
  // Remember a commit permalink (#commit/<sha>, W27); boot() opens the
  // detail panel once the snapshot has loaded.
  if (route.view === 'graph' && route.sha) {
    pendingCommitSha = route.sha;
  }
}

/** A commit sha from a #commit/<sha> permalink, opened after boot (W27). */
let pendingCommitSha: string | null = null;

/** True while we're writing the hash ourselves, to ignore the echo event. */
let writingHash = false;

/** Write the current view/compare state into location.hash (W24; W27). */
function syncHash(): void {
  if (typeof location === 'undefined') return;
  let route: Route;
  if (state.view === 'compare') {
    route = { view: 'compare', base: state.compareBase, head: state.compareHead };
  } else if (state.view === 'graph' && detailPanel.isOpen() && detailPanel.currentSha()) {
    // A permalink to the focused commit (W27).
    route = { view: 'graph', sha: detailPanel.currentSha()! };
  } else {
    route = { view: state.view };
  }
  const next = buildHash(route);
  if (!hashChanged(location.hash, `#${next}`)) return;
  writingHash = true;
  // Empty hash -> clear it without leaving a bare '#'.
  if (next) location.hash = next;
  else history.replaceState(null, '', location.pathname + location.search);
  // The hashchange event fires async; clear the guard on the next tick.
  setTimeout(() => {
    writingHash = false;
  }, 0);
}

/** Listen for back/forward (hashchange) and re-apply the route (W24; W27). */
function installHashRouting(): void {
  window.addEventListener('hashchange', () => {
    if (writingHash) return;
    const route = parseHash(location.hash);
    if (!route) {
      // Hash cleared (e.g. back to base URL) -> close any open permalink.
      if (state.view === 'graph' && detailPanel.isOpen()) detailPanel.close();
      return;
    }
    if (route.view === 'compare' && route.base && route.head) {
      const changed = route.base !== state.compareBase || route.head !== state.compareHead;
      state.compareBase = route.base;
      state.compareHead = route.head;
      if (changed) state.compare = slot<ComparePayload>();
    }
    // Commit permalink on the graph view (W27): swap to graph WITHOUT the
    // panel-closing switchView does, then open/close the detail to match the
    // URL so back/forward navigates focused commits.
    if (route.view === 'graph' && route.sha) {
      if (state.view !== 'graph') {
        state.view = 'graph';
        dayPanel.close();
        authorPanel.close();
        rebuildChrome();
      }
      if (detailPanel.currentSha() !== route.sha) openDetailFor(route.sha);
      return;
    }
    if (route.view !== state.view) {
      switchView(route.view);
    } else if (route.view === 'compare') {
      void ensureCompare();
    } else if (route.view === 'graph' && detailPanel.isOpen()) {
      // Same view, no sha in the URL -> close an open permalink.
      detailPanel.close();
    }
  });
}

// ── Responsive (W11) ─────────────────────────────────────────────────
function installResize(): void {
  let lastWidth = window.innerWidth;
  // Default the rail closed on a narrow first paint so it doesn't cover
  // the graph as a drawer on load.
  if (state.layout.railIsDrawer) state.railOpen = false;
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    if (layoutChanged(lastWidth, w)) {
      const wasDrawer = state.layout.railIsDrawer;
      state.layout = layoutFor(w);
      // Entering drawer mode hides the rail; leaving restores it.
      if (!wasDrawer && state.layout.railIsDrawer) state.railOpen = false;
      if (wasDrawer && !state.layout.railIsDrawer) state.railOpen = true;
      rebuildChrome();
    }
    lastWidth = w;
  });
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

/** Copy arbitrary text with a custom toast (W28 context-menu actions). */
async function copyText(text: string, ok: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
  } catch {
    toast('Copy failed');
  }
}

/**
 * Copy a #commit/<sha> permalink to a specific commit (W27). Ensures the
 * hash reflects the focused commit, then copies the full URL so a teammate
 * lands on the same commit's detail panel.
 */
async function copyCommitLink(sha: string): Promise<void> {
  if (typeof location === 'undefined') return;
  const hash = buildHash({ view: 'graph', sha });
  const url = `${location.origin}${location.pathname}${location.search}${hash ? `#${hash}` : ''}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Commit link copied');
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

/** True on macOS/iOS so we can show the Cmd glyph instead of Ctrl (W26). */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  return /Mac|iPhone|iPad|iPod/i.test(p);
}

mount();
