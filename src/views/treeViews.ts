import * as vscode from 'vscode';
import { Git, Commit, Branch, Tag, Remote, Stash, Worktree, Contributor } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { timeAgo } from '../git/format';
import {
  classifyAge,
  ageDays,
  ageLabel,
  colorIdFor,
  AgeThresholds,
  DEFAULT_THRESHOLDS,
} from '../git/branchAge';
import * as path from 'path';

abstract class BaseTree<T> implements vscode.TreeDataProvider<T> {
  protected _e = new vscode.EventEmitter<T | undefined | void>();
  readonly onDidChangeTreeData = this._e.event;
  constructor(protected repos: RepoManager) {
    repos.onDidChange(() => this._e.fire());
  }
  refresh() { this._e.fire(); }
  abstract getTreeItem(el: T): vscode.TreeItem | Promise<vscode.TreeItem>;
  abstract getChildren(el?: T): Promise<T[]>;
}

interface RepoNode { kind: 'repo'; git: Git; }
interface CommitNode { kind: 'commit'; commit: Commit; git: Git; }
interface FileNode { kind: 'file'; status: string; path: string; sha: string; git: Git; }
type CommitsItem = RepoNode | CommitNode | FileNode;

export class RepositoriesView extends BaseTree<RepoNode> {
  async getTreeItem(n: RepoNode): Promise<vscode.TreeItem> {
    const branch = await n.git.currentBranch().catch(() => '?');
    const item = new vscode.TreeItem(path.basename(n.git.cwd), vscode.TreeItemCollapsibleState.None);
    item.description = branch;
    item.tooltip = n.git.cwd;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.contextValue = 'repository';
    return item;
  }
  async getChildren(): Promise<RepoNode[]> {
    return this.repos.all().map(git => ({ kind: 'repo', git }));
  }
}

export class CommitsView extends BaseTree<CommitsItem> {
  async getTreeItem(n: CommitsItem): Promise<vscode.TreeItem> {
    if (n.kind === 'repo') {
      const item = new vscode.TreeItem(path.basename(n.git.cwd), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = await n.git.currentBranch().catch(() => '?');
      return item;
    }
    if (n.kind === 'commit') {
      const c = n.commit;
      const item = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${c.shortSha} • ${c.author} • ${timeAgo(c.date)}`;
      item.tooltip = new vscode.MarkdownString(
        `**${c.subject}**\n\n${c.body}\n\n_${c.author} <${c.email}>_\n\n\`${c.sha}\``
      );
      item.iconPath = new vscode.ThemeIcon('git-commit');
      item.contextValue = 'commit';
      item.command = { command: 'gitsight.showCommitDetail', title: 'Show', arguments: [n.git, c.sha] };
      return item;
    }
    const item = new vscode.TreeItem(path.basename(n.path));
    item.description = path.dirname(n.path);
    item.iconPath = new vscode.ThemeIcon(statusIcon(n.status));
    item.contextValue = 'commitFile';
    item.command = {
      command: 'gitsight.showFileAtCommit',
      title: 'Show File',
      arguments: [n.git, n.sha, n.path],
    };
    return item;
  }
  async getChildren(el?: CommitsItem): Promise<CommitsItem[]> {
    if (!el) {
      const repos = this.repos.all();
      if (repos.length === 1) {
        const git = repos[0];
        try { return (await git.log({ max: 200, all: true })).map(c => ({ kind: 'commit', commit: c, git })); }
        catch { return []; }
      }
      return repos.map(git => ({ kind: 'repo', git }));
    }
    if (el.kind === 'repo') {
      try { return (await el.git.log({ max: 200, all: true })).map(c => ({ kind: 'commit', commit: c, git: el.git })); }
      catch { return []; }
    }
    if (el.kind === 'commit') {
      try { return (await el.git.commitFiles(el.commit.sha)).map(f => ({ kind: 'file', status: f.status, path: f.path, sha: el.commit.sha, git: el.git })); }
      catch { return []; }
    }
    return [];
  }
}

function statusIcon(s: string): string {
  switch (s) {
    case 'A': return 'diff-added';
    case 'M': return 'diff-modified';
    case 'D': return 'diff-removed';
    case 'R': return 'diff-renamed';
    case 'C': return 'diff-modified';
    default: return 'file';
  }
}

interface BranchGroup { kind: 'group'; label: string; branches: Branch[]; git: Git; }
interface BranchNode { kind: 'branch'; branch: Branch; git: Git; }
type BranchesItem = BranchGroup | BranchNode;

