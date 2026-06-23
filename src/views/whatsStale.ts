/**
 * F120 - "What's stale?" repo dashboard.
 *
 * One command (`gitsight.whatsStale`) that composes:
 *   - F25 branchAge classification
 *   - F67 stash trash classifier
 *   - F64 worktree pruner classifier
 *
 * into a single ranked rot picker. Click a row -> jump to the right
 * cleanup command for that item kind.
 *
 * Trade-offs:
 *   - We do NOT include secret audit data here. That walk requires
 *     `gh` round-trips and would slow the picker; users with the
 *     SecretAudit pill already see that surface. (scoreSecrets in
 *     the pure module exists for future composition.)
 *   - Branch ages reuse F25 thresholds (30/90/365). We do NOT add a
 *     new threshold knob — picker is opinionated about what counts
 *     as rot.
 *   - Worktrees use the same loaders as F64 (existsOnDisk + index
 *     mtime). We inline a thin wrapper to reuse the implementation
 *     without taking a dependency on F64's view layer.
 */
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { classifyBranches } from '../git/branchAge';
import { buildStashCandidates } from '../git/stashTrash';
import { buildWorktreePruneCandidates } from '../git/worktreePruner';
import {
  scoreBranch,
  scoreStash,
  scoreWorktree,
  aggregateRot,
  summariseRot,
  formatRotHeader,
  glyphForSeverity,
  buildRotReport,
  RotItem,
  WhatsStaleSummary,
} from '../git/whatsStale';

export async function showWhatsStaleDashboard(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gitsight.whatsStale');
  const includeStaleWorktrees = cfg.get<boolean>('includeStaleWorktrees', false);

  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GitSight: scanning for rot\u2026' },
    async () => collectRot(git, { includeStaleWorktrees }),
  );

  const summary = summariseRot(items);
  await renderPicker(git, items, summary);
}

interface CollectOptions {
  includeStaleWorktrees: boolean;
}

async function collectRot(git: Git, opts: CollectOptions): Promise<RotItem[]> {
  const now = new Date();
  const [allBranches, stashes, worktrees, branchesWithUpstream] = await Promise.all([
    safeBranches(git),
    safeStashes(git),
    safeWorktrees(git),
    loadBranchesWithUpstream(git),
  ]);
  const liveBranchSet = new Set<string>(allBranches.filter(b => !b.remote).map(b => b.name));
  const currentWtPath = (await safeGitDir(git)) ?? git.cwd;

  // Branches: drop current branch + protected names from rot. The
  // branchPruner module already has the PROTECTED_NAMES list; we use
  // a smaller local guard here since rot is about cleanup not about
  // restricting deletion.
  const currentBranch = (await safeRevParseHead(git));
  const branchAges = classifyBranches(allBranches.filter(b => !b.remote), now);
  const branchItems = branchAges
    .filter(b => b.branch.name !== currentBranch)
    .map(b => scoreBranch(b));

  const stashCands = buildStashCandidates(stashes, {
    staleAfterDays: 30,
    ancientAfterDays: 180,
    liveBranches: liveBranchSet,
  }, now);
  const stashItems = stashCands.map(s => scoreStash(s));

  const wtCands = buildWorktreePruneCandidates(worktrees, {
    currentWorktreePath: currentWtPath,
    branchesWithUpstream,
    minAgeDays: 30,
    includeStaleOnly: opts.includeStaleWorktrees,
    existsOnDisk: (w) => true, // overridden below per-wt
    ageDaysFor: () => 0,        // overridden below per-wt
  });
  // The pure classifier needs accurate fs data; rerun with async lookups.
  const wtItems: (RotItem | undefined)[] = [];
  for (const w of worktrees) {
    const existsOnDisk = await dirExists(w.path);
    const ageDays = await indexAgeDays(w.path);
    const overrides = buildWorktreePruneCandidates([w], {
      currentWorktreePath: currentWtPath,
      branchesWithUpstream,
      minAgeDays: 30,
      includeStaleOnly: opts.includeStaleWorktrees,
      existsOnDisk: () => existsOnDisk,
      ageDaysFor: () => ageDays,
    });
    if (overrides[0]) wtItems.push(scoreWorktree(overrides[0]));
  }

  return aggregateRot([...branchItems, ...stashItems, ...wtItems]);
}

async function renderPicker(git: Git, items: RotItem[], summary: WhatsStaleSummary): Promise<void> {
  type Pk = vscode.QuickPickItem & { _item?: RotItem; _action?: 'open-report' | 'refresh' };
  const picks: Pk[] = [];
  picks.push({ label: formatRotHeader(summary), kind: vscode.QuickPickItemKind.Separator } as any);
  if (items.length === 0) {
    picks.push({ label: '$(check-all) Nothing to clean up. Nice work.' });
  } else {
    for (const item of items) {
      const sevGlyph = glyphForSeverity(item.severity);
      picks.push({
        label: `$(${sevGlyph}) $(${item.glyph}) ${item.label}`,
        description: item.description,
        detail: item.detail,
        _item: item,
      });
    }
  }
  picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  picks.push({ label: '$(notebook) Open full report', _action: 'open-report' });
  picks.push({ label: '$(refresh) Refresh', _action: 'refresh' });

  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: items.length ? `What's stale - ${summary.total} rot item${summary.total === 1 ? '' : 's'}` : 'What\'s stale - 0 items',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'refresh') {
    // re-enter via the command surface
    await vscode.commands.executeCommand('gitsight.whatsStale');
    return;
  }
  if (picked._action === 'open-report') {
    const doc = await vscode.workspace.openTextDocument({
      content: buildRotReport(items, summary),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    return;
  }
  if (picked._item) {
    await handleRotItem(git, picked._item);
  }
}

async function handleRotItem(_git: Git, item: RotItem): Promise<void> {
  if (item.kind === 'branch') {
    await vscode.commands.executeCommand('gitsight.branchStalenessPruner');
    return;
  }
  if (item.kind === 'stash') {
    await vscode.commands.executeCommand('gitsight.stashTrashBin');
    return;
  }
  if (item.kind === 'worktree') {
    await vscode.commands.executeCommand('gitsight.worktreePruner');
    return;
  }
  if (item.kind === 'secrets') {
    await vscode.commands.executeCommand('gitsight.workspaceSecretAudit');
    return;
  }
}

// ----------------------------------------------------------------------
// Safe loaders - mirror the pattern in branchStalenessPruner/worktreePruner.

async function safeBranches(git: Git) {
  try { return await git.branches(true); } catch { return []; }
}
async function safeStashes(git: Git) {
  try { return await git.stashes(); } catch { return []; }
}
async function safeWorktrees(git: Git) {
  try { return await git.worktrees(); } catch { return []; }
}
async function safeGitDir(git: Git): Promise<string | undefined> {
  try {
    const p = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    return p || undefined;
  } catch { return undefined; }
}
async function safeRevParseHead(git: Git): Promise<string> {
  try { return (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }
  catch { return ''; }
}

async function loadBranchesWithUpstream(git: Git): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const out = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const slash = trimmed.indexOf('/');
      if (slash > 0) set.add(trimmed.slice(slash + 1));
    }
  } catch {}
  return set;
}

async function dirExists(p: string): Promise<boolean> {
  try { const s = await fs.stat(p); return s.isDirectory(); }
  catch { return false; }
}

async function indexAgeDays(wtPath: string): Promise<number> {
  const candidates = [
    path.join(wtPath, '.git', 'index'),
    path.join(wtPath, '.git'),
    wtPath,
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
