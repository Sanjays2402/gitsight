import * as vscode from 'vscode';
import * as path from 'path';
import { Git, remoteWebUrl } from './git/git';
import { RepoManager } from './git/repoManager';
import { BlameController } from './blame/blameController';
import {
  RepositoriesView, CommitsView, BranchesView, TagsView, RemotesView,
  StashesView, WorktreesView, ContributorsView, FileHistoryView, LineHistoryView, SearchView,
} from './views/treeViews';
import { CommitGraphPanel } from './webviews/commitGraph';
import { showBlameHeatmap } from './webviews/blameHeatmap';
import { showInteractiveRebase } from './webviews/interactiveRebase';
import { GitVirtualFs, openHistoricFile, diffRevisions } from './git/virtualFs';
import { PullRequestProvider, openPrWebview, pickPrAuthorFilter } from './views/githubPrView';
import { IssuesProvider, openIssueWebview, Issue } from './views/issuesView';
import { showRangeDiff } from './webviews/rangeDiff';
import { showConflictResolver } from './webviews/conflictResolver';
import { showActivityHeatmap } from './webviews/activityHeatmap';
import { generateCommitMessage, explainCommit } from './ai/commitMessage';
import { pickModel, getSelectedModel, listCopilotModels, promptCopilotSignIn } from './ai/copilot';
import { showWorktreeSwitcher } from './views/worktreeSwitcher';
import { StatusBar } from './views/statusBar';