export class BranchesView extends BaseTree<BranchesItem> {
  async getTreeItem(n: BranchesItem): Promise<vscode.TreeItem> {
    if (n.kind === 'group') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${n.branches.length}`;
      item.iconPath = new vscode.ThemeIcon(n.label === 'Local' ? 'git-branch' : 'cloud');
      return item;
    }
    const b = n.branch;
    const item = new vscode.TreeItem(b.name);
    const thresholds = readAgeThresholds();
    const now = new Date();
    const status = classifyAge(b.lastDate, now, thresholds);
    const colorId = colorIdFor(status);
    const icon = b.current ? 'star-full' : 'git-branch';
    item.iconPath = colorId
      ? new vscode.ThemeIcon(icon, new vscode.ThemeColor(colorId))
      : new vscode.ThemeIcon(icon);
    const bits: string[] = [];
    if (b.upstream) bits.push(b.upstream);
    if (b.ahead) bits.push(`↑${b.ahead}`);
    if (b.behind) bits.push(`↓${b.behind}`);
    const label = ageLabel({ branch: b, status, ageDays: ageDays(b.lastDate, now) });
    if (label) bits.push(label);
    item.description = bits.join(' · ');
    if (status !== 'fresh') {
      const tip = new vscode.MarkdownString(undefined, true);
      tip.appendMarkdown(`**${b.name}**  \n`);
      tip.appendMarkdown(`Last commit: ${b.lastDate ? b.lastDate.toISOString().slice(0, 10) : 'unknown'}  \n`);
      tip.appendMarkdown(`Status: \`${status}\` (${ageDays(b.lastDate, now)} days)`);
      item.tooltip = tip;
    }
    item.contextValue = 'branch';
    item.command = { command: 'gitsight.checkoutBranch', title: 'Checkout', arguments: [n.git, b.name] };
    return item;
  }
  async getChildren(el?: BranchesItem): Promise<BranchesItem[]> {
    const repos = this.repos.all();
    if (repos.length === 0) return [];
    const git = repos[0];
    if (!el) {
      try {
        const all = await git.branches(true);
        return [
          { kind: 'group', label: 'Local', branches: all.filter(b => !b.remote), git },
          { kind: 'group', label: 'Remote', branches: all.filter(b => b.remote), git },
        ];
      } catch { return []; }
    }
    if (el.kind === 'group') return el.branches.map(b => ({ kind: 'branch', branch: b, git: el.git }));
    return [];
  }
}

function readAgeThresholds(): AgeThresholds {
  const cfg = vscode.workspace.getConfiguration('gitsight.branchAge');
  return {
    agingDays: cfg.get<number>('agingDays', DEFAULT_THRESHOLDS.agingDays),
    staleDays: cfg.get<number>('staleDays', DEFAULT_THRESHOLDS.staleDays),
    ancientDays: cfg.get<number>('ancientDays', DEFAULT_THRESHOLDS.ancientDays),
  };
}

export class TagsView extends BaseTree<{ tag: Tag; git: Git }> {
  async getTreeItem(n: { tag: Tag; git: Git }): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(n.tag.name);
    item.iconPath = new vscode.ThemeIcon('tag');
    item.description = `${n.tag.sha.slice(0, 7)}${n.tag.date ? ' • ' + timeAgo(n.tag.date) : ''}`;
    item.tooltip = n.tag.subject;
    item.contextValue = 'tag';
    return item;
  }
  async getChildren(): Promise<{ tag: Tag; git: Git }[]> {
    const git = this.repos.primary(); if (!git) return [];
    try { return (await git.tags()).map(tag => ({ tag, git })); } catch { return []; }
  }
}

export class RemotesView extends BaseTree<{ remote: Remote; git: Git }> {
  async getTreeItem(n: { remote: Remote; git: Git }): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(n.remote.name);
    item.iconPath = new vscode.ThemeIcon('cloud');
    item.description = n.remote.fetchUrl;
    item.tooltip = `fetch: ${n.remote.fetchUrl}\npush:  ${n.remote.pushUrl}`;
    item.contextValue = 'remote';
    return item;
  }
  async getChildren(): Promise<{ remote: Remote; git: Git }[]> {
    const git = this.repos.primary(); if (!git) return [];
    try { return (await git.remotes()).map(remote => ({ remote, git })); } catch { return []; }
  }
}

export class StashesView extends BaseTree<{ stash: Stash; git: Git }> {
  async getTreeItem(n: { stash: Stash; git: Git }): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(n.stash.subject);
    item.iconPath = new vscode.ThemeIcon('archive');
    item.description = `${n.stash.branch} • ${timeAgo(n.stash.date)}`;
    item.contextValue = 'stash';
    return item;
  }
  async getChildren(): Promise<{ stash: Stash; git: Git }[]> {
    const git = this.repos.primary(); if (!git) return [];
    try { return (await git.stashes()).map(stash => ({ stash, git })); } catch { return []; }
  }
}

export class WorktreesView extends BaseTree<{ worktree: Worktree; git: Git }> {
  async getTreeItem(n: { worktree: Worktree; git: Git }): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(n.worktree.branch || n.worktree.head.slice(0, 7));
    item.description = n.worktree.path;
    item.iconPath = new vscode.ThemeIcon(n.worktree.locked ? 'lock' : 'versions');
    item.contextValue = 'worktree';
    item.command = { command: 'gitsight.switchToWorktree', title: 'Open', arguments: [n.worktree.path] };
    return item;
  }
  async getChildren(): Promise<{ worktree: Worktree; git: Git }[]> {
    const git = this.repos.primary(); if (!git) return [];
    try { return (await git.worktrees()).map(worktree => ({ worktree, git })); } catch { return []; }
  }
}

