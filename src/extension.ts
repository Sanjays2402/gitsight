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
import { generateChangelog } from './ai/changelog';
import { generatePullRequestDescription } from './ai/prDescription';
import { BisectWizard } from './views/bisectWizard';
import { showStashVisualizer } from './webviews/stashVisualizer';
import { reviewStaged, reviewCommit, reviewRange } from './ai/review';
import { showBranchProtection } from './views/branchProtection';
import { CodeownersOverlay } from './views/codeownersOverlay';
import { CiPanel } from './views/ciPanel';
import { CommitSparkline } from './views/commitSparkline';
import { showStackedPRNavigator } from './views/stackedPR';
import { WorktreePill } from './views/worktreePill';
import { toggleDiffWordWrap } from './views/diffWordWrap';
import { pickTheme } from './views/graphThemes';
import { StatusBar } from './views/statusBar';
import { showBranchQuickSwitcher } from './views/branchSwitcher';
import { openRepoOnRemote, openBranchOnRemote, openFileOnRemote } from './git/openOnRemote';
import { runSync, SyncStatusBar } from './views/sync';
import { WorkingTreePill } from './views/workingTreePill';
import { RecentFilesView } from './views/recentFilesView';
import { BlameHoverProvider } from './blame/blameHover';
import { GitignoreInsightLens, showIgnoredFilesPicker } from './views/gitignoreLens';
import { FileCommitLensProvider } from './views/fileCommitLens';
import { showAuthorsOfRange } from './views/authorsOfRange';
import { showBranchCleanup } from './views/branchCleanup';
import { CommitLintController } from './views/commitLintController';
import { showRestoreFromCommit } from './views/restoreFromCommit';
import { RebaseCoach } from './views/rebaseCoach';
import { showTagQuickSwitcher } from './views/tagSwitcher';
import { showFindCoAuthors } from './views/findCoAuthors';
import { showBranchCompareSummary } from './views/branchCompareSummary';
import { showConventionalCommitInsert } from './views/conventionalCommit';
import { showStashQuickSwitcher } from './views/stashSwitcher';
import { ConflictMarkerController } from './views/conflictMarkerController';
import { showRecentBranches, checkoutPreviousBranch } from './views/recentBranches';
import { LastTagPill } from './views/lastTagPill';
import { showWhatWillPush } from './views/whatWillPush';
import { showWipHunter } from './views/wipHunter';
import { showRepoSizeReport } from './views/repoSize';
import { showOpenLastPushedBranch } from './views/openLastPushed';
import { LockfileWatcher } from './views/lockfileWatcher';
import { registerSelectionHistory } from './views/selectionHistory';
import { BranchDivergenceWatcher } from './views/branchDivergence';
import { ForgottenFilesController } from './views/forgottenFiles';
import { showWorkingTreeCompare } from './views/workingTreeCompare';
import { registerStashNamingCommands } from './views/stashNaming';
import { showGitattributesDiagnostics } from './views/gitattributesDiag';
import { runPrePushLint } from './views/prePushLintGate';
import { runPrePushMessageGate } from './views/prePushMessageGate';
import { showFilesIOwnPicker } from './views/filesIOwn';
import { checkoutWithAutoStash } from './views/autoStashCheckout';
import { showWorktreeDiskUsage } from './views/worktreeDiskUsage';
import { runPreCommitBridge } from './views/preCommitBridge';
import { showRebasePlanPreview } from './views/rebasePlanPreview';
import { FixtureLensProvider } from './views/fixtureLens';
import { showAdvancedCommitSearch } from './views/commitSearchAdvanced';
import { showBranchStalenessPruner } from './views/branchStalenessPruner';
import { withAuthSanityCheck, runStartupAuthProbe } from './views/sshKeyCheck';
import { openInCodespaces } from './views/codespaces';
import { showStashDiffBrowser } from './views/stashDiffBrowser';
import { SubmodulePill, showSubmoduleMenu } from './views/submodulePill';
import { SubmoduleAutoPullWatcher } from './views/submoduleAutoPull';
import { ActionsPill } from './views/actionsPill';
import { showCommitByCommitTestRunner } from './views/commitTestRunner';
import { showDefaultReviewersPicker } from './views/defaultReviewers';
import { CommitScaffoldController } from './views/commitScaffold';
import { showRerereCacheVisualizer } from './views/rerereCache';
import { showWorktreePruner } from './views/worktreePruner';
import { scoutAndCherryPick } from './views/cherryPickScout';
import { showStashTrashBin, exportStashPatches } from './views/stashTrashBin';
import { importStashPatch } from './views/stashPatchImport';
import { StashPatchDiscoveryController } from './views/stashPatchDiscovery';
import { showReflogExplorer } from './views/reflogExplorer';
import { registerOpenAtLastTouched } from './views/openAtLastTouched';
import { forcePush, checkBranchProtection } from './views/forcePushGuard';
import { showCommitFooterComposer } from './views/commitFooter';
import { insertIssueAtCursor, insertIssueAsMarkdownLink, appendIssueTrailerToScm } from './views/issueInsert';
import { showWhatsMineDashboard } from './views/whatsMine';
import { CodeownersValidatorController, runValidateCodeowners } from './views/codeownersValidator';
import { runPrCheckoutPreflight, runPrCheckoutPreflightInteractive } from './views/prCheckoutPreflight';
import { PrTemplateLintController, runPrTemplateLintCommand } from './views/prTemplateLint';
import { runOpenIssueFromSelection, OpenIssueCodeActionProvider } from './views/openIssueFromSelection';
import { runFindInactiveReviewers } from './views/inactiveReviewers';
import { PrTimelinePill } from './views/prTimelinePill';
import { runConflictCoach, registerConflictCoach } from './views/conflictCoach';
import { showReleasesCompanion } from './views/githubReleases';
import { showPrReviewInbox } from './views/prReviewInbox';
import { runPrDraftSyncFireAndForget } from './views/prDraftSync';
import { StagedConflictGateController } from './views/stagedConflictGate';
import { runStashOnSwitchFireAndForget } from './views/stashOnSwitch';
import { RecentContributorsProvider } from './views/recentContributors';
import { showTagFromMergedPrompt } from './views/tagOnMerge';
import { generatePrDescriptionFromSelection } from './views/prFromSelection';
import { showBisectFromCiFailure } from './views/bisectFromCi';
import { showPrCommentsInbox } from './views/prComments';
import { composeAndPostPrComment } from './views/prCommentCompose';
import { resolvePrCommentThreads } from './views/prThreadResolve';
import { runGuardedPull } from './views/stashOnPull';
import { createBranchWithAssistant } from './views/branchNamer';
import { ComplexityBadgeProvider } from './views/complexityBadge';
import { showComplexityForPrCommand } from './views/complexityForPr';
import { runAutoResolveTrivialConflicts } from './views/conflictAutoResolve';
import { SecretAuditPill } from './views/secretAudit';
import { showWorkspaceSecretAudit } from './views/workspaceSecretAudit';
import { DiffSizeHeuristicController } from './views/diffSizeHeuristic';
import { DcoSignoffController } from './views/dcoSignoffController';
import { runReleaseSinceLastTag } from './views/releaseSinceLastTag';
import { summarisePrComments, normalisePrArg as normaliseReviewSummaryArg } from './views/reviewSummaryAi';
import { runMergeQueueStatus } from './views/mergeQueue';
import { showBranchProtectionOverview } from './views/branchProtectionOverview';
import { showWhatsStaleDashboard } from './views/whatsStale';
import { enqueueCurrentPr, dequeueCurrentPr } from './views/mergeQueueActions';
import { showTestImpactForCurrentPr } from './views/testImpact';
import { submitPrReview, approvePrQuick } from './views/prReviewSubmit';
import { showReviewerLoadReport } from './views/reviewerLoadBalancer';
import { injectTestImpactIntoPr, runTestImpactAutoSyncFireAndForget } from './views/testImpactPrBody';
import { suggestBranchProtection } from './views/branchProtectionSuggest';

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
  const recentFiles = new RecentFilesView(repos);

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
    vscode.window.registerTreeDataProvider('gitsight.recentFiles', recentFiles),
  );

  const refreshAll = () => {
    repositoriesView.refresh(); commits.refresh(); branches.refresh(); tags.refresh();
    remotes.refresh(); stashes.refresh(); worktrees.refresh(); contributors.refresh();
    fileHistory.refresh(); lineHistory.refresh();
    recentFiles.refresh();
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
    const git: Git = n.git;
    // F65: pre-scout the current branch for a same-subject commit before
    // actually running cherry-pick — surface a modal warning so the user
    // can abort the double-pick mistake. Falls through to plain
    // git.cherryPick when the scout finds nothing OR the user opts in.
    await scoutAndCherryPick({
      git,
      commit: {
        sha: n.commit.sha,
        shortSha: n.commit.shortSha,
        subject: n.commit.subject ?? '',
        author: n.commit.author ?? undefined,
      },
    });
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
    // F48: auto-stash when the worktree has local changes that would be
    // overwritten by the switch.
    const targetName = target.replace(/^origin\//, '');
    await checkoutWithAutoStash(g, targetName);
    // F80: after a successful switch, offer to apply stashes that were
    // created while previously on this branch. Fire-and-forget so a
    // failure can't undo the checkout.
    runStashOnSwitchFireAndForget(g, targetName);
    refreshAll();
  }));
  reg('gitsight.createBranch', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    // F110: prefill with a smart kebab name suggested from SCM input,
    // selection, dirty paths, and active filename. Falls back to a plain
    // input box when the assistant is disabled or returns no candidates.
    await createBranchWithAssistant(git, repos);
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
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'GitSight: fetching\u2026' }, () =>
      withAuthSanityCheck(git, 'origin', () => git.fetch()),
    );
    refreshAll();
  }));
  reg('gitsight.pull', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    // F109: wrap pull in a guard that classifies the "local changes
    // would be overwritten" failure into a stash + pull + pop recovery.
    // The guard runs the auth sanity check internally when the underlying
    // pull is invoked, so we still get the F54 behaviour on auth failures.
    await withAuthSanityCheck(git, 'origin', async () => {
      await runGuardedPull(git);
    });
    refreshAll();
  }));
  reg('gitsight.push', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const branch = await git.currentBranch();
    // Pre-push lint hook (F14): scan <upstream>..HEAD for WIP commits,
    // unresolved conflict markers, and (optionally) missing issue refs.
    const lint = await runPrePushLint(git);
    if (lint.decision === 'cancel') {
      vscode.window.setStatusBarMessage('GitSight: push cancelled by pre-push lint.', 3000);
      return;
    }
    // Pre-push commit-message gate (F69): run the same linter used by the
    // SCM input-box validator against every commit in the to-push range.
    const msgGate = await runPrePushMessageGate(git);
    if (msgGate.decision === 'cancel') {
      vscode.window.setStatusBarMessage('GitSight: push cancelled by commit-message gate.', 3000);
      return;
    }
    await withAuthSanityCheck(git, 'origin', () => git.push('origin', branch));
    // PR Draft Auto-Sync (F77): if the just-pushed branch has an open
    // DRAFT PR on GitHub, refresh its body from <base>..HEAD. Fire-and-
    // forget so a transient gh failure never blocks the push.
    runPrDraftSyncFireAndForget(git, branch);
    // Test-Impact Auto-Sync (F129): if the just-pushed branch has an open
    // PR whose body already contains the F125 managed block, refresh it.
    // Same fire-and-forget contract as F77 - never blocks the push.
    runTestImpactAutoSyncFireAndForget(repos, branch);
    refreshAll();
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

  // ── AI changelog generator ──────────────────────────────────────
  reg('gitsight.generateChangelog', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await generateChangelog(ctx, git);
  }));

  // ── AI PR description generator ─────────────────────────────────
  reg('gitsight.generatePullRequestDescription', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await generatePullRequestDescription(ctx, git);
  }));

  // ── Bisect wizard ───────────────────────────────────────────────
  const bisect = new BisectWizard(() => primary());
  ctx.subscriptions.push(bisect);
  reg('gitsight.bisectStart', () => errorWrap(() => bisect.start()));
  reg('gitsight.bisectGood', () => errorWrap(() => bisect.mark('good')));
  reg('gitsight.bisectBad', () => errorWrap(() => bisect.mark('bad')));
  reg('gitsight.bisectSkip', () => errorWrap(() => bisect.mark('skip')));
  reg('gitsight.bisectRun', () => errorWrap(() => bisect.run()));
  reg('gitsight.bisectReset', () => errorWrap(() => bisect.reset()));
  reg('gitsight.bisectMenu', () => errorWrap(() => bisect.menu()));

  // ── Stash visualizer (partial apply) ────────────────────────────
  reg('gitsight.stashVisualizer', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await showStashVisualizer(git);
  }));

  // ── AI code review ──────────────────────────────────────────────
  reg('gitsight.aiReviewStaged', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await reviewStaged(ctx, git);
  }));
  reg('gitsight.aiReviewCommit', (n: any) => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const sha = n?.sha ?? await vscode.window.showInputBox({ prompt: 'Commit SHA to review' });
    if (sha) await reviewCommit(ctx, git, sha);
  }));
  reg('gitsight.aiReviewRange', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await reviewRange(ctx, git);
  }));

  // ── Branch protection viewer ────────────────────────────────────
  reg('gitsight.branchProtection', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await showBranchProtection(git);
  }));

  // ── CODEOWNERS overlay ──────────────────────────────────────────
  const codeowners = new CodeownersOverlay(() => primary());
  ctx.subscriptions.push(codeowners);
  reg('gitsight.codeownersExplain', () => errorWrap(() => codeowners.explain()));
  reg('gitsight.codeownersCheckStaged', () => errorWrap(() => codeowners.checkStagedOwnership()));

  // ── CI panel (GitHub Actions / Azure Pipelines) ─────────────────
  const ci = new CiPanel(() => primary());
  ctx.subscriptions.push(ci);
  reg('gitsight.ciShow', () => errorWrap(() => ci.show()));
  reg('gitsight.ciRefresh', () => errorWrap(() => ci.refresh()));

  // ── Commit sparkline ─────────────────────────────────────────────
  ctx.subscriptions.push(new CommitSparkline(() => primary()));

  // ── Worktree-aware status bar pill ───────────────────────────────
  ctx.subscriptions.push(new WorktreePill(() => primary()));

  // ── Stacked PR Navigator ─────────────────────────────────────────
  reg('gitsight.stackedPRNavigator', () => errorWrap(async () => {
    const git = primary(); if (!git) return;
    await showStackedPRNavigator(git);
  }));

  // ── Diff Word-Wrap Toggle ────────────────────────────────────────
  reg('gitsight.toggleDiffWordWrap', () => errorWrap(async () => { await toggleDiffWordWrap(); }));

  // ── Commit graph theme picker ────────────────────────────────────
  reg('gitsight.pickGraphTheme', () => errorWrap(() => pickTheme()));

  // ── Branch Quick-Switcher (Cmd+Shift+B) ──────────────────────────
  reg('gitsight.branchQuickSwitcher', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showBranchQuickSwitcher(ctx, git);
  }));

  // ── Open on Remote suite ─────────────────────────────────────────
  reg('gitsight.openRepoOnRemote', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await openRepoOnRemote(git);
  }));
  reg('gitsight.openBranchOnRemote', (n: any) => errorWrap(async () => {
    const git: Git = n?.git ?? primary();
    if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const branch = n?.branch?.name ?? n?.name;
    await openBranchOnRemote(git, branch);
  }));
  reg('gitsight.openFileOnRemote', () => errorWrap(async () => {
    const git = gitForActive() ?? primary();
    if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await openFileOnRemote(git);
  }));

  // ── One-Click Sync ───────────────────────────────────────────────
  const syncPill = new SyncStatusBar(repos);
  ctx.subscriptions.push(syncPill);
  reg('gitsight.sync', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const res = await runSync(git);
    if (res.ok) vscode.window.setStatusBarMessage(`GitSight sync: ${res.message}`, 4000);
    else vscode.window.showErrorMessage(`GitSight sync failed: ${res.message}`);
    syncPill.refresh();
    refreshAll();
  }));

  // ── Working-Tree status pill (F6) ────────────────────────────────
  const workingTreePill = new WorkingTreePill(repos);
  ctx.subscriptions.push(workingTreePill);
  reg('gitsight.refreshWorkingTree', () => workingTreePill.refresh());

  // ── Submodule status pill (F59) ──────────────────────────────────
  const submodulePill = new SubmodulePill(repos);
  ctx.subscriptions.push(submodulePill);
  reg('gitsight.refreshSubmodules', () => submodulePill.refresh());
  reg('gitsight.submoduleMenu', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showSubmoduleMenu(git, submodulePill.getLatest());
  }));

  // ── Submodule Auto-Pull watcher (F70) ────────────────────────────
  const submoduleAutoPull = new SubmoduleAutoPullWatcher(repos);
  ctx.subscriptions.push(submoduleAutoPull);

  // ── GitHub Actions Run Pill (F62) ────────────────────────────────
  const actionsPill = new ActionsPill(repos);
  ctx.subscriptions.push(actionsPill);
  reg('gitsight.refreshActionsPill', () => actionsPill.refresh());

  // ── Recent Files Touched view (F7) ───────────────────────────────
  reg('gitsight.refreshRecentFiles', () => recentFiles.refresh());
  reg('gitsight.openRecentFile', (entry: any) => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const rel = entry?.entry?.path ?? entry?.path;
    if (!rel) return;
    const uri = vscode.Uri.file(path.join(git.cwd, rel));
    await vscode.commands.executeCommand('vscode.open', uri);
  }));
  reg('gitsight.openHistoryForRecentFile', (entry: any) => errorWrap(async () => {
    const git = primary(); if (!git) return;
    const rel = entry?.entry?.path ?? entry?.path;
    if (!rel) return;
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(git.cwd, rel)));
    await vscode.commands.executeCommand('gitsight.showFileHistory');
  }));

  // ── Blame Hover provider (F11) ───────────────────────────────────
  const blameHover = new BlameHoverProvider(file => repos.forFile(file));
  ctx.subscriptions.push(blameHover.register());

  // ── Gitignore Insight CodeLens (F15) ─────────────────────────────
  const ignoreLens = new GitignoreInsightLens(repos);
  ctx.subscriptions.push(ignoreLens.register());
  reg('gitsight.showIgnoredFiles', (arg: any) => errorWrap(() => showIgnoredFilesPicker(arg)));

  // ── Per-File Commit CodeLens (F20) ───────────────────────────────
  const fileLens = new FileCommitLensProvider(repos);
  ctx.subscriptions.push(fileLens.register());

  // ── Show Authors of Range (F8) ───────────────────────────────────
  reg('gitsight.authorsOfRange', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showAuthorsOfRange(ctx, git);
  }));

  // ── Branch Cleanup (F9) ──────────────────────────────────────────
  reg('gitsight.branchCleanup', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showBranchCleanup(git);
  }));

  // ── Commit-Message Linter (F21) ──────────────────────────────────
  const commitLint = new CommitLintController();
  ctx.subscriptions.push(commitLint);
  ctx.subscriptions.push(...commitLint.registerCommands());

  // ── Restore File from any commit (F17) ───────────────────────────
  reg('gitsight.restoreFileFromCommit', () => errorWrap(async () => {
    const git = gitForActive() ?? primary();
    if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showRestoreFromCommit(git);
  }));

  // ── Smart Rebase Conflict Coach (F10) ────────────────────────────
  const rebaseCoach = new RebaseCoach(repos);
  ctx.subscriptions.push(rebaseCoach);
  reg('gitsight.rebaseCoach', () => errorWrap(() => rebaseCoach.showMenu()));
  reg('gitsight.refreshRebaseCoach', () => rebaseCoach.refresh());

  // ── Tag Quick-Switcher (F16) ─────────────────────────────────────
  reg('gitsight.tagQuickSwitcher', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showTagQuickSwitcher(git);
  }));

  // ── Find Co-Authors (F18) ────────────────────────────────────────
  reg('gitsight.findCoAuthors', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showFindCoAuthors(git);
  }));

  // ── Branch Compare Summary (F26) ─────────────────────────────────
  reg('gitsight.branchCompareSummary', (n?: any) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const head = n?.branch?.name ?? n?.name;
    await showBranchCompareSummary(git, head ? { head } : undefined);
  }));

  // ── Conventional Commit Quick-Insert (F29) ───────────────────────
  reg('gitsight.conventionalCommitInsert', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showConventionalCommitInsert(git);
  }));

  // ── Stash Quick-Switcher (F31) ───────────────────────────────────
  reg('gitsight.stashQuickSwitcher', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showStashQuickSwitcher(git);
  }));

  // ── Conflict Marker Linter (F34) ─────────────────────────────────
  const conflictLinter = new ConflictMarkerController();
  ctx.subscriptions.push(conflictLinter);
  ctx.subscriptions.push(...conflictLinter.registerCommands());

  // ── Recent Branches MRU (F32) ────────────────────────────────────
  reg('gitsight.recentBranches', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showRecentBranches(git);
  }));
  reg('gitsight.checkoutPreviousBranch', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await checkoutPreviousBranch(git);
  }));

  // ── Last-Tag Pill (F30) ──────────────────────────────────────────
  const lastTagPill = new LastTagPill(repos);
  ctx.subscriptions.push(lastTagPill);
  reg('gitsight.refreshLastTagPill', () => lastTagPill.refresh());

  // ── What Will Push (F33) ─────────────────────────────────────────
  reg('gitsight.whatWillPush', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showWhatWillPush(git);
  }));

  // ── WIP Commit Hunter (F37) ──────────────────────────────────────
  reg('gitsight.wipHunter', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showWipHunter(git);
  }));

  // ── Repo Size + Biggest Files report (F40) ───────────────────────
  reg('gitsight.repoSizeReport', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showRepoSizeReport(git);
  }));

  // ── Open Last Pushed Branch (F38) ────────────────────────────────
  reg('gitsight.openLastPushedBranch', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showOpenLastPushedBranch(git);
  }));

  // ── Lockfile Change Watcher (F28) ────────────────────────────────
  const lockfileWatcher = new LockfileWatcher(repos);
  ctx.subscriptions.push(lockfileWatcher);

  // ── Selection History / Reveal in History CodeAction (F23) ───────
  ctx.subscriptions.push(...registerSelectionHistory(ctx, repos));

  // ── Branch Divergence Visualiser (F36) ───────────────────────────
  const branchDivergence = new BranchDivergenceWatcher(repos);
  ctx.subscriptions.push(branchDivergence);

  // ── Forgotten Files Diagnostic (F39) ─────────────────────────────
  const forgotten = new ForgottenFilesController(repos);
  ctx.subscriptions.push(forgotten);
  ctx.subscriptions.push(...forgotten.registerCommands());

  // ── Compare Working Tree to Any Commit (F44) ─────────────────────
  reg('gitsight.compareWorkingTreeToCommit', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showWorkingTreeCompare(git);
  }));

  // ── Smart Stash Save (F43) ───────────────────────────────────────
  ctx.subscriptions.push(...registerStashNamingCommands(() => primary()));

  // ── .gitattributes Diagnostics (F42) ─────────────────────────────
  reg('gitsight.gitattributesDiagnostics', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showGitattributesDiagnostics(git);
  }));

  // ── Files I own picker (F47) ────────────────────────────────────
  reg('gitsight.filesIOwn', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showFilesIOwnPicker(git);
  }));

  // ── Worktree Disk-Usage Report (F24) ────────────────────────────
  reg('gitsight.worktreeDiskUsage', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showWorktreeDiskUsage(git);
  }));

  // ── Pre-Commit Hook Bridge (F45) ────────────────────────────────
  reg('gitsight.preCommitBridge', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await runPreCommitBridge(git);
  }));

  // ── Rebase Plan Preview (F49) ───────────────────────────────────
  reg('gitsight.rebasePlanPreview', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showRebasePlanPreview(git);
  }));

  // ── Fixture-Author CodeLens (F50) ───────────────────────────────
  const fixtureLens = new FixtureLensProvider(repos);
  ctx.subscriptions.push(fixtureLens.register());

  // ── Advanced Commit Search (F51) ────────────────────────────────
  reg('gitsight.searchCommitsAdvanced', (initial?: string) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showAdvancedCommitSearch(git, ctx, initial);
  }));

  // ── Branch Staleness Pruner (F52) ───────────────────────────────
  reg('gitsight.branchStalenessPruner', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showBranchStalenessPruner(git);
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

  // ── SSH Key Sanity Check (F54) ──────────────────────────────────
  reg('gitsight.checkSshKey', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitSight: probing origin\u2026' },
      () => runStartupAuthProbe(git),
    );
  }));
  // Run the silent startup probe if the user opted in.
  setTimeout(() => { const g = primary(); if (g) void runStartupAuthProbe(g); }, 3000);

  // ── Open in GitHub Codespaces (F56) ─────────────────────────────
  reg('gitsight.openInCodespaces', (n?: any) => errorWrap(async () => {
    const git: Git = (n?.git instanceof Git ? n.git : undefined) ?? primary()!;
    if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await openInCodespaces(git, n);
  }));

  // ── Stash Diff Browser (F58) ────────────────────────────────────
  reg('gitsight.stashDiffBrowser', (n?: any) => errorWrap(async () => {
    const git: Git = (n?.git instanceof Git ? n.git : undefined) ?? primary()!;
    if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const ref: string | undefined = n?.stash?.ref ?? n?.ref;
    await showStashDiffBrowser(git, { ref });
  }));

  // ── Commit-by-Commit Test Runner (F55) ──────────────────────────
  reg('gitsight.commitTestRunner', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showCommitByCommitTestRunner(git);
  }));

  // ── Default-Reviewers Picker (F57) ──────────────────────────────
  reg('gitsight.defaultReviewersPicker', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showDefaultReviewersPicker(git);
  }));

  // ── Commit-Message Scaffold (F60) ───────────────────────────────
  const commitScaffold = new CommitScaffoldController(repos);
  ctx.subscriptions.push(commitScaffold);
  ctx.subscriptions.push(...commitScaffold.registerCommands());

  // ── rerere Cache Visualizer (F63) ───────────────────────────────
  reg('gitsight.rerereCacheVisualizer', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showRerereCacheVisualizer(git);
  }));

  // ── Worktree Pruner (F64) ───────────────────────────────────────
  reg('gitsight.worktreePruner', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showWorktreePruner(git);
  }));

  // ── Stash Trash Bin (F67) ───────────────────────────────────────
  reg('gitsight.stashTrashBin', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showStashTrashBin(git);
  }));

  // ── Reflog Explorer (F68) ───────────────────────────────────────
  reg('gitsight.reflogExplorer', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showReflogExplorer(git);
  }));

  // ── Open at Last Touched Commit (F66) ───────────────────────────
  registerOpenAtLastTouched(ctx, repos);

  // ── Force-Push Protection Guard (F71) ───────────────────────────
  reg('gitsight.forcePush', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await forcePush(git, { lease: true });
    refreshAll();
  }));
  reg('gitsight.forcePushDangerous', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await forcePush(git, { lease: false });
    refreshAll();
  }));
  reg('gitsight.checkBranchProtection', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await checkBranchProtection(git);
  }));

  // ── Commit Footer Composer (F73) ────────────────────────────────
  reg('gitsight.commitFooterComposer', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showCommitFooterComposer(git);
  }));

  // ── Issue Link Inserter (F99) ───────────────────────────────────
  reg('gitsight.insertIssueReference', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await insertIssueAtCursor(git);
  }));
  reg('gitsight.insertIssueAsMarkdownLink', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await insertIssueAsMarkdownLink(git);
  }));
  reg('gitsight.appendIssueTrailer', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await appendIssueTrailerToScm(git);
  }));

  // ── What's Mine? dashboard (F100) ───────────────────────────────
  reg('gitsight.whatsMine', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showWhatsMineDashboard(git);
  }));

  // ── CODEOWNERS validator (F102) ─────────────────────────────────
  const codeownersValidator = new CodeownersValidatorController(repos);
  ctx.subscriptions.push(codeownersValidator);
  reg('gitsight.validateCodeowners', () => errorWrap(async () => {
    await runValidateCodeowners(repos);
  }));

  // ── PR checkout pre-flight (F101) ───────────────────────────────
  reg('gitsight.prCheckoutPreflight', (arg: any) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    if (arg && typeof arg === 'object' && typeof arg.number === 'number' && typeof arg.repoSlug === 'string') {
      await runPrCheckoutPreflight(git, arg);
    } else {
      await runPrCheckoutPreflightInteractive(git);
    }
  }));

  // ── PR template lint (F103) ─────────────────────────────────────
  const prTemplateLint = new PrTemplateLintController(repos);
  ctx.subscriptions.push(prTemplateLint);
  reg('gitsight.lintPrTemplate', () => errorWrap(async () => {
    await runPrTemplateLintCommand(repos);
  }));

  // ── Open issue from selection (F104) ────────────────────────────
  reg('gitsight.openIssueFromSelection', () => errorWrap(async () => {
    await runOpenIssueFromSelection(repos);
  }));
  ctx.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new OpenIssueCodeActionProvider(repos),
      OpenIssueCodeActionProvider.metadata,
    ),
  );

  // ── Find inactive reviewers (F105) ──────────────────────────────
  reg('gitsight.findInactiveReviewers', (arg: any) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const parsed = arg && typeof arg === 'object' && typeof arg.number === 'number'
      ? { number: arg.number, repoSlug: typeof arg.repoSlug === 'string' ? arg.repoSlug : undefined }
      : undefined;
    await runFindInactiveReviewers(git, parsed);
  }));

  // ── PR Timeline Pill (F106) ─────────────────────────────────────
  const prTimelinePill = new PrTimelinePill(repos);
  ctx.subscriptions.push(prTimelinePill);
  reg('gitsight.prTimelinePill.refresh', () => errorWrap(async () => {
    await prTimelinePill.refresh();
  }));

  // ── Conflict resolution coach (F107) ────────────────────────────
  for (const d of registerConflictCoach(repos)) ctx.subscriptions.push(d);
  reg('gitsight.conflictCoach', () => errorWrap(async () => {
    await runConflictCoach(repos);
  }));

  // ── Auto-Resolve Trivial Conflicts (F113) ───────────────────────
  reg('gitsight.autoResolveTrivialConflicts', () => errorWrap(async () => {
    await runAutoResolveTrivialConflicts(repos);
  }));

  // ── GitHub Releases Companion (F74) ─────────────────────────────
  reg('gitsight.releasesCompanion', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showReleasesCompanion(git);
  }));

  // ── PR Review-Request Inbox (F75) ───────────────────────────────
  reg('gitsight.prReviewInbox', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showPrReviewInbox(git);
  }));

  // ── Staged Conflict Marker Gate (F78) ───────────────────────────
  const stagedConflict = new StagedConflictGateController(repos);
  ctx.subscriptions.push(stagedConflict);
  ctx.subscriptions.push(...stagedConflict.registerCommands());

  // ── Recent Contributors Decoration (F81) ────────────────────────
  const recentContrib = new RecentContributorsProvider(repos);
  ctx.subscriptions.push(recentContrib.register());
  ctx.subscriptions.push(...recentContrib.registerCommands());

  // ── Tag-on-Merge Prompt (F86) ───────────────────────────────────
  reg('gitsight.tagFromMerged', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showTagFromMergedPrompt(git);
  }));

  // ── PR Description from Selection (F87) ─────────────────────────
  reg('gitsight.prDescriptionFromSelection', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await generatePrDescriptionFromSelection(ctx, git);
  }));

  // ── Bisect from CI Failure (F76) ────────────────────────────────
  reg('gitsight.bisectFromCi', () => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    await showBisectFromCiFailure(git);
  }));

  // ── PR Comments Inbox (F88) ─────────────────────────────────────
  reg('gitsight.prCommentsInbox', (arg?: any) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    // Allow invocation from a PR tree-item (carries a number) or bare from
    // the command palette (prompts via gh pr view).
    const prNumber = typeof arg === 'number' ? arg
      : typeof arg?.pr?.number === 'number' ? arg.pr.number
      : typeof arg?.number === 'number' ? arg.number
      : undefined;
    await showPrCommentsInbox(git, prNumber);
  }));

  // ── PR Comment Composer (F93) ───────────────────────────────────
  reg('gitsight.composePrComment', (arg?: any) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const prNumber = typeof arg === 'number' ? arg
      : typeof arg?.pr?.number === 'number' ? arg.pr.number
      : typeof arg?.number === 'number' ? arg.number
      : undefined;
    await composeAndPostPrComment(git, prNumber);
  }));

  // ── PR Comment Thread Resolver (F108) ───────────────────────────
  reg('gitsight.resolvePrCommentThreads', (arg?: any) => errorWrap(async () => {
    const git = primary(); if (!git) return vscode.window.showWarningMessage('GitSight: no Git repo.');
    const prNumber = typeof arg === 'number' ? arg
      : typeof arg?.pr?.number === 'number' ? arg.pr.number
      : typeof arg?.number === 'number' ? arg.number
      : undefined;
    await resolvePrCommentThreads(git, prNumber);
  }));

  // ── Secret Audit Pill (F89) ─────────────────────────────────────
  const secretAudit = new SecretAuditPill(repos);
  ctx.subscriptions.push(secretAudit);
  ctx.subscriptions.push(...secretAudit.registerCommands());

  // ── Workspace Secret Audit Summary (F94) ────────────────────────
  reg('gitsight.workspaceSecretAudit', () => errorWrap(async () => {
    await showWorkspaceSecretAudit(repos);
  }));

  // ── Diff Size Heuristic (F90) ───────────────────────────────────
  const diffSize = new DiffSizeHeuristicController(repos);
  ctx.subscriptions.push(diffSize);
  ctx.subscriptions.push(...diffSize.registerCommands());

  // ── Per-File Complexity Badge (F111) ────────────────────────────
  const complexityBadge = new ComplexityBadgeProvider(repos);
  ctx.subscriptions.push(complexityBadge.register());
  ctx.subscriptions.push(...complexityBadge.registerCommands());

  // ── PR Complexity Aggregate (F114) ──────────────────────────────
  reg('gitsight.complexityBadge.showForPr', () => errorWrap(async () => {
    await showComplexityForPrCommand(repos);
  }));

  // ── DCO Signed-off-by Enforcement (F116) ────────────────────────
  const dcoSignoff = new DcoSignoffController(repos);
  ctx.subscriptions.push(dcoSignoff);
  ctx.subscriptions.push(...dcoSignoff.registerCommands());

  // ── Release-since-last-tag CHANGELOG Preview (F117) ─────────────
  reg('gitsight.releaseSinceLastTag', () => errorWrap(async () => {
    await runReleaseSinceLastTag(repos);
  }));

  // ── PR Comment AI Summary (F112) ────────────────────────────────
  reg('gitsight.summarisePrComments', (arg: any) => errorWrap(async () => {
    const git = primary();
    if (!git) return vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    const num = normaliseReviewSummaryArg(arg);
    await summarisePrComments(ctx, git, num);
  }));

  // ── GitHub Merge Queue Surface (F115) ───────────────────────────
  reg('gitsight.mergeQueueStatus', () => errorWrap(async () => {
    await runMergeQueueStatus(repos);
  }));

  // ── Branch Protection Overview (F119) ───────────────────────────
  reg('gitsight.branchProtectionOverview', () => errorWrap(async () => {
    await showBranchProtectionOverview(repos);
  }));

  // ── "What's Stale?" Dashboard (F120) ────────────────────────────
  reg('gitsight.whatsStale', () => errorWrap(async () => {
    await showWhatsStaleDashboard(repos);
  }));

  // ── Merge Queue Enqueue/Dequeue (F121) ──────────────────────────
  reg('gitsight.mergeQueueEnqueue', () => errorWrap(async () => {
    await enqueueCurrentPr(repos);
  }));
  reg('gitsight.mergeQueueDequeue', () => errorWrap(async () => {
    await dequeueCurrentPr(repos);
  }));

  // ── Test-Impact Suggester (F122) ────────────────────────────────
  reg('gitsight.testImpact', () => errorWrap(async () => {
    await showTestImpactForCurrentPr(repos);
  }));

  // ── PR Review Submitter (F123) ──────────────────────────────────
  reg('gitsight.submitPrReview', (arg: any) => errorWrap(async () => {
    await submitPrReview(repos, arg);
  }));
  reg('gitsight.submitPrReviewApprove', (arg: any) => errorWrap(async () => {
    await approvePrQuick(repos, arg);
  }));

  // ── Reviewer Load Balancer (F124) ───────────────────────────────
  reg('gitsight.reviewerLoadReport', () => errorWrap(async () => {
    await showReviewerLoadReport(repos);
  }));

  // ── Test-Impact -> PR Body (F125) ───────────────────────────────
  reg('gitsight.injectTestImpactIntoPr', () => errorWrap(async () => {
    await injectTestImpactIntoPr(repos);
  }));

  // ── Branch Protection Rule Auto-Suggester (F126) ────────────────
  reg('gitsight.suggestBranchProtection', (branch?: string) => errorWrap(async () => {
    await suggestBranchProtection(repos, typeof branch === 'string' ? branch : undefined);
  }));

  // ── Stash Patch Export (F127) ───────────────────────────────────
  reg('gitsight.exportStashPatches', () => errorWrap(async () => {
    const git = primary();
    if (!git) return vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    await exportStashPatches(git);
  }));

  // ── Stash Patch Import (F131) ───────────────────────────────────
  reg('gitsight.importStashPatch', (arg?: any) => errorWrap(async () => {
    const opts = arg && typeof arg === 'object' && typeof arg.preselectPath === 'string'
      ? { preselectPath: arg.preselectPath }
      : undefined;
    await importStashPatch(repos, opts);
  }));

  // ── Stash Patch Auto-Discovery (F133) ───────────────────────────
  const patchDiscovery = new StashPatchDiscoveryController(repos);
  ctx.subscriptions.push(patchDiscovery);
}

export function deactivate() {}
