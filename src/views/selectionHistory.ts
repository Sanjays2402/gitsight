/**
 * Selection History (F23) — "Reveal in History" CodeAction + command.
 *
 * Right-click a selection (or just put the caret on a line) → "GitSight:
 * Show History for Selection" runs `git log -L<start>,<end>:<file>
 * --no-patch` and opens a markdown report with one line per commit that
 * touched the range. Far more useful than the existing file-wide history
 * for hotspots — you see exactly which commits shaped the code you're
 * looking at, not the whole file's churn.
 *
 * The CodeAction provider lights up on every file in a git repo
 * (registered as a Refactor action so it shows in the lightbulb without
 * polluting the quick-fix slot). The underlying command is also exposed
 * for keybinding / command palette use.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  normaliseSelection,
  parseHistoryLog,
  formatHistoryMarkdown,
  formatLArg,
  LineRange,
} from '../git/selectionHistory';

const COMMAND_ID = 'gitsight.showSelectionHistory';

export function registerSelectionHistory(
  ctx: vscode.ExtensionContext,
  repos: RepoManager,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(COMMAND_ID, async (arg?: { file?: string; range?: LineRange }) => {
      try {
        await execute(repos, arg);
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`);
      }
    }),
  );

  // Refactor-kind CodeAction: shows up in the lightbulb on any selection
  // inside a file that's tracked by git. The provider is cheap (it never
  // shells out — only decides whether the action is offered) so it can
  // light up on every selection without measurable cost.
  disposables.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new SelectionHistoryActionProvider(repos),
      { providedCodeActionKinds: [vscode.CodeActionKind.Refactor] },
    ),
  );

  return disposables;
}

class SelectionHistoryActionProvider implements vscode.CodeActionProvider {
  constructor(private repos: RepoManager) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] | undefined {
    if (document.uri.scheme !== 'file') return undefined;
    const git = this.repos.forFile(document.uri.fsPath);
    if (!git) return undefined;
    // Don't show the action on huge files — `git log -L` is O(history * file)
    // and gets painfully slow above ~50k lines. Match the project's existing
    // "skip massive files" patterns (workingTree etc.).
    if (document.lineCount > 50_000) return undefined;

    const r = normaliseSelection(range.start.line, range.end.line, document.lineCount);
    const label = r.start === r.end
      ? `GitSight: Show history for L${r.start}`
      : `GitSight: Show history for L${r.start}-L${r.end}`;

    const action = new vscode.CodeAction(label, vscode.CodeActionKind.Refactor);
    action.command = {
      command: COMMAND_ID,
      title: label,
      arguments: [{ file: document.uri.fsPath, range: r }],
    };
    return [action];
  }
}

async function execute(repos: RepoManager, arg?: { file?: string; range?: LineRange }) {
  const editor = vscode.window.activeTextEditor;
  const file = arg?.file ?? editor?.document.uri.fsPath;
  if (!file) {
    vscode.window.showWarningMessage('GitSight: open a file first.');
    return;
  }
  const git = repos.forFile(file);
  if (!git) {
    vscode.window.showWarningMessage('GitSight: file is not inside a Git repo.');
    return;
  }
  let range = arg?.range;
  if (!range) {
    if (!editor || editor.document.uri.fsPath !== file) {
      vscode.window.showWarningMessage('GitSight: no selection — open the file and select a range first.');
      return;
    }
    range = normaliseSelection(editor.selection.start.line, editor.selection.end.line, editor.document.lineCount);
  }

  const relPath = path.relative(git.cwd, file);
  const args = [
    'log',
    formatLArg(range, relPath),
    '--no-patch',
    '--pretty=format:%H|%h|%an|%aI|%s',
    '--max-count=200',
  ];

  const raw = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: `GitSight: log -L for ${path.basename(file)}`,
  }, () => git.raw(args).catch(() => ''));

  const commits = parseHistoryLog(raw);
  const md = formatHistoryMarkdown(relPath, range, commits);
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}
