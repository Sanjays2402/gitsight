/**
 * Branch Cleanup — interactive multi-select picker for deleting merged local
 * branches in batch. Defaults to comparing against the repo's default branch
 * (`main` / `master` / `trunk` / current upstream of HEAD, whichever exists
 * first), but the user can pick any base.
 *
 * The picker pre-selects branches that are fully merged into the base and that
 * aren't protected names (main/master/trunk/etc.). Unmerged branches show up
 * for visibility but require `--force` to delete and are clearly labelled.
 *
 * The actual git work lives in `Git.deleteBranch`; the pure classifier lives in
 * src/git/branchCleanup.ts so it can be unit-tested.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import {
  parseMergedBranches,
  classifyCleanupCandidates,
  CleanupCandidate,
} from '../git/branchCleanup';

const DEFAULT_BASE_CANDIDATES = ['main', 'master', 'trunk'];

export async function showBranchCleanup(git: Git): Promise<void> {
  const allBranches = await git.branches(true);
  if (!allBranches.length) {
    vscode.window.showInformationMessage('GitSight: no branches found.');
    return;
  }
  const localNames = new Set(allBranches.filter(b => !b.remote).map(b => b.name));
  const base = await pickBase(git, allBranches.map(b => b.name));
  if (!base) return;

  const mergedOut = await git.raw(['branch', '--merged', base]).catch(() => '');
  const mergedNames = parseMergedBranches(mergedOut);
  const currentBranch = await git.currentBranch();
  const candidates = classifyCleanupCandidates(allBranches, mergedNames, currentBranch)
    // Only show locals that exist in the local set (defensive — classifyCleanupCandidates already filters remotes).
    .filter(c => localNames.has(c.branch.name));

  if (!candidates.length) {
    vscode.window.showInformationMessage(`GitSight: no deletable branches relative to ${base}.`);
    return;
  }

  type Item = vscode.QuickPickItem & { _cand: CleanupCandidate };
  const items: Item[] = candidates.map(c => {
    const b = c.branch;
    const tags: string[] = [];
    tags.push(c.merged ? 'merged' : 'unmerged');
    if (c.protectedReason) tags.push(c.protectedReason);
    if (b.upstream) tags.push(b.upstream);
    if (b.lastDate) tags.push(timeAgo(b.lastDate));
    if (b.ahead) tags.push(`ahead ${b.ahead}`);
    if (b.behind) tags.push(`behind ${b.behind}`);
    const icon = c.protectedReason ? '$(shield)' : c.merged ? '$(check)' : '$(warning)';
    return {
      label: `${icon} ${b.name}`,
      description: tags.join('  ·  '),
      detail: b.lastSubject ? `${b.sha.slice(0, 7)}  ${b.lastSubject}` : b.sha.slice(0, 7),
      picked: c.merged && !c.protectedReason,
      _cand: c,
    };
  });

  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.canSelectMany = true;
  qp.selectedItems = items.filter(i => i.picked);
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.placeholder = `${items.filter(i => i.picked).length} merged branches pre-selected · base ${base}`;
  qp.title = 'GitSight: Branch Cleanup';
  const picks = await new Promise<readonly Item[] | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems); qp.hide(); });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!picks || picks.length === 0) return;

  const unsafe = picks.filter(p => !p._cand.merged || p._cand.protectedReason);
  let force = false;
  if (unsafe.length) {
    const which = unsafe.map(u => u._cand.branch.name).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `${unsafe.length} of the picked branches are unmerged or protected: ${which}. Delete anyway?`,
      { modal: true },
      'Force delete all',
      'Cancel',
    );
    if (choice !== 'Force delete all') return;
    force = true;
  } else {
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${picks.length} merged ${picks.length === 1 ? 'branch' : 'branches'}?`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: deleting ${picks.length} branches…` },
    async () => {
      let ok = 0, failed = 0;
      const errors: string[] = [];
      for (const p of picks) {
        try {
          await git.deleteBranch(p._cand.branch.name, force || !p._cand.merged);
          ok++;
        } catch (e: any) {
          failed++;
          errors.push(`${p._cand.branch.name}: ${e.message}`);
        }
      }
      if (failed === 0) {
        vscode.window.showInformationMessage(`GitSight: deleted ${ok} ${ok === 1 ? 'branch' : 'branches'}.`);
      } else {
        const ch = await vscode.window.showWarningMessage(
          `GitSight: deleted ${ok}, ${failed} failed.`,
          'Show errors',
        );
        if (ch === 'Show errors') {
          const doc = await vscode.workspace.openTextDocument({
            content: errors.join('\n'),
            language: 'text',
          });
          await vscode.window.showTextDocument(doc);
        }
      }
      await vscode.commands.executeCommand('gitsight.refresh');
    },
  );
}

async function pickBase(git: Git, allRefs: string[]): Promise<string | undefined> {
  const seen = new Set(allRefs);
  const seed: { label: string; description?: string; _ref?: string; _action?: 'custom' }[] = [];
  for (const name of DEFAULT_BASE_CANDIDATES) {
    if (seen.has(name)) seed.push({ label: `$(git-branch) ${name}`, description: 'local default candidate', _ref: name });
  }
  // Always offer the current branch + a custom-entry escape hatch.
  const head = await git.currentBranch().catch(() => '');
  if (head && !seed.find(s => s._ref === head)) {
    seed.push({ label: `$(star-full) ${head}`, description: 'current branch', _ref: head });
  }
  seed.push({ label: '$(edit) Pick a different ref…', _action: 'custom' });

  const picked = await vscode.window.showQuickPick(seed, {
    placeHolder: 'Pick the base branch to compare against',
  });
  if (!picked) return undefined;
  if (picked._action === 'custom') {
    return vscode.window.showQuickPick(allRefs, { placeHolder: 'Base ref' });
  }
  return picked._ref;
}
