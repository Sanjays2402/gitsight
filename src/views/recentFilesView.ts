/**
 * Recent Files Touched view — sidebar TreeView listing every file modified in
 * the most recent N commits (configurable), sorted by recency, with the last
 * commit shown as a description. Click a file → opens it in the editor.
 *
 * Powered by `git log --name-status -n N`, which is one shot per refresh.
 * The pure scan helper lives in src/git/recentFiles.ts so it can be tested
 * without touching git.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { timeAgo } from '../git/format';
import { scanRecentFiles, RecentFile } from '../git/recentFiles';

type Node = RepoNode | FileNode;
interface RepoNode { kind: 'repo'; git: Git; }
interface FileNode { kind: 'file'; entry: RecentFile; git: Git; }

export class RecentFilesView implements vscode.TreeDataProvider<Node> {
  private _e = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._e.event;

  constructor(private repos: RepoManager) {
    repos.onDidChange(() => this._e.fire());
  }

  refresh() { this._e.fire(); }

  async getTreeItem(n: Node): Promise<vscode.TreeItem> {
    if (n.kind === 'repo') {
      const item = new vscode.TreeItem(path.basename(n.git.cwd), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = await n.git.currentBranch().catch(() => '?');
      return item;
    }
    const f = n.entry;
    const item = new vscode.TreeItem(path.basename(f.path));
    item.description = `${path.dirname(f.path)}  ·  ${f.shortSha} ${timeAgo(f.date)}`;
    item.tooltip = new vscode.MarkdownString(
      `**${f.path}**  \nLast touched in \`${f.shortSha}\` — ${f.subject}  \n_${f.author} · ${timeAgo(f.date)}_  \nStatus: \`${f.status}\` · seen in ${f.commitCount} of last ${f.windowSize} commits`,
    );
    item.iconPath = new vscode.ThemeIcon(statusIcon(f.status));
    item.contextValue = 'recentFile';
    const abs = path.join(n.git.cwd, f.path);
    item.resourceUri = vscode.Uri.file(abs);
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(abs)],
    };
    return item;
  }

  async getChildren(el?: Node): Promise<Node[]> {
    const repos = this.repos.all();
    if (repos.length === 0) return [];
    if (!el) {
      if (repos.length === 1) {
        return (await this.scan(repos[0])).map(entry => ({ kind: 'file', entry, git: repos[0] } as Node));
      }
      return repos.map(git => ({ kind: 'repo', git } as Node));
    }
    if (el.kind === 'repo') {
      return (await this.scan(el.git)).map(entry => ({ kind: 'file', entry, git: el.git } as Node));
    }
    return [];
  }

  private async scan(git: Git): Promise<RecentFile[]> {
    const cfg = vscode.workspace.getConfiguration('gitsight.recentFiles');
    const n = Math.max(1, Math.min(500, cfg.get<number>('commits', 30)));
    const max = Math.max(5, Math.min(200, cfg.get<number>('max', 50)));
    try {
      const out = await git.raw([
        'log',
        `-n${n}`,
        '--name-status',
        '--pretty=format:|||%H|%h|%an|%aI|%s',
      ]);
      return scanRecentFiles(out, n).slice(0, max);
    } catch {
      return [];
    }
  }
}

function statusIcon(s: string): string {
  switch (s) {
    case 'A': return 'diff-added';
    case 'M': return 'diff-modified';
    case 'D': return 'diff-removed';
    case 'R': return 'diff-renamed';
    case 'C': return 'diff-modified';
    case 'T': return 'diff-modified';
    default: return 'file';
  }
}
