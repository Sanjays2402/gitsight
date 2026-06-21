/**
 * Compare Working Tree to Any Commit (F44).
 *
 * Flow:
 *
 *   1. Quick-pick a commit (recent 200 by default; filterable via search box).
 *   2. Quick-pick a file from the diff between that commit and the working
 *      tree — or "Open full diff" to dump everything to a unified-diff
 *      buffer, or "Open report" for the markdown summary.
 *   3. Per-file pick opens a real VS Code diff editor (left = commit's
 *      version, right = working copy). Deleted / added files open in
 *      single-pane mode with an explanatory placeholder.
 *
 * Plumbing:
 *
 *   - Commits come from `git log` via the existing Git wrapper.
 *   - File list from `git diff --name-status <sha>` (no `..HEAD` — git
 *     defaults to comparing against the working tree when no second ref
 *     is given).
 *   - Diff view uses the existing `diffRevisions` helper from
 *     src/git/virtualFs.ts (`<sha>` on the left, `'WORKING'` sentinel on
 *     the right). Don't roll a new URI scheme — that's the project
 *     pattern.
 *
 * No new keybinding (the existing surface is already key-heavy); exposed
 * as the command `gitsight.compareWorkingTreeToCommit`.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import { diffRevisions, openHistoricFile } from '../git/virtualFs';
import {
  buildCommitPickRows,
  buildFileDiffRows,
  describeStatus,
  formatMarkdownReport,
  parseDiffNameStatus,
  summariseChanges,
  CommitPickRow,
  FileDiffRow,
} from '../git/workingTreeCompare';

const COMMIT_FETCH_MAX = 200;

export async function showWorkingTreeCompare(git: Git): Promise<void> {
  const commits = await git.log({ max: COMMIT_FETCH_MAX }).catch(() => []);
  if (!commits.length) {
    vscode.window.showInformationMessage('GitSight: no commits to compare against.');
    return;
  }
  type CommitItem = vscode.QuickPickItem & CommitPickRow;
  const items: CommitItem[] = buildCommitPickRows(commits, timeAgo).map(r => ({
    ...r,
    alwaysShow: false,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Pick a commit to compare against your working tree (${commits.length} most recent)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  await openCommitCompare(git, picked.sha, picked.shortSha, picked.subject);
}

async function openCommitCompare(git: Git, sha: string, shortSha: string, subject: string): Promise<void> {
  const raw = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: diffing ${shortSha} vs working tree…` },
    () => git.raw(['diff', '--name-status', sha]).catch(() => ''),
  );
  const changes = parseDiffNameStatus(raw);
  const summary = summariseChanges(shortSha, changes);
  if (!changes.length) {
    vscode.window.showInformationMessage(`GitSight: ${summary}`);
    return;
  }

  type FileItem = vscode.QuickPickItem & FileDiffRow & { _kind: 'file' };
  type ActionItem = vscode.QuickPickItem & { _kind: 'action'; _id: 'fullDiff' | 'report' };
  type Separator = vscode.QuickPickItem & { _kind: 'sep' };
  type Item = FileItem | ActionItem | Separator;

  const fileRows = buildFileDiffRows(changes).map<FileItem>(r => ({
    ...r,
    _kind: 'file',
  }));
  const actions: ActionItem[] = [
    {
      label: '$(diff) Open full unified diff',
      detail: `git diff ${shortSha} (all ${changes.length} files in one buffer)`,
      _kind: 'action',
      _id: 'fullDiff',
    },
    {
      label: '$(notebook) Open markdown report',
      detail: 'Per-file status breakdown',
      _kind: 'action',
      _id: 'report',
    },
  ];
  const separator: Separator = {
    label: 'Files',
    kind: vscode.QuickPickItemKind.Separator,
    _kind: 'sep',
  };
  const items: Item[] = [...actions, separator, ...fileRows];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: summary,
    matchOnDescription: true,
  });
  if (!picked || picked._kind === 'sep') return;

  if (picked._kind === 'action') {
    if (picked._id === 'fullDiff') return openFullDiff(git, sha, shortSha);
    if (picked._id === 'report') return openReport(shortSha, subject, changes);
    return;
  }
  return openFileDiff(git, sha, shortSha, picked);
}

async function openFullDiff(git: Git, sha: string, shortSha: string): Promise<void> {
  try {
    const diff = await git.raw(['diff', sha]);
    const body = diff.trim() || `# Working tree matches ${shortSha} — no differences.`;
    const doc = await vscode.workspace.openTextDocument({ content: body, language: 'diff' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function openReport(shortSha: string, subject: string, changes: any[]): Promise<void> {
  const md = formatMarkdownReport(shortSha, subject, changes);
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
}

async function openFileDiff(git: Git, sha: string, shortSha: string, row: FileDiffRow): Promise<void> {
  // For added files the commit has no version — show "added since X" placeholder.
  if (row.added) {
    vscode.window.showInformationMessage(
      `GitSight: ${row.path} is ${describeStatus(row.status)} since ${shortSha} (no prior version to diff against).`,
    );
    // Open the live working copy so the user can act on it.
    const abs = path.join(git.cwd, row.path);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
    return;
  }
  // For deleted files the working tree has no version — open the commit's
  // version read-only via the virtual fs.
  if (row.deleted) {
    try {
      await openHistoricFile(git.cwd, sha, row.path);
      vscode.window.setStatusBarMessage(
        `Showing ${path.basename(row.path)} at ${shortSha} (deleted from working tree)`, 3000,
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: ${e.message}`);
    }
    return;
  }
  await diffRevisions(git.cwd, row.path, sha, 'WORKING');
}