export class ContributorsView extends BaseTree<Contributor> {
  async getTreeItem(c: Contributor): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(c.name);
    item.description = `${c.commits} commits`;
    item.tooltip = c.email;
    item.iconPath = new vscode.ThemeIcon('person');
    return item;
  }
  async getChildren(): Promise<Contributor[]> {
    const git = this.repos.primary(); if (!git) return [];
    try { return await git.contributors(100); } catch { return []; }
  }
}

interface FHRepo { kind: 'repo'; git: Git; file: string; }
interface FHCommit { kind: 'commit'; commit: Commit; git: Git; file: string; }
type FHItem = FHRepo | FHCommit;

export class FileHistoryView extends BaseTree<FHItem> {
  private file?: string;
  constructor(repos: RepoManager) {
    super(repos);
    vscode.window.onDidChangeActiveTextEditor(e => { this.file = e?.document.uri.fsPath; this._e.fire(); });
    this.file = vscode.window.activeTextEditor?.document.uri.fsPath;
  }
  async getTreeItem(n: FHItem): Promise<vscode.TreeItem> {
    if (n.kind === 'repo') {
      const item = new vscode.TreeItem(path.basename(n.file), vscode.TreeItemCollapsibleState.Expanded);
      item.description = path.relative(n.git.cwd, n.file);
      item.iconPath = new vscode.ThemeIcon('file');
      return item;
    }
    const item = new vscode.TreeItem(n.commit.subject);
    item.description = `${n.commit.shortSha} • ${n.commit.author} • ${timeAgo(n.commit.date)}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'commit';
    item.command = { command: 'gitsight.showCommitDetail', title: 'Show', arguments: [n.git, n.commit.sha] };
    return item;
  }
  async getChildren(el?: FHItem): Promise<FHItem[]> {
    if (!this.file) return [];
    const git = this.repos.forFile(this.file);
    if (!git) return [];
    if (!el) return [{ kind: 'repo', git, file: this.file }];
    if (el.kind === 'repo') {
      try { return (await git.log({ file: this.file, max: 200 })).map(c => ({ kind: 'commit', commit: c, git, file: this.file! })); }
      catch { return []; }
    }
    return [];
  }
}

export class LineHistoryView extends BaseTree<Commit> {
  private file?: string;
  private line?: number;
  constructor(repos: RepoManager) {
    super(repos);
    vscode.window.onDidChangeTextEditorSelection(e => {
      this.file = e.textEditor.document.uri.fsPath;
      this.line = e.textEditor.selection.active.line + 1;
      this._e.fire();
    });
  }
  async getTreeItem(c: Commit): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(c.subject);
    item.description = `${c.shortSha} • ${c.author} • ${timeAgo(c.date)}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'commit';
    return item;
  }
  async getChildren(): Promise<Commit[]> {
    if (!this.file || !this.line) return [];
    const git = this.repos.forFile(this.file);
    if (!git) return [];
    try { return await git.log({ file: this.file, line: { start: this.line, end: this.line }, max: 100 }); }
    catch { return []; }
  }
}

interface SearchRoot { kind: 'root'; }
interface SearchResultNode { kind: 'result'; commit: Commit; git: Git; }
type SearchItem = SearchRoot | SearchResultNode;

export class SearchView extends BaseTree<SearchItem> {
  private results: { commit: Commit; git: Git }[] = [];
  private query = '';

  async setQuery(q: string) {
    this.query = q;
    this.results = [];
    const git = this.repos.primary();
    if (git && q) {
      try {
        const found = await git.log({ grep: q, all: true, max: 200 });
        this.results = found.map(commit => ({ commit, git }));
      } catch {}
    }
    this._e.fire();
  }

  async getTreeItem(n: SearchItem): Promise<vscode.TreeItem> {
    if (n.kind === 'root') {
      const item = new vscode.TreeItem(this.query ? `"${this.query}"` : '(no query)', vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${this.results.length} results`;
      item.iconPath = new vscode.ThemeIcon('search');
      return item;
    }
    const c = n.commit;
    const item = new vscode.TreeItem(c.subject);
    item.description = `${c.shortSha} • ${c.author} • ${timeAgo(c.date)}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'commit';
    item.command = { command: 'gitsight.showCommitDetail', title: 'Show', arguments: [n.git, c.sha] };
    return item;
  }
  async getChildren(el?: SearchItem): Promise<SearchItem[]> {
    if (!el) return [{ kind: 'root' }];
    if (el.kind === 'root') return this.results.map(r => ({ kind: 'result', ...r }));
    return [];
  }
}
