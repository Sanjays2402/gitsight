/**
 * Worktree-Aware Status-Bar Pill — shows the current worktree alias, click to switch.
 *
 * Pill format: `$(versions) <basename>  [branch]`  e.g. `versions feat-auth  [feat-auth-api]`
 * Click → opens the worktree quick-pick (gitsight.worktreeSwitcher).
 * Hidden when there's only one worktree (no point taking space).
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';

export class WorktreePill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private getGit: () => Git | undefined) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.item.command = 'gitsight.worktreeSwitcher';
    this.item.tooltip = 'GitSight: Switch worktree';

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.worktreePill.enabled')) this.refresh();
      }),
    );
    // Periodic refresh (cheap — one `git worktree list` call)
    this.timer = setInterval(() => this.refresh(), 30_000);
    this.refresh();
  }

  async refresh() {
    const cfg = vscode.workspace.getConfiguration('gitsight');
    if (!cfg.get<boolean>('worktreePill.enabled', true)) {
      this.item.hide();
      return;
    }
    const git = this.getGit();
    if (!git) { this.item.hide(); return; }
    try {
      const trees = await git.worktrees();
      if (trees.length < 2) { this.item.hide(); return; }
      const here = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const current = trees.find(w => w.path === here);
      const name = current ? path.basename(current.path) : path.basename(here || git.cwd);
      const branch = current?.branch || (current?.detached ? '(detached)' : '');
      this.item.text = `$(versions) ${name}${branch ? `  ${branch}` : ''}`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Current worktree:** \`${name}\`  \n` +
        (current?.branch ? `**Branch:** \`${current.branch}\`  \n` : '') +
        `**Path:** \`${current?.path || '?'}\`\n\n` +
        `**${trees.length}** worktrees total. Click to switch.`,
      );
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
    this.item.dispose();
  }
}
