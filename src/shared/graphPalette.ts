/**
 * GitSight shared graph palettes (W1).
 *
 * STACK-AGNOSTIC palette data extracted from src/views/graphThemes.ts so
 * BOTH the VS Code webview and the standalone web app draw branch lanes
 * with the same colours. The vscode-coupled picker (`pickTheme`) stays in
 * the views layer; only the data + lookup live here.
 *
 * Tests: test/git/graphCore.test.ts
 */

export type ThemeName =
  | 'default'
  | 'catppuccin'
  | 'tokyo-night'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'solarized'
  | 'monochrome';

export interface GraphTheme {
  name: string;
  palette: string[];
}

export const THEMES: Record<ThemeName, GraphTheme> = {
  'default':     { name: 'GitSight Default', palette: ['#f97316', '#3b82f6', '#10b981', '#ec4899', '#a855f7', '#eab308', '#06b6d4', '#ef4444', '#84cc16', '#14b8a6'] },
  'catppuccin':  { name: 'Catppuccin Mocha', palette: ['#f5a97f', '#8aadf4', '#a6da95', '#f5bde6', '#c6a0f6', '#eed49f', '#7dc4e4', '#ed8796', '#a6d189', '#8bd5ca'] },
  'tokyo-night': { name: 'Tokyo Night',      palette: ['#ff9e64', '#7aa2f7', '#9ece6a', '#bb9af7', '#c0caf5', '#e0af68', '#7dcfff', '#f7768e', '#9d7cd8', '#73daca'] },
  'dracula':     { name: 'Dracula',          palette: ['#ffb86c', '#8be9fd', '#50fa7b', '#ff79c6', '#bd93f9', '#f1fa8c', '#6272a4', '#ff5555', '#bd93f9', '#8be9fd'] },
  'nord':        { name: 'Nord',             palette: ['#d08770', '#5e81ac', '#a3be8c', '#b48ead', '#88c0d0', '#ebcb8b', '#81a1c1', '#bf616a', '#a3be8c', '#8fbcbb'] },
  'gruvbox':     { name: 'Gruvbox',          palette: ['#fe8019', '#83a598', '#b8bb26', '#d3869b', '#d65d0e', '#fabd2f', '#8ec07c', '#fb4934', '#b8bb26', '#458588'] },
  'solarized':   { name: 'Solarized',        palette: ['#cb4b16', '#268bd2', '#859900', '#d33682', '#6c71c4', '#b58900', '#2aa198', '#dc322f', '#859900', '#2aa198'] },
  'monochrome':  { name: 'Monochrome',       palette: ['#e5e7eb', '#9ca3af', '#6b7280', '#d1d5db', '#9ca3af', '#a3a3a3', '#737373', '#525252', '#a3a3a3', '#737373'] },
};

/** All theme keys in display order. */
export const THEME_NAMES: ThemeName[] = Object.keys(THEMES) as ThemeName[];

/** Look up a palette by name, falling back to the default theme for any
 *  unknown / undefined key. Never returns an empty array. */
export function paletteFor(name: string | undefined): string[] {
  const theme = (name && (THEMES as Record<string, GraphTheme>)[name]) || THEMES.default;
  return theme.palette;
}

/** Narrow an arbitrary string to a known ThemeName, or undefined. */
export function asThemeName(name: string | undefined): ThemeName | undefined {
  return name && THEME_NAMES.includes(name as ThemeName) ? (name as ThemeName) : undefined;
}

/**
 * Deterministic per-author colour. Same hash the extension's
 * `colorForAuthor` uses, duplicated here so the web app doesn't have to
 * import the vscode-free-but-extension-located format helper. Stable hue,
 * fixed saturation/lightness for legibility on both light and dark.
 */
export function authorColor(author: string): string {
  let h = 0;
  for (const c of author) h = (h << 5) - h + c.charCodeAt(0);
  return `hsl(${Math.abs(h) % 360}, 65%, 60%)`;
}
