import * as vscode from 'vscode';
import { Git } from '../git/git';

class Watcher implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  constructor(private repoRoot: string, private onChange: () => void) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoRoot, '.git/{HEAD,ORIG_HEAD,FETCH_HEAD,refs/**,packed-refs,index,MERGE_HEAD,REBASE_HEAD}'),
    );
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
  }
  dispose() { this.watcher?.dispose(); }
}

export class RepoManager implements vscode.Disposable {
  private repos = new Map<string, Git>();
  private watchers = new Map<string, Watcher>();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.refresh();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  async refresh() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seen = new Set<string>();
    for (const f of folders) {
      const git = new Git(f.uri.fsPath);
      if (await git.isRepo()) {
        const root = await git.topLevel();
        seen.add(root);
        if (!this.repos.has(root)) {
          this.repos.set(root, new Git(root));
          this.watchers.set(root, new Watcher(root, () => this._onDidChange.fire()));
        }
      }
    }
    // Clean up removed
    for (const [root, w] of this.watchers) {
      if (!seen.has(root)) { w.dispose(); this.watchers.delete(root); this.repos.delete(root); }
    }
    this._onDidChange.fire();
  }

  all(): Git[] { return [...this.repos.values()]; }
  primary(): Git | undefined { return this.repos.values().next().value; }

  forFile(file: string): Git | undefined {
    let best: Git | undefined;
    let bestLen = -1;
    for (const [root, git] of this.repos) {
      if (file.startsWith(root + '/') || file === root) {
        if (root.length > bestLen) { best = git; bestLen = root.length; }
      }
    }
    return best;
  }

  dispose() {
    this.watchers.forEach(w => w.dispose());
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
