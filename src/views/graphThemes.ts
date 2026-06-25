// Commit graph color themes — palette DATA now lives in the stack-agnostic
// shared module (src/shared/graphPalette.ts) so the standalone web app and
// this VS Code webview draw lanes with the same colours. This file keeps the
// vscode-coupled picker + active-palette resolver.
import * as vscode from 'vscode';
import { THEMES, THEME_NAMES, paletteFor, type ThemeName, type GraphTheme } from '../shared/graphPalette';

export type { ThemeName, GraphTheme };
export { THEMES };

export function activePalette(): string[] {
  const cfg = vscode.workspace.getConfiguration('gitsight');
  const name = cfg.get<ThemeName>('graph.theme', 'default');
  return paletteFor(name);
}

export async function pickTheme() {
  const cfg = vscode.workspace.getConfiguration('gitsight');
  const current = cfg.get<ThemeName>('graph.theme', 'default');
  type Item = vscode.QuickPickItem & { _key: ThemeName };
  const items: Item[] = THEME_NAMES.map(k => ({
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