export function activate(ctx: vscode.ExtensionContext) {
  const repos = new RepoManager();
  ctx.subscriptions.push(repos);

  const blame = new BlameController(file => repos.forFile(file));
  ctx.subscriptions.push(blame);

  const status = new StatusBar(repos);
  ctx.subscriptions.push(status);

  const repositoriesView = new RepositoriesView(repos);
  const commits = new CommitsView(repos);
  const branches = new BranchesView(repos);
  const tags = new TagsView(repos);
  const remotes = new RemotesView(repos);
  const stashes = new StashesView(repos);
  const worktrees = new WorktreesView(repos);
  const contributors = new ContributorsView(repos);
  const fileHistory = new FileHistoryView(repos);
  const lineHistory = new LineHistoryView(repos);
  const search = new SearchView(repos);
  const prs = new PullRequestProvider(() => repos.primary() ?? new Git(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()), ctx);
  const issues = new IssuesProvider(() => repos.primary());

  // Virtual filesystem for historic files (gitsight://)
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(GitVirtualFs.SCHEME, new GitVirtualFs(), { isReadonly: true, isCaseSensitive: true })
  );

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitsight.repositories', repositoriesView),
    vscode.window.registerTreeDataProvider('gitsight.commits', commits),
    vscode.window.registerTreeDataProvider('gitsight.branches', branches),
    vscode.window.registerTreeDataProvider('gitsight.tags', tags),
    vscode.window.registerTreeDataProvider('gitsight.remotes', remotes),
    vscode.window.registerTreeDataProvider('gitsight.stashes', stashes),
    vscode.window.registerTreeDataProvider('gitsight.worktrees', worktrees),
    vscode.window.registerTreeDataProvider('gitsight.contributors', contributors),
    vscode.window.registerTreeDataProvider('gitsight.fileHistory', fileHistory),
    vscode.window.registerTreeDataProvider('gitsight.lineHistory', lineHistory),
    vscode.window.registerTreeDataProvider('gitsight.search', search),
    vscode.window.registerTreeDataProvider('gitsight.pullRequests', prs),
    vscode.window.registerTreeDataProvider('gitsight.issues', issues),
  );

  const refreshAll = () => {
    repositoriesView.refresh(); commits.refresh(); branches.refresh(); tags.refresh();
    remotes.refresh(); stashes.refresh(); worktrees.refresh(); contributors.refresh();
    fileHistory.refresh(); lineHistory.refresh();
    vscode.window.visibleTextEditors.forEach(e => blame.renderGutter(e));
  };

  // Initial gutter render
  vscode.window.visibleTextEditors.forEach(e => blame.renderGutter(e));

  const reg = (cmd: string, fn: (...args: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(cmd, fn));

  const primary = (): Git | undefined => repos.primary();
  const gitForActive = (): Git | undefined => {
    const f = vscode.window.activeTextEditor?.document.uri.fsPath;
    return f ? repos.forFile(f) : primary();
  };

  const errorWrap = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); }
    catch (e: any) { vscode.window.showErrorMessage(`GitSight: ${e.message}`); }
  };

  // ── Refresh & graph ─────────────────────────────────────────────
  reg('gitsight.refresh', () => { repos.refresh(); refreshAll(); });
  reg('gitsight.showCommitGraph', () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo in workspace.');
    CommitGraphPanel.show(ctx, git);
  });
  reg('gitsight.searchCommits', async () => {
    const q = await vscode.window.showInputBox({ prompt: 'Search commit messages', placeHolder: 'fix: …' });
    if (q === undefined) return;
    await search.setQuery(q);
    await vscode.commands.executeCommand('gitsight.search.focus');
  });

  // ── Blame & decorations ─────────────────────────────────────────
  const toggle = async (key: string, label: string) => {
    const cfg = vscode.workspace.getConfiguration('gitsight');
    const next = !cfg.get<boolean>(key);
    await cfg.update(key, next, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`GitSight: ${label} ${next ? 'enabled' : 'disabled'}`, 2000);
  };
  reg('gitsight.toggleBlame', () => toggle('blame.enabled', 'inline blame'));
  reg('gitsight.toggleHeatmap', () => toggle('heatmap.enabled', 'heatmap'));
  reg('gitsight.toggleAuthors', () => toggle('authors.enabled', 'author gutter'));

  // ── File / line history ─────────────────────────────────────────
  reg('gitsight.showFileHistory', async () => {
    await vscode.commands.executeCommand('gitsight.fileHistory.focus');
    fileHistory.refresh();
  });
  reg('gitsight.showLineHistory', async () => {
    await vscode.commands.executeCommand('gitsight.lineHistory.focus');
    lineHistory.refresh();
  });

  // ── Show commit detail / file at commit ─────────────────────────
  reg('gitsight.showCommitDetail', (git: Git, sha: string) => errorWrap(async () => {
    const out = await git.show(sha);
    const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  }));
  reg('gitsight.showFileAtCommit', (git: Git, sha: string, file: string) => errorWrap(async () => {
    const content = await git.showFile(sha, path.join(git.cwd, file));
    const doc = await vscode.workspace.openTextDocument({ content, language: vscode.window.activeTextEditor?.document.languageId });
    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  }));

  // ── Commit context actions ──────────────────────────────────────
  reg('gitsight.openLineCommit', () => errorWrap(async () => {
    const editor = vscode.window.activeTextEditor; if (!editor) return;
    const git = repos.forFile(editor.document.uri.fsPath); if (!git) return;
    const lines = await git.blame(editor.document.uri.fsPath);
    const info = lines.find(l => l.line === editor.selection.active.line + 1);
    if (!info || /^0+$/.test(info.sha)) return vscode.window.showInformationMessage('Line is uncommitted.');
    const out = await git.show(info.sha);
    const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  }));
  reg('gitsight.openCommitOnRemote', (n: any) => errorWrap(async () => {
    const git: Git = n?.git ?? primary();
    const sha: string = n?.commit?.sha ?? n?.sha;
    if (!git || !sha) return;
    const rems = await git.remotes();
    const origin = rems.find(r => r.name === 'origin') ?? rems[0];
    if (!origin) return vscode.window.showWarningMessage('GitSight: no remote configured.');
    const url = remoteWebUrl(origin.fetchUrl, sha);
    if (url) vscode.env.openExternal(vscode.Uri.parse(url));
  }));
  reg('gitsight.copyCommitSha', (arg: any) => {
    const sha = typeof arg === 'string' ? arg : arg?.commit?.sha;
    if (!sha) return;
    vscode.env.clipboard.writeText(sha);
    vscode.window.setStatusBarMessage(`Copied ${sha.slice(0, 7)}`, 1500);
  });
  reg('gitsight.copyCommitMessage', (arg: any) => {
    const c = arg?.commit;
    if (!c) return;
    vscode.env.clipboard.writeText(`${c.subject}\n\n${c.body}`.trim());
    vscode.window.setStatusBarMessage('Message copied', 1500);
  });
  reg('gitsight.cherryPick', (n: any) => errorWrap(async () => {
    const git: Git = n.git; await git.cherryPick(n.commit.sha);
    vscode.window.showInformationMessage(`Cherry-picked ${n.commit.shortSha}`);
    refreshAll();
  }));
  reg('gitsight.revertCommit', (n: any) => errorWrap(async () => {
    const git: Git = n.git; await git.revert(n.commit.sha);
    vscode.window.showInformationMessage(`Reverted ${n.commit.shortSha}`);
    refreshAll();
  }));
  reg('gitsight.resetToCommit', (n: any) => errorWrap(async () => {
    const mode = await vscode.window.showQuickPick(
      [{ label: 'soft', detail: 'keep changes staged' }, { label: 'mixed', detail: 'keep changes unstaged' }, { label: 'hard', detail: '⚠ discard all changes' }],
      { placeHolder: `Reset current branch to ${n.commit.shortSha} how?` },
    );
    if (!mode) return;
    await (n.git as Git).resetTo(n.commit.sha, mode.label as any);
    refreshAll();
  }));
  reg('gitsight.explainCommit', (n: any) => errorWrap(async () => {
    const git: Git = n?.git ?? primary(); if (!git) return;
    const sha: string = n?.commit?.sha;
    if (!sha) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitSight: explaining commit…' },
      async () => {
        const out = await git.show(sha);
        const explanation = await explainCommit(ctx, out);
        const md = new vscode.MarkdownString(`# Commit ${sha.slice(0, 7)}\n\n${explanation}`);
        const doc = await vscode.workspace.openTextDocument({ content: md.value, language: 'markdown' });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      },
    );
  }));

  // ── Branch ops ──────────────────────────────────────────────────
  reg('gitsight.checkoutBranch', (git: Git | any, name?: string) => errorWrap(async () => {
    const g: Git = git instanceof Git ? git : git?.git ?? primary();
    const target = name ?? git?.branch?.name;
    if (!g || !target) return;
    await g.checkout(target.replace(/^origin\//, ''));
    refreshAll();
  }));
  reg('gitsight.createBranch', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
    if (!name) return;
    await git.createBranch(name);
    const checkout = await vscode.window.showInformationMessage(`Branch '${name}' created`, 'Checkout');
    if (checkout === 'Checkout') await git.checkout(name);
    refreshAll();
  }));
  reg('gitsight.deleteBranch', (n: any) => errorWrap(async () => {
    const ans = await vscode.window.showWarningMessage(`Delete branch '${n.branch.name}'?`, { modal: true }, 'Delete', 'Force delete');
    if (!ans) return;
    await (n.git as Git).deleteBranch(n.branch.name, ans === 'Force delete');
    refreshAll();
  }));
  reg('gitsight.renameBranch', (n: any) => errorWrap(async () => {
    const to = await vscode.window.showInputBox({ prompt: `Rename '${n.branch.name}' to…`, value: n.branch.name });
    if (!to || to === n.branch.name) return;
    await (n.git as Git).renameBranch(n.branch.name, to);
    refreshAll();
  }));
  reg('gitsight.mergeBranch', (n: any) => errorWrap(async () => {
    const ok = await vscode.window.showWarningMessage(`Merge '${n.branch.name}' into current branch?`, { modal: true }, 'Merge');
    if (!ok) return;
    await (n.git as Git).merge(n.branch.name); refreshAll();
  }));
  reg('gitsight.rebaseBranch', (n: any) => errorWrap(async () => {
    const ok = await vscode.window.showWarningMessage(`Rebase current branch onto '${n.branch.name}'?`, { modal: true }, 'Rebase');
    if (!ok) return;
    await (n.git as Git).rebase(n.branch.name); refreshAll();
  }));
  reg('gitsight.compareBranches', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const all = await git.branches(true);
    const from = await vscode.window.showQuickPick(all.map(b => b.name), { placeHolder: 'Compare from…' });
    if (!from) return;
    const to = await vscode.window.showQuickPick(all.map(b => b.name), { placeHolder: 'Compare to…' });
    if (!to) return;
    const diff = await git.diff({ from, to });
    const doc = await vscode.workspace.openTextDocument({ content: diff || `# No differences between ${from} and ${to}`, language: 'diff' });
    vscode.window.showTextDocument(doc);
  }));
  reg('gitsight.compareWithWorking', (n: any) => errorWrap(async () => {
    const diff = await (n.git as Git).diff({ from: n.branch.name });
    const doc = await vscode.workspace.openTextDocument({ content: diff || '# No differences', language: 'diff' });
    vscode.window.showTextDocument(doc);
  }));

  // ── Tag ops ─────────────────────────────────────────────────────
  reg('gitsight.createTag', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const name = await vscode.window.showInputBox({ prompt: 'Tag name', placeHolder: 'v1.0.0' });
    if (!name) return;
    const msg = await vscode.window.showInputBox({ prompt: 'Tag message (annotated). Leave blank for lightweight.' });
    await git.createTag(name, undefined, msg || undefined);
    refreshAll();
  }));
  reg('gitsight.deleteTag', (n: any) => errorWrap(async () => {
    const ok = await vscode.window.showWarningMessage(`Delete tag '${n.tag.name}'?`, { modal: true }, 'Delete');
    if (!ok) return;
    await (n.git as Git).deleteTag(n.tag.name); refreshAll();
  }));

  // ── Remotes ─────────────────────────────────────────────────────
  reg('gitsight.fetch', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'GitSight: fetching…' }, () => git.fetch());
    refreshAll();
  }));
  reg('gitsight.pull', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await git.pull(); refreshAll();
  }));
  reg('gitsight.push', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const branch = await git.currentBranch();
    await git.push('origin', branch); refreshAll();
  }));
  reg('gitsight.addRemote', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const name = await vscode.window.showInputBox({ prompt: 'Remote name', value: 'origin' });
    if (!name) return;
    const url = await vscode.window.showInputBox({ prompt: 'Remote URL' });
    if (!url) return;
    await git.addRemote(name, url); refreshAll();
  }));
  reg('gitsight.removeRemote', (n: any) => errorWrap(async () => {
    const ok = await vscode.window.showWarningMessage(`Remove remote '${n.remote.name}'?`, { modal: true }, 'Remove');
    if (!ok) return;
    await (n.git as Git).removeRemote(n.remote.name); refreshAll();
  }));

  // ── Stashes ─────────────────────────────────────────────────────
  reg('gitsight.stashSave', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const msg = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
    await git.stashSave(msg || undefined); refreshAll();
  }));
  reg('gitsight.stashApply', (n: any) => errorWrap(async () => { await (n.git as Git).stashApply(n.stash.ref); refreshAll(); }));
  reg('gitsight.stashPop',   (n: any) => errorWrap(async () => { await (n.git as Git).stashPop(n.stash.ref); refreshAll(); }));
  reg('gitsight.stashDrop',  (n: any) => errorWrap(async () => {
    const ok = await vscode.window.showWarningMessage(`Drop stash '${n.stash.subject}'?`, { modal: true }, 'Drop');
    if (!ok) return;
    await (n.git as Git).stashDrop(n.stash.ref); refreshAll();
  }));

  // ── Worktrees ───────────────────────────────────────────────────
  reg('gitsight.createWorktree', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const branch = await vscode.window.showInputBox({ prompt: 'Branch name (existing or new)', placeHolder: 'feature/x' });
    if (!branch) return;
    const createNew = (await vscode.window.showQuickPick(['Create new branch', 'Use existing branch'], { placeHolder: 'New or existing?' })) === 'Create new branch';
    const defaultPath = path.join(path.dirname(git.cwd), `${path.basename(git.cwd)}-${branch.replace(/\//g, '-')}`);
    const target = await vscode.window.showInputBox({ prompt: 'Worktree path', value: defaultPath });
    if (!target) return;
    await git.addWorktree(target, branch, createNew);
    refreshAll();
    const open = await vscode.window.showInformationMessage(`Worktree created at ${target}`, 'Open in new window');
    if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
  }));
  reg('gitsight.removeWorktree', (n: any) => errorWrap(async () => {
    const ok = await vscode.window.showWarningMessage(`Remove worktree ${n.worktree.path}?`, { modal: true }, 'Remove');
    if (!ok) return;
    await (n.git as Git).removeWorktree(n.worktree.path); refreshAll();
  }));
  reg('gitsight.switchToWorktree', (p: string) => {
    if (p) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: true });
  });

  // ── AI ──────────────────────────────────────────────────────────
  reg('gitsight.generateCommitMessage', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitSight: generating commit message…' },
      async () => {
        let diff = await git.diff({ staged: true });
        if (!diff.trim()) diff = await git.diff();
        if (!diff.trim()) return vscode.window.showInformationMessage('Nothing to commit.');
        const msg = await generateCommitMessage(ctx, diff);
        const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
        const api = gitExt?.getAPI(1);
        const repo = api?.repositories?.[0];
        if (repo) {
          repo.inputBox.value = msg;
          await vscode.commands.executeCommand('workbench.view.scm');
        } else {
          const doc = await vscode.workspace.openTextDocument({ content: msg, language: 'markdown' });
          vscode.window.showTextDocument(doc);
        }
      },
    );
  }));

  // ── AI: Copilot model picker ────────────────────────────────────
  reg('gitsight.pickAIModel', () => errorWrap(async () => { await pickModel(ctx); }));
  reg('gitsight.signInCopilot', () => errorWrap(async () => { await promptCopilotSignIn(); }));
  reg('gitsight.showAIStatus', () => errorWrap(async () => {
    const sel = getSelectedModel(ctx);
    const models = await listCopilotModels();
    if (!models.length) {
      const go = await vscode.window.showWarningMessage('No Copilot models available. Sign in?', 'Sign in', 'Cancel');
      if (go === 'Sign in') await promptCopilotSignIn();
      return;
    }
    const names = models.map((m: any) => m.name ?? m.family).join(', ');
    vscode.window.showInformationMessage(
      `GitSight AI · Active: ${sel?.name ?? 'auto'} · Available: ${names}`,
      'Change model',
    ).then(c => { if (c === 'Change model') pickModel(ctx); });
  }));

  // ── Worktree quick-switcher ─────────────────────────────────────
  reg('gitsight.worktreeSwitcher', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await showWorktreeSwitcher(git);
  }));

  vscode.window.setStatusBarMessage('GitSight ready', 3000);

  // ── Blame Heatmap (webview) ─────────────────────────────────────
  reg('gitsight.showBlameHeatmap', () => errorWrap(async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage('Open a file first.');
    const f = editor.document.uri.fsPath;
    const git = repos.forFile(f);
    if (!git) return vscode.window.showWarningMessage('File not in a Git repo.');
    await showBlameHeatmap(git, f);
  }));

  // ── Interactive Rebase ─────────────────────────────────────────
  reg('gitsight.interactiveRebase', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await showInteractiveRebase(git);
    refreshAll();
  }));

  // ── Open historic file via virtual fs ───────────────────────────
  reg('gitsight.openHistoricFile', (n: any) => errorWrap(async () => {
    const git: Git = n?.git ?? primary(); if (!git) return;
    const sha: string = n?.commit?.sha ?? n?.sha;
    const file: string = n?.file ?? vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    if (!sha || !file) return;
    const rel = path.relative(git.cwd, file);
    await openHistoricFile(git.cwd, sha, rel);
  }));

  reg('gitsight.diffWithWorking', (n: any) => errorWrap(async () => {
    const git: Git = n?.git ?? primary(); if (!git) return;
    const sha: string = n?.commit?.sha ?? n?.sha;
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!sha || !file) return;
    const rel = path.relative(git.cwd, file);
    await diffRevisions(git.cwd, rel, sha, 'WORKING');
  }));

  // ── GitHub PRs ──────────────────────────────────────────────────
  reg('gitsight.refreshPullRequests', () => prs.refresh());
  reg('gitsight.filterPrsByAuthor', () => pickPrAuthorFilter(prs));
  reg('gitsight.filterPrsByMe', () => prs.setAuthorFilter('@me'));
  reg('gitsight.clearPrAuthorFilter', () => prs.setAuthorFilter(undefined));
  reg('gitsight.openPr', (pr: any) => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await openPrWebview(pr, prs.getProvider());
  }));
  reg('gitsight.checkoutPr', (n: any) => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const pr = n?.pr ?? n;
    if (!pr?.number) return;
    await new Promise<void>((res, rej) =>
      require('child_process').execFile('gh', ['pr', 'checkout', String(pr.number)], { cwd: git.cwd }, (e: any) => e ? rej(e) : res())
    );
    refreshAll();
  }));
  // Auto-load PRs on startup
  setTimeout(() => prs.load(), 1500);

  // ── GitHub Issues ───────────────────────────────────────────────
  reg('gitsight.refreshIssues', () => issues.refresh());
  reg('gitsight.openIssue', (iss: Issue) => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await openIssueWebview(iss, git);
  }));
  reg('gitsight.filterIssuesAll', () => issues.setFilter('all'));
  reg('gitsight.filterIssuesAssigned', () => issues.setFilter('assigned'));
  reg('gitsight.filterIssuesCreated', () => issues.setFilter('created'));
  reg('gitsight.createIssue', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const title = await vscode.window.showInputBox({ prompt: 'Issue title' });
    if (!title) return;
    const body = await vscode.window.showInputBox({ prompt: 'Issue body (optional)' }) ?? '';
    const term = vscode.window.createTerminal({ name: 'GitSight: gh issue create', cwd: git.cwd });
    term.show();
    term.sendText(`gh issue create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`);
  }));
  setTimeout(() => issues.load(), 2000);

  // ── Range Diff (split-view) ─────────────────────────────────────
  reg('gitsight.rangeDiff', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showRangeDiff(git);
  }));
  reg('gitsight.diffBranchAgainstMain', (n: any) => errorWrap(async () => {
    const git: Git = n?.git ?? primary(); if (!git) return;
    const branch = n?.branch?.name ?? n?.name;
    if (!branch) return;
    await showRangeDiff(git, 'main', branch);
  }));

  // ── Merge Conflict Resolver ─────────────────────────────────────
  reg('gitsight.resolveConflicts', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showConflictResolver(git);
  }));

  // ── Contribution Activity Heatmap ───────────────────────────────
  reg('gitsight.activityHeatmap', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showActivityHeatmap(git, ctx);
  }));
}

export function deactivate() {}
