/**
 * F106 — PR ready-for-review timeline status-bar pill.
 *
 * For the current branch's open PR, surface a one-glance pill:
 *
 *   $(pass-filled) #42 ready to merge
 *   $(sync)        #42 +3 since review
 *   $(eye)         #42 waiting on 2
 *   $(warning)     #42 conflicts
 *   $(request-changes) #42 changes requested
 *   $(circle-outline) #42 draft
 *
 * Click opens an action picker:
 *   - Open PR in browser
 *   - Find inactive reviewers (chains into F105 when applicable)
 *   - View commits since last review (mini-picker of the new SHAs)
 *   - PR comments inbox (F88)
 *   - Refresh now
 *
 * Constraints:
 *   - Only activates when the repo has a github.com origin AND there's
 *     an open PR for the current branch. Hides silently otherwise.
 *   - Refreshes on RepoManager.onDidChange (debounced 2s) AND a 60s
 *     timer. Same cadence as F62 actionsPill.
 *   - Skips silently when gh CLI is missing — matches every other
 *     gh-dependent surface in the codebase.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  parsePrTimeline,
  summariseTimeline,
  glyphForPillState,
  describeTimeline,
  commitsSinceLastReview,
  PrTimeline,
  TimelineSummary,
} from '../git/prTimeline';

const pexec = promisify(execFile);

export class PrTimelinePill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private refreshDebounce?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private cmdId = 'gitsight.prTimelinePill.menu';
  private latest: { timeline?: PrTimeline; summary?: TimelineSummary; url?: string; repo?: string } = {};

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 86);
    this.item.command = this.cmdId;
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(this.cmdId, () => this.showMenu()),
      repos.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.prTimelinePill')) this.scheduleRefresh();
      }),
    );
    const sec = readRefreshSeconds();
    this.timer = setInterval(() => this.refresh().catch(() => {}), sec * 1000);
    queueMicrotask(() => this.refresh().catch(() => {}));
  }

  private scheduleRefresh() {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => this.refresh().catch(() => {}), 2000);
  }

  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.prTimelinePill');
    if (!cfg.get<boolean>('enabled', true)) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    if (!(await isGithubRepo(git))) { this.item.hide(); return; }
    if (!(await ghAvailable())) { this.item.hide(); return; }

    const branch = await safeBranch(git);
    if (!branch || branch === 'HEAD') { this.item.hide(); return; }

    const timeline = await loadCurrentBranchTimeline(git);
    if (!timeline || timeline.state !== 'OPEN') {
      // No open PR for this branch. Hide silently — F62 actionsPill,
      // F88 prCommentsInbox etc. still handle their own niches.
      this.item.hide();
      this.latest = {};
      return;
    }

    const summary = summariseTimeline(timeline);
    if (summary.state === 'ready' && cfg.get<boolean>('hideWhenReady', false)) {
      this.item.hide();
      this.latest = { timeline, summary, repo: git.cwd };
      return;
    }

    this.item.text = `$(${glyphForPillState(summary.state)}) ${summary.pillLabel}`;
    this.item.backgroundColor = pillBackgroundFor(summary.state);
    const tip = new vscode.MarkdownString(describeTimeline(timeline, summary));
    tip.isTrusted = true;
    this.item.tooltip = tip;
    const url = await prUrl(git, timeline.number);
    this.latest = { timeline, summary, url, repo: git.cwd };
    this.item.show();
  }

  private async showMenu(): Promise<void> {
    const { timeline, summary, url, repo } = this.latest;
    if (!timeline || !summary) {
      vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
      return;
    }
    type Pk = vscode.QuickPickItem & { _action: 'open' | 'inactive' | 'commits' | 'comments' | 'complexity' | 'refresh' };
    const items: Pk[] = [];
    items.push({
      label: `PR #${timeline.number}  -  ${summary.pillLabel.replace(/^#\d+\s*/, '')}`,
      kind: vscode.QuickPickItemKind.Separator,
    } as any);
    if (url) items.push({ label: '$(globe) Open in browser', description: url, _action: 'open' });
    if (summary.counts.pendingReviewers > 0) {
      items.push({
        label: '$(megaphone) Find inactive reviewers',
        description: `${summary.counts.pendingReviewers} pending`,
        _action: 'inactive',
      });
    }
    if (summary.counts.commitsSinceLastReview > 0) {
      items.push({
        label: '$(history) View commits since last review',
        description: `${summary.counts.commitsSinceLastReview} new`,
        _action: 'commits',
      });
    }
    items.push({ label: '$(comment-discussion) Open PR comments inbox', _action: 'comments' });
    items.push({ label: '$(graph) PR complexity breakdown', _action: 'complexity' });
    items.push({ label: '$(sync) Refresh now', _action: 'refresh' });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `PR #${timeline.number} on ${timeline.baseRefName || 'unknown base'}`,
      matchOnDescription: true,
    });
    if (!picked || !picked._action) return;

    switch (picked._action) {
      case 'open':
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      case 'inactive':
        await vscode.commands.executeCommand('gitsight.findInactiveReviewers', { number: timeline.number });
        return;
      case 'commits':
        await this.showCommitsSinceReviewPicker(timeline, repo!);
        return;
      case 'comments':
        await vscode.commands.executeCommand('gitsight.prCommentsInbox', { number: timeline.number });
        return;
      case 'complexity':
        await vscode.commands.executeCommand('gitsight.complexityBadge.showForPr');
        return;
      case 'refresh':
        await this.refresh();
        return;
    }
  }

  private async showCommitsSinceReviewPicker(timeline: PrTimeline, repoCwd: string): Promise<void> {
    const commits = commitsSinceLastReview(timeline);
    if (!commits.length) {
      vscode.window.showInformationMessage('GitSight: no commits since last review.');
      return;
    }
    type Pk = vscode.QuickPickItem & { _sha: string };
    const items: Pk[] = commits.map(c => ({
      label: `$(git-commit) ${c.oid.slice(0, 7)}  -  ${c.messageHeadline || '(no subject)'}`,
      description: c.authoredDate,
      _sha: c.oid,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${commits.length} commits since the last review`,
    });
    if (!picked) return;
    // Show commit detail via the existing command (F13 carry-over scratch buffer).
    try {
      await vscode.commands.executeCommand('gitsight.showCommitDetail', picked._sha);
    } catch {
      await vscode.env.clipboard.writeText(picked._sha);
      vscode.window.setStatusBarMessage(`Copied ${picked._sha.slice(0, 7)}`, 2000);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.disposables.forEach(d => d.dispose());
  }
}

function pillBackgroundFor(state: ReturnType<typeof summariseTimeline>['state']): vscode.ThemeColor | undefined {
  if (state === 'conflicts' || state === 'changes-requested') {
    return new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  if (state === 'commits-since-review' || state === 'review-needed') {
    return new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  return undefined;
}

function readRefreshSeconds(): number {
  const cfg = vscode.workspace.getConfiguration('gitsight.prTimelinePill');
  const v = cfg.get<number>('refreshSeconds', 60) ?? 60;
  return Math.max(15, Math.min(600, v));
}

async function isGithubRepo(git: Git): Promise<boolean> {
  const url = (await safe(git, ['config', '--get', 'remote.origin.url'])).trim();
  return !!url && /github\.com[:/]/.test(url);
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return (await git.raw(args)) ?? ''; } catch { return ''; }
}

async function safeBranch(git: Git): Promise<string> {
  try { return (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }
  catch { return ''; }
}

async function loadCurrentBranchTimeline(git: Git): Promise<PrTimeline | undefined> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view',
      '--json', 'number,state,isDraft,mergeable,reviewDecision,reviewRequests,reviews,commits,comments,baseRefName,updatedAt,url',
    ], { cwd: git.cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    return parsePrTimeline(stdout);
  } catch {
    return undefined;
  }
}

async function prUrl(git: Git, number: number): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', String(number), '--json', 'url'], {
      cwd: git.cwd, timeout: 5000, maxBuffer: 1024 * 1024,
    });
    const obj = JSON.parse(stdout);
    return typeof obj?.url === 'string' && obj.url ? obj.url : undefined;
  } catch {
    return undefined;
  }
}
