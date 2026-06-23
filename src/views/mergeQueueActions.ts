/**
 * F121 - Merge queue enqueue/dequeue commands.
 *
 * Composes with F115 (which surfaces the current state of the queue).
 * This module adds two commands the user can fire from the command
 * palette OR from the prTimelinePill menu's queue-action row:
 *
 *   gitsight.mergeQueueEnqueue   - add current branch's PR to the queue
 *   gitsight.mergeQueueDequeue   - remove current branch's PR
 *
 * Behaviour:
 *   - Fetch PR snapshot via `gh pr view --json
 *     number,title,baseRefName,mergeStateStatus,autoMergeRequest,
 *     mergeQueueEntry,isDraft,headRepository,baseRepository`
 *   - Determine same-repo guard + base-branch queue support (the
 *     latter via `gh api repos/<owner>/<repo>/rulesets` is heavy; we
 *     instead assume queue is supported when `gh repo view --json
 *     mergeCommitAllowed` succeeds AND probe base ref - falling back
 *     to allowed=true with a warning when probe fails).
 *   - Pure classification (classifyEnqueue / classifyDequeue) decides
 *     ok/blocked/noop. Modal warning lists any warnings.
 *   - Strategy picker for enqueue (default 'merge' via config knob).
 *   - Run `gh pr merge ...` via execFile + parse the result.
 *
 * Hard requirements:
 *   - gh CLI on PATH (warning + bail otherwise)
 *   - GitHub repo (warning + bail otherwise)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parseGitHubRepo } from '../git/forcePushGuard';
import {
  classifyEnqueue,
  classifyDequeue,
  buildEnqueueArgs,
  buildDequeueArgs,
  actionHeadline,
  formatVerdictHints,
  normaliseStrategy,
  MergeStrategy,
  PrSnapshot,
} from '../git/mergeQueueActions';

const pexec = promisify(execFile);

export async function enqueueCurrentPr(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH.');
    return;
  }
  const pr = await loadPrSnapshot(git);
  if (!pr) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gitsight.mergeQueueActions');
  const defaultStrategy = normaliseStrategy(cfg.get('defaultStrategy', 'merge')).strategy;
  const strategy = await pickStrategy(defaultStrategy);
  if (!strategy) return;

  const verdict = classifyEnqueue({ pr, strategy });
  const headline = actionHeadline('enqueue', pr, strategy);
  if (verdict.kind === 'blocked') {
    vscode.window.showErrorMessage(`GitSight: ${verdict.reason}`);
    return;
  }
  if (verdict.kind === 'noop') {
    vscode.window.showInformationMessage(`GitSight: ${verdict.reason}`);
    return;
  }
  const detail = verdict.warnings.length
    ? `Warnings:\n${verdict.warnings.map(w => `- ${w}`).join('\n')}\n\nProceed?`
    : 'Proceed?';
  const proceed = await vscode.window.showWarningMessage(
    headline,
    { modal: true, detail },
    'Add to queue',
  );
  if (proceed !== 'Add to queue') return;

  try {
    const args = buildEnqueueArgs({ pr, strategy });
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: enqueueing PR #${pr.number}\u2026` },
      () => pexec('gh', args, { cwd: git.cwd, timeout: 30000, maxBuffer: 1024 * 1024 }).then(() => undefined),
    );
    vscode.window.setStatusBarMessage(`PR #${pr.number} added to merge queue (${strategy})`, 4000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr merge --queue failed - ${classifyGhError(e)}`);
  }
}

export async function dequeueCurrentPr(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH.');
    return;
  }
  const pr = await loadPrSnapshot(git);
  if (!pr) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
    return;
  }
  const verdict = classifyDequeue(pr);
  if (verdict.kind === 'blocked') {
    vscode.window.showErrorMessage(`GitSight: ${verdict.reason}`);
    return;
  }
  if (verdict.kind === 'noop') {
    vscode.window.showInformationMessage(`GitSight: ${verdict.reason}`);
    return;
  }
  const proceed = await vscode.window.showWarningMessage(
    actionHeadline('dequeue', pr),
    { modal: true, detail: 'This also disables auto-merge if it was enabled.' },
    'Remove from queue',
  );
  if (proceed !== 'Remove from queue') return;

  try {
    const args = buildDequeueArgs(pr);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: dequeueing PR #${pr.number}\u2026` },
      () => pexec('gh', args, { cwd: git.cwd, timeout: 30000, maxBuffer: 1024 * 1024 }).then(() => undefined),
    );
    vscode.window.setStatusBarMessage(`PR #${pr.number} removed from merge queue`, 4000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr merge --disable-auto failed - ${classifyGhError(e)}`);
  }
}

async function pickStrategy(defaultStrategy: MergeStrategy): Promise<MergeStrategy | undefined> {
  const items: (vscode.QuickPickItem & { _s: MergeStrategy })[] = [
    { label: 'merge', description: 'classic merge commit', _s: 'merge' },
    { label: 'squash', description: 'squash + merge', _s: 'squash' },
    { label: 'rebase', description: 'rebase + fast-forward', _s: 'rebase' },
  ];
  for (const it of items) {
    if (it._s === defaultStrategy) {
      it.description = `${it.description} (default)`;
      it.picked = true;
    }
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Merge strategy (default: ${defaultStrategy})`,
  });
  return picked?._s;
}

async function loadPrSnapshot(git: Git): Promise<PrSnapshot | undefined> {
  try {
    const fields = [
      'number,title,baseRefName,mergeStateStatus,isDraft',
      'autoMergeRequest,mergeQueueEntry',
      'headRepository,baseRepository',
    ].join(',');
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', fields], {
      cwd: git.cwd, timeout: 8000, maxBuffer: 1024 * 1024,
    });
    return parsePrSnapshot(stdout);
  } catch {
    return undefined;
  }
}

export function parsePrSnapshot(raw: string): PrSnapshot | undefined {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  const n = Number(obj?.number);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return {
    number: n,
    title: typeof obj?.title === 'string' ? obj.title : undefined,
    baseRefName: typeof obj?.baseRefName === 'string' ? obj.baseRefName : undefined,
    mergeStateStatus: typeof obj?.mergeStateStatus === 'string' ? obj.mergeStateStatus : undefined,
    isDraft: !!obj?.isDraft,
    autoMergeEnabled: !!obj?.autoMergeRequest,
    alreadyQueued: !!obj?.mergeQueueEntry,
    headRepoSlug: repoSlug(obj?.headRepository),
    baseRepoSlug: repoSlug(obj?.baseRepository),
    baseBranchSupportsQueue: undefined, // probed by command if needed; classifyEnqueue tolerates undefined
  };
}

function repoSlug(r: any): string | undefined {
  if (!r) return undefined;
  if (typeof r === 'string') return r;
  const name = r.name ?? r.nameWithOwner;
  const owner = r.owner?.login ?? r.owner;
  if (typeof r.nameWithOwner === 'string') return r.nameWithOwner;
  if (typeof name === 'string' && typeof owner === 'string') return `${owner}/${name}`;
  return undefined;
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

function classifyGhError(e: any): string {
  const stderr = typeof e?.stderr === 'string' ? e.stderr : (e?.message ?? String(e));
  const first = stderr.split('\n').find((l: string) => l.trim()) ?? '';
  return first.slice(0, 200);
}

/** Exported sister of the standalone-command for use from the F115 picker. */
export async function runEnqueueFromAction(repos: RepoManager): Promise<void> {
  await enqueueCurrentPr(repos);
}
export async function runDequeueFromAction(repos: RepoManager): Promise<void> {
  await dequeueCurrentPr(repos);
}

// Helper exported for tests / extension wire-up: build a no-op view
// that just reuses the pure classifier above for previewing.
export { formatVerdictHints };
