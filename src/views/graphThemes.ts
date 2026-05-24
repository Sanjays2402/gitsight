// Commit graph color themes — palette is consumed by src/webviews/commitGraph.ts
// to color lanes/branches in the SVG render.
import * as vscode from 'vscode';

export type ThemeName = 'default' | 'catppuccin' | 'tokyo-night' | 'dracula' | 'nord' | 'gruvbox' | 'solarized' | 'monochrome';

export const THEMES: Record<ThemeName, { name: string; palette: string[] }> = {
  'default':     { name: 'GitSight Default', palette: ['#f97316', '#3b82f6', '#10b981', '#ec4899', '#a855f7', '#eab308', '#06b6d4', '#ef4444', '#84cc16', '#14b8a6'] },
  'catppuccin':  { name: 'Catppuccin Mocha', palette: ['#f5a97f', '#8aadf4', '#a6da95', '#f5bde6', '#c6a0f6', '#eed49f', '#7dc4e4', '#ed8796', '#a6d189', '#8bd5ca'] },
  'tokyo-night': { name: 'Tokyo Night',      palette: ['#ff9e64', '#7aa2f7', '#9ece6a', '#bb9af7', '#c0caf5', '#e0af68', '#7dcfff', '#f7768e', '#9d7cd8', '#73daca'] },
  'dracula':     { name: 'Dracula',          palette: ['#ffb86c', '#8be9fd', '#50fa7b', '#ff79c6', '#bd93f9', '#f1fa8c', '#6272a4', '#ff5555', '#bd93f9', '#8be9fd'] },
  'nord':        { name: 'Nord',             palette: ['#d08770', '#5e81ac', '#a3be8c', '#b48ead', '#88c0d0', '#ebcb8b', '#81a1c1', '#bf616a', '#a3be8c', '#8fbcbb'] },
  'gruvbox':     { name: 'Gruvbox',          palette: ['#fe8019', '#83a598', '#b8bb26', '#d3869b', '#d65d0e', '#fabd2f', '#8ec07c', '#fb4934', '#b8bb26', '#458588'] },
  'solarized':   { name: 'Solarized',        palette: ['#cb4b16', '#268bd2', '#859900', '#d33682', '#6c71c4', '#b58900', '#2aa198', '#dc322f', '#859900', '#2aa198'] },
  'monochrome':  { name: 'Monochrome',       palette: ['#e5e7eb', '#9ca3af', '#6b7280', '#d1d5db', '#9ca3af', '#a3a3a3', '#737373', '#525252', '#a3a3a3', '#737373'] },
};

export function activePalette(): string[] {
  const cfg = vscode.workspace.getConfiguration('gitsight');
  const name = cfg.get<ThemeName>('graph.theme', 'default');
  return (THEMES[name] ?? THEMES.default).palette;
}

export async function pickTheme() {
  const cfg = vscode.workspace.getConfiguration('gitsight');
  const current = cfg.get<ThemeName>('graph.theme', 'default');
  type Item = vscode.QuickPickItem & { _key: ThemeName };
  const items: Item[] = (Object.keys(THEMES) as ThemeName[]).map(k => ({
    label: `${k === current ? '$(check)' : '$(circle-large-outline)'} ${THEMES[k].name}`,
    description: THEMES[k].palette.slice(0, 5).join(' '),
    _key: k,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a commit graph theme' });
  if (!picked) return;
  await cfg.update('graph.theme', picked._key, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Commit graph theme: ${THEMES[picked._key].name}. Reopen the graph to apply.`);
  vscode.commands.executeCommand('gitsight.commitGraph');
}
