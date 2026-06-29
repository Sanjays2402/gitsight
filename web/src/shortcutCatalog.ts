/**
 * Pure keyboard-shortcut catalog (W37).
 *
 * DOM-free + framework-free + NO @shared import, so it's unit-tested under
 * node --test. The help overlay (keyboardHelp.ts) renders this catalog as a
 * grouped cheat-sheet; keeping the data + the "which shortcuts apply to the
 * current view" filter pure means the grouping/labels are covered without a
 * DOM.
 *
 * Each shortcut carries the key(s) to render as <kbd> chips, a description,
 * and the set of views it applies to (empty = global). The catalog mirrors
 * the bindings wired in main.ts (installKeyboard) + the palette.
 *
 * Tests: web/src/shortcutCatalog.test.mjs
 */

/** The views a shortcut can be scoped to (mirrors AppView in main.ts). */
export type HelpView = 'graph' | 'activity' | 'contributors' | 'blame' | 'compare' | 'stashes';

export interface Shortcut {
  /** Key chips to render, in order (e.g. ['Cmd', 'K'] or ['j']). */
  keys: string[];
  /** What the shortcut does. */
  description: string;
  /**
   * Views this binding applies to. Empty array = global (every view). When
   * non-empty, the shortcut only shows while one of these views is active.
   */
  views?: HelpView[];
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

/**
 * The platform-aware modifier label. macOS shows the Cmd glyph; everything
 * else shows "Ctrl". The host passes whether it's a Mac (navigator.platform
 * /userAgentData) so this module stays DOM-free.
 */
export function modKeyLabel(isMac: boolean): string {
  return isMac ? '\u2318' : 'Ctrl';
}

/**
 * Build the full shortcut catalog. `isMac` swaps the Cmd/Ctrl label so the
 * chips match the user's platform.
 */
export function buildShortcutCatalog(isMac: boolean): ShortcutGroup[] {
  const mod = modKeyLabel(isMac);
  return [
    {
      title: 'Global',
      shortcuts: [
        { keys: [mod, 'K'], description: 'Open the command palette' },
        { keys: ['?'], description: 'Show this keyboard help' },
        { keys: ['Esc'], description: 'Close an overlay, panel, or clear search' },
      ],
    },
    {
      title: 'Graph',
      shortcuts: [
        { keys: ['j'], description: 'Select the next commit', views: ['graph'] },
        { keys: ['k'], description: 'Select the previous commit', views: ['graph'] },
        { keys: ['\u2193'], description: 'Select the next commit', views: ['graph'] },
        { keys: ['\u2191'], description: 'Select the previous commit', views: ['graph'] },
        { keys: ['Enter'], description: 'Open the selected commit detail', views: ['graph'] },
        { keys: ['/'], description: 'Focus the search box', views: ['graph'] },
      ],
    },
    {
      title: 'Search',
      shortcuts: [
        { keys: ['Esc'], description: 'Clear the query and blur the box', views: ['graph'] },
        { keys: ['author:', 'me'], description: 'Filter by author (also grep: ref: since: until: sha:)', views: ['graph'] },
      ],
    },
    {
      title: 'Activity',
      shortcuts: [
        { keys: ['\u2190'], description: 'Scope the calendar to the older year', views: ['activity'] },
        { keys: ['\u2192'], description: 'Scope the calendar to the newer year', views: ['activity'] },
        { keys: ['m'], description: 'Toggle the commits / churn metric', views: ['activity'] },
        { keys: ['p'], description: 'Pin a focused day\u2019s commit preview (Esc closes)', views: ['activity'] },
      ],
    },
    {
      title: 'Compare',
      shortcuts: [
        { keys: ['\u2193'], description: 'Step to the next commit-filter match', views: ['compare'] },
        { keys: ['\u2191'], description: 'Step to the previous commit-filter match', views: ['compare'] },
        { keys: ['Enter'], description: 'Open the focused commit-filter match', views: ['compare'] },
      ],
    },
    {
      title: 'Contributors',
      shortcuts: [
        { keys: ['s'], description: 'Swap the open comparison\u2019s left / right order', views: ['contributors'] },
        { keys: ['n'], description: 'Sort by name', views: ['contributors'] },
        { keys: ['c'], description: 'Sort by commits', views: ['contributors'] },
        { keys: ['r'], description: 'Sort by most recent', views: ['contributors'] },
        { keys: ['m'], description: 'Sort by churn (most lines)', views: ['contributors'] },
        { keys: ['Esc'], description: 'Close the open comparison panel', views: ['contributors'] },
      ],
    },
    {
      title: 'Blame',
      shortcuts: [
        { keys: ['a'], description: 'Cycle the isolated author (Esc-free)', views: ['blame'] },
        { keys: ['c'], description: 'Filter to concentrated-ownership authors', views: ['blame'] },
        { keys: ['t'], description: 'Filter to spread-thin authors', views: ['blame'] },
      ],
    },
    {
      title: 'Stashes',
      shortcuts: [
        { keys: ['Esc'], description: 'Clear the active stash filter', views: ['stashes'] },
      ],
    },
  ];
}

/**
 * Filter the catalog to the shortcuts relevant for `view`: global shortcuts
 * (no `views` or an empty list) always pass; scoped shortcuts pass only when
 * `view` is in their list. Groups that end up empty are dropped so the
 * overlay never shows a bare heading.
 */
export function shortcutsForView(catalog: ShortcutGroup[], view: HelpView): ShortcutGroup[] {
  const out: ShortcutGroup[] = [];
  for (const group of catalog) {
    const shortcuts = group.shortcuts.filter(s => appliesTo(s, view));
    if (shortcuts.length > 0) out.push({ title: group.title, shortcuts });
  }
  return out;
}

/** True when a shortcut applies to the given view (global or scoped-in). */
export function appliesTo(shortcut: Shortcut, view: HelpView): boolean {
  if (!shortcut.views || shortcut.views.length === 0) return true;
  return shortcut.views.includes(view);
}

/** Total shortcut count across all groups (for the overlay's footer/count). */
export function countShortcuts(groups: ShortcutGroup[]): number {
  return groups.reduce((n, g) => n + g.shortcuts.length, 0);
}
