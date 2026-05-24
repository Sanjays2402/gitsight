import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';

export async function showWorktreeSwitcher(git: Git) {
  const trees = await git.worktrees();
  if (!trees.length) return vscode.window.showInformationMessage('No worktrees. Create one with "GitSight: Create Worktree".');
  const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  type Item = vscode.QuickPickItem & { _path?: string; _action?: 'new' | 'remove'; _wt?: typeof trees[number] };
  const items: Item[] = trees.map(w => ({
    label: `$(versions) ${path.basename(w.path)}`,
    description: w.branch ? `[${w.branch}]` : w.detached ? '(detached)' : '(bare)',
    detail: `${w.path}${here === w.path ? '  ← current' : ''}${w.locked ? '  🔒 locked' : ''}`,
    _path: w.path,
    _wt: w,
  }));
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(add) Create new worktree…', _action: 'new' },
    { label: '$(trash) Remove a worktree…', _action: 'remove' },
  );
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Switch worktree (open in new window) · Cmd+Shift+W',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'new') return vscode.commands.executeCommand('gitsight.createWorktree');
  if (picked._action === 'remove') return removeFlow(git, trees);
  if (picked._path) {
    if (picked._path === here) return vscode.window.showInformationMessage('Already in this worktree.');
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked._path), { forceNewWindow: true });
  }
}

async function removeFlow(git: Git, trees: Awaited<ReturnType<Git['worktrees']>>) {
  const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const removable = trees.filter(t => t.path !== here && !t.bare);
  if (!removable.length) return vscode.window.showInformationMessage('No removable worktrees.');
  const picked = await vscode.window.showQuickPick(
    removable.map(w => ({
      label: path.basename(w.path),
      description: w.branch,
      detail: w.path,
      _path: w.path,
    })),
    { placeHolder: 'Pick worktree to remove' },
  );
  if (!picked) return;
  const confirm = await vscode.window.showWarningMessage(`Remove worktree at ${picked._path}?`, { modal: true }, 'Remove');
  if (confirm !== 'Remove') return;
  await git.removeWorktree(picked._path!);
  vscode.window.showInformationMessage(`Removed worktree: ${picked.label}`);
  vscode.commands.executeCommand('gitsight.refresh');
}
