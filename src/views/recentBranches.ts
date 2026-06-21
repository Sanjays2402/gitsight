/**
 * Recent Branches MRU — `git checkout -` superpowers via the reflog.
 *
 * Mines `git reflog` for "checkout: moving from X to Y" entries, dedupes
 * newest-first, and offers a single-keystroke picker bound to nothing by
 * default (the user can rebind to whatever they want; we avoid stealing yet
 * another modifier-key combo). Designed to be invoked from the command
 * palette + via a tree-view button on the Branches view title bar.
 *
 * The reflog window is configurable: `gitsight.recentBranches.reflogWindow`
 * (default 200) — large enough to catch the last week of work without
 * triggering `git`'s pager.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { parseCheckoutReflog, ageLabel, RecentBranchEntry } from '../git/recentBranches';

type RecentItem = vscode.QuickPickItem & { _branch?: RecentBranchEntry };

export async function showRecentBranches(git: Git) {
  const cfg = vscode.workspace.getConfiguration('gitsight.recentBranches');
  const reflogWindow = clampInt(cfg.get<number>('reflogWindow', 200), 20, 5000);
  const showLimit = clampInt(cfg.get<number>('showLimit', 10), 3, 30);

  const current = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const raw = await safe(git, [
    'reflog',
    '--date=iso-strict',
    `-n${reflogWindow}`,
    '--grep-reflog=checkout: moving from',
  ]);
  // `current` may be 'HEAD' if detached; in that case excludeCurrent does nothing useful.
  const entries = parseCheckoutReflog(raw, {
    excludeCurrent: current === 'HEAD' ? undefined : current,
    limit: showLimit,
  });

  if (!entries.length) {
    vscode.window.showInformationMessage(
      'GitSight: no recent branch switches found in the reflog (try checking out a few branches first).',
    );
    return;
  }

  // Verify each branch still exists locally — reflog remembers branches the
  // user later deleted. Filter those out rather than fail loudly at checkout.
  const live = await listLocalBranches(git);
  const liveSet = new Set(live);
  const filtered = entries.filter(e => liveSet.has(e.name));

  if (!filtered.length) {
    vscode.window.showInformationMessage(
      'GitSight: recent branches in the reflog have all been deleted locally.',
    );
    return;
  }

  const now = Date.now();
  const items: RecentItem[] = filtered.map((e, i) => ({
    label: `$(history) ${e.name}`,
    description: `${ageLabel(e.lastCheckoutIso, now)} ago${e.count > 1 ? ` — ${e.count} switches` : ''}`,
    detail: i === 0 ? 'Most recent — equivalent to `git checkout -`' : undefined,
    _branch: e,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Recent branches (currently on ${current === 'HEAD' ? 'detached HEAD' : current})`,
    matchOnDescription: true,
  });
  if (!picked?._branch) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: checkout ${picked._branch.name}` },
    async () => {
      try {
        await git.run(['checkout', picked._branch!.name]);
        vscode.window.setStatusBarMessage(`Switched to ${picked._branch!.name}`, 2500);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
      }
    },
  );
}

/**
 * `git checkout -` equivalent: jump straight to the previous branch with no
 * picker. Bound separately so power users can wire it to a single keystroke.
 * Falls back to a friendly message when the reflog is empty.
 */
export async function checkoutPreviousBranch(git: Git) {
  const current = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const raw = await safe(git, [
    'reflog',
    '--date=iso-strict',
    '-n100',
    '--grep-reflog=checkout: moving from',
  ]);
  const entries = parseCheckoutReflog(raw, {
    excludeCurrent: current === 'HEAD' ? undefined : current,
    limit: 1,
  });
  if (!entries.length) {
    vscode.window.showInformationMessage('GitSight: no previous branch in the reflog yet.');
    return;
  }
  const target = entries[0].name;
  const live = await listLocalBranches(git);
  if (!live.includes(target)) {
    vscode.window.showWarningMessage(`GitSight: previous branch "${target}" no longer exists locally.`);
    return;
  }
  try {
    await git.run(['checkout', target]);
    vscode.window.setStatusBarMessage(`Switched to ${target}`, 2500);
    vscode.commands.executeCommand('gitsight.refresh');
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

async function listLocalBranches(git: Git): Promise<string[]> {
  const out = await safe(git, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
