/**
 * Restore-from-commit — quick-pick of every commit that touched the active
 * file, with three actions per pick:
 *
 *   - Restore (overwrites current working copy with the version at that sha)
 *   - Diff (opens vscode's diff view between working and that sha)
 *   - View (opens the file content as it was at that sha)
 *
 * For "Restore", we always show a confirmation modal with the option to first
 * stash uncommitted changes so the user can recover if they change their mind.
 *
 * The actual git plumbing is `git show <sha>:<rel>` (for content) and
 * `git checkout <sha> -- <rel>` (for the destructive restore). Both go through
 * the existing Git wrapper.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import { diffRevisions } from '../git/virtualFs';
import { buildRestorePickItems, RestorePickItem } from '../git/restorePick';

export async function showRestoreFromCommit(git: Git): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('GitSight: open a file first.');
    return;
  }
  const abs = editor.document.uri.fsPath;
  const rel = path.relative(git.cwd, abs);
  if (!rel || rel.startsWith('..')) {
    vscode.window.showWarningMessage('GitSight: file is outside the active git repo.');
    return;
  }

  const commits = await git.log({ file: abs, max: 200 }).catch(() => []);
  if (!commits.length) {
    vscode.window.showInformationMessage(`GitSight: no history for ${path.basename(rel)}.`);
    return;
  }

  type Item = vscode.QuickPickItem & RestorePickItem;
  const items: Item[] = buildRestorePickItems(commits, timeAgo).map(i => ({
    ...i,
    alwaysShow: false,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${commits.length} commits touch ${path.basename(rel)} — pick one`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(diff) Diff against working copy', _id: 'diff' },
      { label: '$(eye) View file at this commit', _id: 'view' },
      { label: '$(discard) Restore working copy to this version', _id: 'restore' },
    ],
    {
      placeHolder: `${picked.shortSha}  ${picked.subject.slice(0, 80)}`,
    },
  );
  if (!action) return;

  if (action._id === 'view') {
    return openAtCommit(git, picked.sha, abs, rel);
  }
  if (action._id === 'diff') {
    return diffAgainstWorking(git, rel, picked.sha, picked.shortSha);
  }
  return restoreWorking(git, abs, rel, picked.sha, picked.shortSha, picked.subject);
}

async function openAtCommit(git: Git, sha: string, abs: string, rel: string): Promise<void> {
  try {
    const content = await git.showFile(sha, abs);
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: vscode.window.activeTextEditor?.document.languageId,
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
    vscode.window.setStatusBarMessage(`Showing ${path.basename(rel)} at ${sha.slice(0, 7)}`, 3000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function diffAgainstWorking(git: Git, rel: string, sha: string, short: string): Promise<void> {
  await diffRevisions(git.cwd, rel, sha, 'WORKING');
  void short;
}

async function restoreWorking(
  git: Git,
  abs: string,
  rel: string,
  sha: string,
  short: string,
  subject: string,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Overwrite ${path.basename(rel)} with the version at ${short} ("${subject.slice(0, 60)}")?`,
    { modal: true, detail: 'This rewrites your working copy. Pick "Stash & restore" to save current changes first.' },
    'Stash & restore',
    'Restore (discard current)',
  );
  if (!choice) return;

  if (choice === 'Stash & restore') {
    try {
      await git.stashSave(`gitsight: restore ${path.basename(rel)} to ${short}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: stash failed: ${e.message}`);
      return;
    }
  }

  try {
    await git.raw(['checkout', sha, '--', rel]);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: restore failed: ${e.message}`);
    return;
  }

  // VS Code may keep the old buffer in memory — nudge it to reload from disk.
  const exists = await fs.promises.stat(abs).then(() => true, () => false);
  if (exists) {
    try {
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc);
    } catch {
      /* fall through */
    }
  }

  vscode.window.showInformationMessage(
    `GitSight: restored ${path.basename(rel)} to ${short}.`,
  );
  vscode.commands.executeCommand('gitsight.refresh');
}
