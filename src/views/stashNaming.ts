/**
 * Smart Stash Save (F43) — `gitsight.stashSaveSmart` command.
 *
 * Quick flow:
 *
 *   1. Compute a suggested name from the current branch + the dirty files
 *      (or the active editor's filename as a last resort).
 *   2. Show an input box pre-filled with the top suggestion and a button
 *      ("…") that opens a picker of all suggestions for one-tap swap.
 *   3. Stash with the chosen name. The user can also accept the bare WIP
 *      name by clearing the input box (matches existing `git stash` UX).
 *
 * Also exposed as `gitsight.stashSuggestNames` so other surfaces (like the
 * existing Stash Quick-Switcher's stashSave action) can borrow the picker
 * standalone.
 *
 * Pure name generation in src/git/stashNaming.ts (unit-tested).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import {
  suggestStashNames,
  bestSuggestion,
  dirtyPaths,
  NameSuggestion,
} from '../git/stashNaming';

const SAVE_COMMAND = 'gitsight.stashSaveSmart';
const SUGGEST_COMMAND = 'gitsight.stashSuggestNames';

export function registerStashNamingCommands(repoPicker: () => Git | undefined): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(SAVE_COMMAND, () =>
      run(() => smartStashSave(repoPicker())),
    ),
    vscode.commands.registerCommand(SUGGEST_COMMAND, () =>
      run(async () => {
        const git = repoPicker();
        if (!git) return;
        const picked = await pickName(await collectInputs(git));
        if (picked) await vscode.env.clipboard.writeText(picked);
        if (picked) vscode.window.setStatusBarMessage(`GitSight: copied "${picked}" to clipboard`, 2500);
      }),
    ),
  ];
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); }
  catch (e: any) { vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`); }
}

export async function smartStashSave(git: Git | undefined): Promise<void> {
  if (!git) { vscode.window.showWarningMessage('GitSight: no Git repo.'); return; }
  const inputs = await collectInputs(git);
  if (!inputs.dirtyPaths.length) {
    vscode.window.showInformationMessage('GitSight: nothing to stash — working tree is clean.');
    return;
  }
  const preset = bestSuggestion(inputs);
  const name = await promptForName(preset, inputs);
  if (name === undefined) return; // user cancelled

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: stash "${name || '(unnamed)'}"…` },
    async () => {
      try {
        if (name) await git.stashSave(name);
        else await git.stashSave();
        vscode.window.setStatusBarMessage(`Stashed: ${name || '(unnamed WIP)'}`, 3500);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: stash failed: ${e.message}`);
      }
    },
  );
}

interface Inputs {
  branch?: string;
  dirtyPaths: string[];
  activeFile?: string;
  repoName?: string;
}

async function collectInputs(git: Git): Promise<Inputs> {
  const [branch, porcelain] = await Promise.all([
    safe(git, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim()),
    safe(git, ['status', '--porcelain=v1']),
  ]);
  const paths = dirtyPaths(porcelain);
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  let activeFile: string | undefined;
  if (activeUri && activeUri.scheme === 'file') {
    activeFile = path.relative(git.cwd, activeUri.fsPath);
    if (activeFile.startsWith('..')) activeFile = undefined;
  }
  return {
    branch: branch === 'HEAD' ? undefined : branch || undefined,
    dirtyPaths: paths,
    activeFile,
    repoName: path.basename(git.cwd),
  };
}

async function promptForName(preset: string, inputs: Inputs): Promise<string | undefined> {
  const SHOW_ALL = '$(list-selection) Show all suggestions…';
  const input = vscode.window.createInputBox();
  input.title = 'GitSight: Smart Stash';
  input.placeholder = 'Name (leave blank for a bare WIP stash)';
  input.value = preset;
  input.prompt = `${inputs.dirtyPaths.length} dirty file${inputs.dirtyPaths.length === 1 ? '' : 's'}; pick a name or accept the default.`;
  input.buttons = [
    { iconPath: new vscode.ThemeIcon('list-selection'), tooltip: 'Show all suggestions' },
  ];
  void SHOW_ALL;
  return new Promise<string | undefined>(resolve => {
    let resolved = false;
    const finish = (v: string | undefined) => {
      if (resolved) return;
      resolved = true;
      input.hide();
      resolve(v);
    };
    input.onDidAccept(() => finish(input.value));
    input.onDidHide(() => finish(undefined));
    input.onDidTriggerButton(async () => {
      const picked = await pickName(inputs);
      if (picked != null) {
        input.value = picked;
      }
    });
    input.show();
  });
}

async function pickName(inputs: Inputs): Promise<string | undefined> {
  const suggestions = suggestStashNames(inputs);
  if (!suggestions.length) {
    vscode.window.showInformationMessage('GitSight: no suggestions — type one yourself.');
    return undefined;
  }
  type Item = vscode.QuickPickItem & { _name: string };
  const items: Item[] = suggestions.map((s: NameSuggestion, i) => ({
    label: `$(bookmark) ${s.name}`,
    description: s.source,
    detail: i === 0 ? 'Top pick — derived from your current context.' : undefined,
    _name: s.name,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a stash name',
    matchOnDescription: true,
  });
  return picked?._name;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
