/**
 * Worktree Pruner (F64) — multi-select picker that batch-removes worktrees
 * that are (a) missing on disk OR (b) on a branch whose upstream was
 * deleted OR (c) past the staleness threshold (opt-in). Mirrors the
 * Branch Staleness Pruner (F52) but for worktrees instead of branches.
 *
 * Flow:
 *   1. Load worktrees via `git worktree list --porcelain`.
 *   2. Probe disk existence + per-worktree last-touch age (mtime of the
 *      worktree's index file or its directory).
 *   3. Discover branches that still have an upstream by intersecting
 *      `branches(true)` with the set of refs/remotes/* names.
 *   4. Build candidates via the pure classifier.
 *   5. Multi-select picker, pre-tick the pruneSafe rows; modal confirm.
 *   6. Group commands: one `git worktree prune` for the missing batch,
 *      then per-entry `git worktree remove [--force]` for the rest.
 *
 * Configurable via:
 *   gitsight.worktreePruner.minAgeDays         (default 30)
 *   gitsight.worktreePruner.includeStaleOnly   (default false)
 *   gitsight.worktreePruner.forceDirty         (default false) — when ON,
 *                                                allow `--force` on dirty
 *                                                worktrees without an
 *                                                extra modal confirm.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Git, Worktree } from '../git/git';
import {
  buildWorktreePruneCandidates,
  summariseWorktreePrune,
  describeWorktreePrune,
  formatRowDetail,
  buildRemoveCommand,
  WorktreePruneCandidate,
} from '../git/worktreePruner';

type Pk = vscode.QuickPickItem & { _candidate: WorktreePruneCandidate };

export async function showWorktreePruner(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.worktreePruner');
  const minAgeDays = clamp(cfg.get<number>('minAgeDays', 30) ?? 30, 1, 3650);
  const includeStaleOnly = cfg.get<boolean>('includeStaleOnly', false) ?? false;
  const forceDirty = cfg.get<boolean>('forceDirty', false) ?? false;

  const worktrees = await git.worktrees();
  if (worktrees.length <= 1) {
    vscode.window.showInformationMessage(
      'GitSight: this repo only has one worktree \u2014 nothing to prune.',
    );
    return;
  }

  // Need: current worktree path (= git.cwd resolves to the root of THIS
  // workspace's worktree), branches-with-upstream set, age per worktree,
  // and on-disk existence per worktree.
  const currentPath = git.cwd;
  const branchesWithUpstream = await loadBranchesWithUpstream(git);
  const ageMap = new Map<string, number>();
  const diskMap = new Map<string, boolean>();
  await Promise.all(worktrees.map(async w => {
    diskMap.set(w.path, await dirExists(w.path));
    ageMap.set(w.path, await ageDaysFor(w.path));
  }));

  // First entry in `git worktree list --porcelain` is the "main" worktree.
  const mainPath = worktrees[0]?.path;

  const candidates = buildWorktreePruneCandidates(worktrees, {
    currentWorktreePath: currentPath,
    branchesWithUpstream,
    minAgeDays,
    includeStaleOnly,
    isMain: w => w.path === mainPath,
    existsOnDisk: w => diskMap.get(w.path) ?? false,
    ageDaysFor: w => ageMap.get(w.path) ?? Infinity,
  });

  const summary = summariseWorktreePrune(candidates);
  if (summary.pruneSafe === 0) {
    const enableHint = !includeStaleOnly && summary.staleOnly === 0
      ? ''
      : '\nTip: enable `gitsight.worktreePruner.includeStaleOnly` to include stale-but-alive worktrees.';
    vscode.window.showInformationMessage(
      `GitSight: ${describeWorktreePrune(summary)}. Nothing to prune.${enableHint}`,
    );
    return;
  }

  const items: Pk[] = candidates.map(c => ({
    label: `${c.pruneSafe ? '$(trash) ' : '$(circle-large-outline) '}${c.worktree.path}`,
    description: formatRowDetail(c),
    detail: c.worktree.head ? `HEAD ${c.worktree.head.slice(0, 7)}` : undefined,
    picked: c.pruneSafe,
    _candidate: c,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Prune Worktrees',
    placeHolder: `${describeWorktreePrune(summary)} \u00b7 minAge=${minAgeDays}d`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked.length) return;

  // Hard refuse protected entries the user manually un-blocked.
  const refused = picked.filter(p => p._candidate.protectedReason);
  if (refused.length) {
    vscode.window.showWarningMessage(
      `GitSight: refusing to remove protected worktree(s): ${refused.map(r => r._candidate.worktree.path).join(', ')}.`,
    );
  }
  const ok = picked.filter(p => !p._candidate.protectedReason && p._candidate.reasons.length > 0);
  if (!ok.length) return;

  // Build the action plan.
  const missing = ok.filter(p => !p._candidate.existsOnDisk);
  const present = ok.filter(p => p._candidate.existsOnDisk);

  // Detect dirty trees among the present entries (best-effort: status --porcelain in each).
  const dirty: WorktreePruneCandidate[] = [];
  await Promise.all(present.map(async p => {
    if (await isDirtyWorktree(p._candidate.worktree.path)) dirty.push(p._candidate);
  }));

  if (dirty.length && !forceDirty) {
    const ans = await vscode.window.showWarningMessage(
      `${dirty.length} selected worktree${dirty.length === 1 ? ' has' : 's have'} uncommitted changes:\n\n${dirty.map(d => '  \u2022 ' + d.worktree.path).join('\n')}\n\nProceed with --force? Local changes will be lost.`,
      { modal: true },
      'Force remove dirty',
      'Skip dirty',
    );
    if (ans === undefined) return;
    if (ans === 'Skip dirty') {
      const dirtyPaths = new Set(dirty.map(d => d.worktree.path));
      const filtered = present.filter(p => !dirtyPaths.has(p._candidate.worktree.path));
      present.length = 0;
      present.push(...filtered);
    }
  }

  // Confirm.
  const totalToRemove = present.length + (missing.length ? 1 : 0);
  if (totalToRemove === 0) {
    vscode.window.showInformationMessage('GitSight: nothing to remove after dirty-tree skip.');
    return;
  }
  const ans = await vscode.window.showWarningMessage(
    `Remove ${present.length} worktree${present.length === 1 ? '' : 's'}` +
      (missing.length ? ` and prune ${missing.length} stale metadata entry/ies` : '') +
      '?',
    { modal: true },
    'Remove',
  );
  if (ans !== 'Remove') return;

  const successes: string[] = [];
  const failures: { path: string; error: string }[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: pruning ${present.length}${missing.length ? ' + prune' : ''} worktree${present.length === 1 ? '' : 's'}\u2026`,
    },
    async (progress) => {
      // Per-entry remove first.
      const step = present.length + (missing.length ? 1 : 0);
      for (const p of present) {
        progress.report({ message: p._candidate.worktree.path, increment: 100 / step });
        const isDirty = dirty.some(d => d.worktree.path === p._candidate.worktree.path);
        const args = buildRemoveCommand(p._candidate);
        if (isDirty || forceDirty) args.splice(2, 0, '--force');
        try {
          await git.raw(args);
          successes.push(p._candidate.worktree.path);
        } catch (e: any) {
          failures.push({
            path: p._candidate.worktree.path,
            error: (e?.message ?? String(e)).toString().split('\n')[0],
          });
        }
      }
      // Then one prune pass for the missing batch.
      if (missing.length) {
        progress.report({ message: 'git worktree prune', increment: 100 / step });
        try {
          await git.raw(['worktree', 'prune']);
          for (const m of missing) successes.push(m._candidate.worktree.path);
        } catch (e: any) {
          failures.push({
            path: 'git worktree prune',
            error: (e?.message ?? String(e)).toString().split('\n')[0],
          });
        }
      }
    },
  );

  if (successes.length) {
    vscode.window.setStatusBarMessage(
      `GitSight: pruned ${successes.length} worktree${successes.length === 1 ? '' : 's'}.`,
      4000,
    );
  }
  if (failures.length) {
    const head = failures.slice(0, 3).map(f => `${f.path}: ${f.error}`).join('\n');
    const tail = failures.length > 3 ? `\n\u2026and ${failures.length - 3} more.` : '';
    vscode.window.showWarningMessage(
      `GitSight: ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} could not be removed.\n\n${head}${tail}`,
    );
  }
  vscode.commands.executeCommand('gitsight.refresh');
}

async function loadBranchesWithUpstream(git: Git): Promise<Set<string>> {
  // Robust definition: a local branch has an "upstream" when there's a
  // refs/remotes/<remote>/<name> ref matching it. We don't rely on
  // `branch.upstream` from the local config alone — a fresh clone without
  // tracking config still has the remote ref.
  const set = new Set<string>();
  try {
    const out = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Drop the remote prefix (typically `origin/`).
      const slash = trimmed.indexOf('/');
      if (slash > 0) set.add(trimmed.slice(slash + 1));
    }
  } catch {}
  return set;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function ageDaysFor(worktreePath: string): Promise<number> {
  // Prefer the index mtime — it's bumped on every `git add`/checkout. Fall
  // back to the directory mtime when the index is absent (rare, e.g.
  // detached worktree without staged content).
  const candidates = [
    path.join(worktreePath, '.git', 'index'),
    path.join(worktreePath, '.git'), // for non-linked worktrees
    worktreePath,
  ];
  for (const c of candidates) {
    try {
      const s = await fs.stat(c);
      const age = (Date.now() - s.mtimeMs) / (1000 * 60 * 60 * 24);
      return Math.max(0, Math.floor(age));
    } catch {}
  }
  return Infinity;
}

async function isDirtyWorktree(p: string): Promise<boolean> {
  try {
    const localGit = new Git(p);
    const out = await localGit.raw(['status', '--porcelain=v1']);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
