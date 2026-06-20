/**
 * Working-Tree status pill — surfaces staged / modified / untracked / conflict
 * counts in the status bar. Click → opens the SCM view. Updates on RepoManager
 * change events plus a 15s poll fallback (cheap: one `git status --porcelain`).
 *
 * Configurable via `gitsight.workingTree.enabled` (default true).
 * Hidden when there's nothing to show and `gitsight.workingTree.hideWhenClean`
 * is true (default true) so it doesn't clutter the bar on a clean tree.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parsePorcelain, shortCounts, describeCounts, WorkTreeCounts } from '../git/workingTreeStatus';

export async function readWorkTree(git: Git): Promise<WorkTreeCounts> {
  const out = await git.raw(['status', '--porcelain']);
  return parsePorcelain(out);
}

export class WorkingTreePill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 94);
    this.item.command = 'workbench.view.scm';
    this.disposables.push(
      this.item,
      repos.onDidChange(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.workingTree')) this.refresh();
      }),
    );
    this.timer = setInterval(() => this.refresh(), 15_000);
    this.refresh();
  }

  async refresh() {
    const cfg = vscode.workspace.getConfiguration('gitsight.workingTree');
    if (!cfg.get<boolean>('enabled', true)) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    try {
      const c = await readWorkTree(git);
      const total = c.staged + c.modified + c.untracked + c.conflicted;
      if (total === 0 && cfg.get<boolean>('hideWhenClean', true)) { this.item.hide(); return; }
      const icon = c.conflicted ? '$(warning)' : total === 0 ? '$(check)' : '$(edit)';
      this.item.text = total === 0 ? `${icon} clean` : `${icon} ${shortCounts(c)}`;
      const summary = describeCounts(c) || 'Working tree is clean';
      this.item.tooltip = new vscode.MarkdownString(
        `**GitSight: Working tree**  \n${summary}\n\nClick to open Source Control.`,
      );
      this.item.backgroundColor = c.conflicted
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
