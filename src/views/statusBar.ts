import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';

export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'gitsight.showCommitGraph';
    this.disposables.push(
      this.item,
      repos.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('gitsight.statusBar')) this.refresh(); }),
    );
    this.refresh();
  }

  private async refresh() {
    const cfg = vscode.workspace.getConfiguration('gitsight.statusBar');
    if (!cfg.get<boolean>('enabled')) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    try {
      const branch = await git.currentBranch();
      const branches = await git.branches(false);
      const cur = branches.find(b => b.current);
      let txt = `$(git-branch) ${branch}`;
      if (cur?.ahead) txt += ` ↑${cur.ahead}`;
      if (cur?.behind) txt += ` ↓${cur.behind}`;
      this.item.text = txt;
      this.item.tooltip = `GitSight: click to open Commit Graph`;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }
}
