/**
 * F66 — "Open at last touched commit" CodeAction + command.
 *
 * For any file inside a git repo, mine the recent commit window for the
 * last commit that touched this file's path. Surface the result as:
 *
 *   1. A Refactor-kind CodeAction in the lightbulb (so the user sees
 *      "GitSight: Open at last touched (abc1234 - 3d ago)" without
 *      polluting the quick-fix slot).
 *   2. A command (`gitsight.openAtLastTouchedCommit`) for keybinding /
 *      command palette / context-menu use.
 *
 * The command shows a tiny QuickPick with three actions:
 *
 *   - Open the file at that historic SHA (uses the existing virtualFs).
 *   - Diff that historic version against the current working tree.
 *   - Show the full commit (delegates to gitsight.showCommitDetail).
 *
 * Provider is cheap — it never shells out. It just decides whether to
 * offer the action based on the file being inside a git repo and not
 * being a binary asset. The actual mining happens on command invocation.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { openHistoricFile, diffRevisions } from '../git/virtualFs';
import { timeAgo } from '../git/format';
import {
  findLastTouchedCommit,
  describeLastTouch,
  isOpenableTextPath,
  LastTouchInfo,
} from '../git/openAtLastTouched';

const COMMAND_ID = 'gitsight.openAtLastTouchedCommit';

export function registerOpenAtLastTouched(
  ctx: vscode.ExtensionContext,
  repos: RepoManager,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(COMMAND_ID, async (arg?: any) => {
      try {
        await execute(repos, normaliseArg(arg));
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`);
      }
    }),
  );

  disposables.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new OpenAtLastTouchedActionProvider(repos),
      { providedCodeActionKinds: [vscode.CodeActionKind.Refactor] },
    ),
  );

  ctx.subscriptions.push(...disposables);
  return disposables;
}

class OpenAtLastTouchedActionProvider implements vscode.CodeActionProvider {
  constructor(private repos: RepoManager) {}

  provideCodeActions(document: vscode.TextDocument): vscode.CodeAction[] | undefined {
    if (document.uri.scheme !== 'file') return undefined;
    const git = this.repos.forFile(document.uri.fsPath);
    if (!git) return undefined;
    const rel = path.relative(git.cwd, document.uri.fsPath);
    if (!isOpenableTextPath(rel)) return undefined;
    const action = new vscode.CodeAction(
      'GitSight: Open at last touched commit',
      vscode.CodeActionKind.Refactor,
    );
    action.command = {
      command: COMMAND_ID,
      title: 'Open at last touched commit',
      arguments: [{ file: document.uri.fsPath }],
    };
    return [action];
  }
}

async function execute(repos: RepoManager, arg?: { file?: string }): Promise<void> {
  const file = arg?.file ?? vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!file) {
    vscode.window.showWarningMessage('GitSight: open a file first.');
    return;
  }
  const git = repos.forFile(file);
  if (!git) {
    vscode.window.showWarningMessage('GitSight: file is not inside a Git repo.');
    return;
  }
  const rel = path.relative(git.cwd, file);
  if (!isOpenableTextPath(rel)) {
    vscode.window.showInformationMessage('GitSight: this file type does not support historic open.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.openAtLastTouched');
  const windowSize = Math.max(50, Math.min(2000, cfg.get<number>('scanCommits', 500)));

  const info = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `GitSight: mining log for ${path.basename(rel)}\u2026`,
    },
    async () => {
      try {
        const out = await git.raw([
          'log',
          `-n${windowSize}`,
          '--name-status',
          '--pretty=format:|||%H|%h|%an|%aI|%s',
          '--',
          rel,
        ]);
        return findLastTouchedCommit(out, rel);
      } catch {
        return undefined;
      }
    },
  );

  if (!info) {
    vscode.window.showInformationMessage(
      `GitSight: no commit in the last ${windowSize} touched ${rel}.`,
    );
    return;
  }

  await showActionPicker(git, rel, info);
}

async function showActionPicker(git: Git, rel: string, info: LastTouchInfo): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action: 'open' | 'diff' | 'show'; };
  const headline = describeLastTouch(info, timeAgo(info.date));
  const renamedNote = info.renamedFrom && info.renamedFrom !== info.pathInCommit
    ? `  \u00b7  renamed from ${info.renamedFrom}`
    : '';
  const items: Pk[] = [
    { label: headline, kind: vscode.QuickPickItemKind.Separator } as any,
    {
      label: '$(history) Open the file at that commit',
      description: `${info.shortSha}${renamedNote}`,
      detail: 'Read-only view via gitsight:// virtual filesystem',
      _action: 'open',
    },
    {
      label: '$(diff) Diff that version against the working tree',
      description: `${info.shortSha} \u2194 working`,
      detail: 'Side-by-side editor diff',
      _action: 'diff',
    },
    {
      label: '$(git-commit) Show the commit detail',
      description: info.shortSha,
      detail: info.subject,
      _action: 'show',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Last touched ${rel}: ${info.shortSha} \u2014 ${timeAgo(info.date)}`,
    matchOnDescription: true,
  });
  if (!picked || !picked._action) return;

  const pathInCommit = info.pathInCommit;
  if (picked._action === 'open') {
    await openHistoricFile(git.cwd, info.sha, pathInCommit);
    return;
  }
  if (picked._action === 'diff') {
    // For renames, diff the historic *old* path against the current new path
    // manually — the standard diffRevisions helper aligns both sides on the
    // same path, which would show the rename as a deletion + addition.
    if (info.renamedFrom && info.renamedFrom !== rel) {
      const left = vscode.Uri.parse(`gitsight://${encodeURIComponent(git.cwd)}/${info.sha}/${pathInCommit}`);
      const right = vscode.Uri.file(path.join(git.cwd, rel));
      const baseName = path.basename(rel);
      await vscode.commands.executeCommand(
        'vscode.diff', left, right,
        `${baseName} (${info.shortSha} \u2194 Working, renamed)`,
      );
      return;
    }
    await diffRevisions(git.cwd, pathInCommit, info.sha, 'WORKING');
    return;
  }
  if (picked._action === 'show') {
    await vscode.commands.executeCommand('gitsight.showCommitDetail', git, info.sha);
    return;
  }
}

/**
 * The command is invoked from three places with three different arg shapes:
 *
 *   1. CodeAction provider → `{ file: '/abs/path' }`.
 *   2. Recent Files view's tree-item context menu → a `FileNode` shape
 *      with `{ kind: 'file', entry: { path: 'rel/path' }, git: Git }`.
 *   3. Command palette / keybinding → `undefined` (falls back to the
 *      active editor's document).
 *
 * Normalise to `{ file: '/abs/path' }` so the rest of execute() doesn't
 * have to know about the variants.
 */
function normaliseArg(arg: any): { file?: string } | undefined {
  if (!arg) return undefined;
  if (typeof arg === 'string') return { file: arg };
  if (typeof arg.file === 'string') return { file: arg.file };
  // Tree-item shapes from the Recent Files view.
  const entry = arg.entry;
  const git = arg.git;
  if (entry && typeof entry.path === 'string' && git && typeof git.cwd === 'string') {
    return { file: path.join(git.cwd, entry.path) };
  }
  // VS Code Uri shape (from context menu groups that pass the resource).
  if (typeof arg.fsPath === 'string') return { file: arg.fsPath };
  if (arg.resourceUri && typeof arg.resourceUri.fsPath === 'string') {
    return { file: arg.resourceUri.fsPath };
  }
  return undefined;
}
