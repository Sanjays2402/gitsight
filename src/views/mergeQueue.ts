/**
 * F115 - GitHub merge-queue surface.
 *
 * Sister to F106 prTimelinePill. When the current branch has an open PR
 * AND the repo has merge queue enabled AND the PR is in the queue, show
 * a compact label inside the prTimelinePill tooltip + offer a "View
 * queue position" action that pops a dedicated picker.
 *
 * A standalone command `gitsight.mergeQueueStatus` always loads the
 * current branch's PR status regardless of pill state (useful for users
 * who hide the pill).
 *
 * Hard requirements:
 *   - gh CLI on PATH (silent skip otherwise)
 *   - GitHub repo
 *
 * Resilient to gh JSON evolution: `mergeQueueEntry` returns `null` on
 * older gh; we degrade silently. Different state strings across gh
 * 2.40+ -> 2.55+ are tolerated by parseMergeQueueEntry.
 *
 * Configurable via:
 *   gitsight.mergeQueue.averageMinutesPerPr  (default 6)
 *   gitsight.mergeQueue.floorMinutes         (default 2)
 *   gitsight.mergeQueue.refreshSeconds       (default 120)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseMergeQueueEntry,
  estimateMergeMinutes,
  formatQueueLabel,
  describeQueueState,
  glyphForQueueState,
  MergeQueueEntry,
} from '../git/mergeQueue';

const pexec = promisify(execFile);

/**
 * Load the queue entry for the active branch's open PR. Returns
 * undefined when there's no usable info to show (no PR, no gh, no
 * queue entry on the PR).
 */
export async function loadMergeQueueForCurrentBranch(git: Git): Promise<MergeQueueEntry | undefined> {
  if (!(await ghAvailable())) return undefined;
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view',
      '--json', 'mergeQueueEntry,mergeStateStatus,number,url',
    ], { cwd: git.cwd, timeout: 8000, maxBuffer: 1024 * 1024 });
    return parseMergeQueueEntry(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Top-level command. Always shows a result (info toast for absence,
 * picker for presence).
 */
export async function showMergeQueueStatus(git: Git): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot check merge queue.');
    return;
  }
  const meta = await loadPrMeta(git);
  if (!meta) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
    return;
  }
  const entry = await loadMergeQueueForCurrentBranch(git);
  if (!entry || entry.state === 'none') {
    vscode.window.showInformationMessage(`GitSight: PR #${meta.number} is not in the merge queue (or the repo has no queue enabled).`);
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gitsight.mergeQueue');
  const args = {
    averageMinutesPerPr: cfg.get<number>('averageMinutesPerPr', 6),
    floorMinutes: cfg.get<number>('floorMinutes', 2),
  };

  type Pk = vscode.QuickPickItem & { _action: 'open' | 'refresh' };
  const items: Pk[] = [];
  items.push({
    label: `PR #${meta.number}  -  $(${glyphForQueueState(entry.state)}) ${formatQueueLabel(entry, args) ?? entry.state}`,
    kind: vscode.QuickPickItemKind.Separator,
  } as any);
  if (meta.url) items.push({ label: '$(globe) Open PR in browser', description: meta.url, _action: 'open' });
  items.push({ label: '$(refresh) Refresh', _action: 'refresh' });

  const md = describeQueueState(entry, args);
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: stripMarkdown(md.split('\n')[0]),
    matchOnDescription: true,
  });
  if (!picked) return;
  if (picked._action === 'open' && meta.url) {
    await vscode.env.openExternal(vscode.Uri.parse(meta.url));
  } else if (picked._action === 'refresh') {
    await showMergeQueueStatus(git);
  }
}

interface PrMeta { number: number; url?: string; }

async function loadPrMeta(git: Git): Promise<PrMeta | undefined> {
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'number,url'], {
      cwd: git.cwd, timeout: 5000, maxBuffer: 256 * 1024,
    });
    const obj = JSON.parse(stdout);
    const n = Number(obj?.number);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return { number: n, url: typeof obj?.url === 'string' ? obj.url : undefined };
  } catch {
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, '').replace(/^\s*-\s*/, '').trim();
}

/**
 * Helper for the prTimelinePill: load the queue entry and return a
 * pill-suitable label + markdown row. Returns undefined when there's
 * nothing to compose. Cheap enough to call on every refresh tick.
 */
export async function loadPillData(git: Git): Promise<{ label?: string; markdown: string } | undefined> {
  const entry = await loadMergeQueueForCurrentBranch(git);
  if (!entry || entry.state === 'none') return undefined;
  const cfg = vscode.workspace.getConfiguration('gitsight.mergeQueue');
  const args = {
    averageMinutesPerPr: cfg.get<number>('averageMinutesPerPr', 6),
    floorMinutes: cfg.get<number>('floorMinutes', 2),
  };
  return {
    label: formatQueueLabel(entry, args),
    markdown: describeQueueState(entry, args),
  };
}

/**
 * Command-registration wrapper that primarily uses the RepoManager's
 * primary repo. Matches the helper signatures used by F114 et al.
 */
export async function runMergeQueueStatus(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  await showMergeQueueStatus(git);
}
