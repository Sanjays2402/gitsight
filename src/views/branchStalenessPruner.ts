/**
 * Branch Staleness Pruner (F52) — extends the F25 branch-age decoration
 * with a batch picker that ranks local branches by age + merge-status,
 * pre-ticks the "safe to delete" set (merged into <base> AND past the
 * age threshold AND not protected), and runs `git branch -d` against
 * the confirmed selection in one shot.
 *
 * Flow:
 *   1. Pick a base ref (default: gitsight.branchPruner.defaultBase, falls
 *      back to `main`, then `master`, then a quick-pick of local branches).
 *   2. Resolve options (minAgeDays, includeUnmerged, extraProtected).
 *   3. Run `git branch --merged <base>` to collect the merged set, then
 *      reuse the existing Git.branches(true) result for age data.
 *   4. Render a multi-select QuickPick with the deleteSafe set pre-picked.
 *   5. Modal confirm; on accept, run `git branch -d <name>` per branch,
 *      collect failures, and surface them in a follow-up toast.
 *
 * Never deletes the current branch, remote-tracking refs, or anything
 * matching the protected name set / user's extraProtected config.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  buildPruneCandidates,
  summarisePrune,
  describePrune,
  formatRowDetail,
  parseMergedBranches,
  PruneCandidate,
} from '../git/branchPruner';

interface PruneItem extends vscode.QuickPickItem {
  _candidate: PruneCandidate;
}

export async function showBranchStalenessPruner(git: Git) {
  const cfg = vscode.workspace.getConfiguration('gitsight.branchPruner');
  const minAgeDays = clamp(cfg.get<number>('minAgeDays', 60) ?? 60, 1, 3650);
  const includeUnmerged = cfg.get<boolean>('includeUnmerged', false) ?? false;
  const extraProtected = (cfg.get<string[]>('protectedBranches') ?? []) as string[];
  const defaultBase = cfg.get<string>('defaultBase', 'main') ?? 'main';

  const currentBranch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const base = await resolveBase(git, defaultBase, currentBranch);
  if (!base) {
    vscode.window.showInformationMessage('GitSight: cancelled — no base branch selected.');
    return;
  }

  const allBranches = await git.branches(true);
  const mergedRaw = await safe(git, ['branch', '--merged', base]);
  const mergedSet = parseMergedBranches(mergedRaw);

  const candidates = buildPruneCandidates(
    allBranches,
    { minAgeDays, mergedInto: mergedSet, currentBranch, extraProtected, includeUnmerged },
    new Date(),
  );

  if (!candidates.length) {
    vscode.window.showInformationMessage(`GitSight: no local branches to prune against ${base}.`);
    return;
  }
  const summary = summarisePrune(candidates);

  if (summary.deleteSafe === 0 && !includeUnmerged) {
    vscode.window.showInformationMessage(
      `GitSight: nothing to prune against ${base}. ${describePrune(summary)}.`,
    );
    return;
  }

  const items: PruneItem[] = candidates.map(c => ({
    label: `${c.deleteSafe ? '$(trash) ' : '$(circle-large-outline) '}${c.branch.name}`,
    description: formatRowDetail(c),
    detail: c.branch.lastSubject ? `last: ${c.branch.lastSubject}` : undefined,
    picked: c.deleteSafe,
    _candidate: c,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Prune branches merged into ${base}`,
    placeHolder: `${describePrune(summary)} · base=${base} · minAge=${minAgeDays}d`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked.length) return;

  // Hard refuse to delete the current branch or anything protected, even if
  // the user manually tried to override the pre-tick.
  const safeToDelete = picked.filter(p => !p._candidate.protectedReason && p._candidate.branch.name !== currentBranch);
  const refused = picked.filter(p => p._candidate.protectedReason || p._candidate.branch.name === currentBranch);
  if (refused.length) {
    const names = refused.map(r => r._candidate.branch.name).join(', ');
    vscode.window.showWarningMessage(`GitSight: refusing to delete protected/current branch(es): ${names}.`);
  }
  if (!safeToDelete.length) return;

  // Confirm.
  const force = safeToDelete.some(p => !p._candidate.merged && includeUnmerged);
  const verb = force ? '`git branch -D`' : '`git branch -d`';
  const ans = await vscode.window.showWarningMessage(
    `Delete ${safeToDelete.length} branch${safeToDelete.length === 1 ? '' : 'es'} with ${verb}?` +
      (force ? '\n\nIncludes UNMERGED branches — they will be lost unless they have a reflog entry you can recover from.' : ''),
    { modal: true },
    'Delete',
  );
  if (ans !== 'Delete') return;

  const failures: { name: string; error: string }[] = [];
  const succeeded: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: pruning ${safeToDelete.length} branch${safeToDelete.length === 1 ? '' : 'es'}…` },
    async (progress) => {
      let i = 0;
      for (const p of safeToDelete) {
        progress.report({ message: p._candidate.branch.name, increment: 100 / safeToDelete.length });
        const name = p._candidate.branch.name;
        const useForce = !p._candidate.merged;
        try {
          await git.raw(['branch', useForce ? '-D' : '-d', name]);
          succeeded.push(name);
        } catch (e: any) {
          failures.push({ name, error: (e?.message ?? String(e)).toString().split('\n')[0] });
        }
        i++;
      }
    },
  );

  if (succeeded.length) {
    vscode.window.setStatusBarMessage(`GitSight: pruned ${succeeded.length} branch${succeeded.length === 1 ? '' : 'es'}.`, 4000);
  }
  if (failures.length) {
    const summary = failures.slice(0, 3).map(f => `${f.name}: ${f.error}`).join('\n');
    vscode.window.showWarningMessage(
      `GitSight: ${failures.length} branch${failures.length === 1 ? '' : 'es'} could not be deleted.\n\n${summary}` +
        (failures.length > 3 ? `\n…and ${failures.length - 3} more.` : ''),
    );
  }
  vscode.commands.executeCommand('gitsight.refresh');
}

async function resolveBase(git: Git, defaultBase: string, currentBranch: string): Promise<string | undefined> {
  // 1. Honour the configured default if it exists.
  if (defaultBase) {
    const ok = await safe(git, ['rev-parse', '--verify', defaultBase]);
    if (ok.trim()) return defaultBase;
  }
  // 2. Try common names.
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    if (candidate === defaultBase) continue;
    const ok = await safe(git, ['rev-parse', '--verify', candidate]);
    if (ok.trim()) return candidate;
  }
  // 3. Quick-pick over local branches (excluding current).
  const branches = (await safe(git, ['branch', '--format=%(refname:short)']))
    .split('\n').map(s => s.trim()).filter(b => b && b !== currentBranch);
  if (!branches.length) return undefined;
  return vscode.window.showQuickPick(branches, { placeHolder: 'Pick a base branch for pruning' });
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
