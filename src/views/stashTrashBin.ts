/**
 * Stash Trash Bin (F67) — batch picker for long-lived stashes.
 *
 * Sister command to the Branch Staleness Pruner (F52) and Worktree Pruner
 * (F64). Same shape: classify, pre-tick the safe set, confirm with a
 * modal, run the destructive op, report failures.
 *
 * Surface flow:
 *   1. Read `git stash list` + the live branch set.
 *   2. Build candidates via `buildStashCandidates`.
 *   3. Show a multi-select QuickPick with `dropSafe` rows pre-ticked.
 *   4. Modal confirm (count + "this cannot be undone").
 *   5. Drop each from the highest index DOWN so reflog renumbering doesn't
 *      shift the indices of stashes we still need to address. Collect
 *      failures and surface them in a follow-up warning.
 *
 * Configurable via:
 *   gitsight.stashTrash.staleAfterDays    (default 60)
 *   gitsight.stashTrash.ancientAfterDays  (default 180)
 *   gitsight.stashTrash.extraLiveBranches (default [])
 */
import * as vscode from 'vscode';
import { Git, Stash } from '../git/git';
import {
  buildStashCandidates,
  summariseStashTrash,
  describeStashTrash,
  formatStashRow,
  StashCandidate,
} from '../git/stashTrash';

interface PickItem extends vscode.QuickPickItem {
  _candidate: StashCandidate;
}

export async function showStashTrashBin(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.stashTrash');
  const staleAfterDays = clamp(cfg.get<number>('staleAfterDays', 60) ?? 60, 1, 3650);
  const ancientAfterDays = clamp(cfg.get<number>('ancientAfterDays', 180) ?? 180, staleAfterDays, 3650);
  const extraLiveBranches = (cfg.get<string[]>('extraLiveBranches') ?? []) as string[];

  const [stashes, liveBranches] = await Promise.all([
    safeStashes(git),
    listLocalBranches(git),
  ]);
  if (!stashes.length) {
    vscode.window.showInformationMessage('GitSight: no stashes to clean up.');
    return;
  }

  const candidates = buildStashCandidates(
    stashes,
    { staleAfterDays, ancientAfterDays, liveBranches, extraLiveBranches },
    new Date(),
  );
  const summary = summariseStashTrash(candidates);

  if (summary.dropSafe === 0) {
    vscode.window.showInformationMessage(
      `GitSight: nothing to clean up. ${describeStashTrash(summary)}.`,
    );
    return;
  }

  const items: PickItem[] = candidates.map(c => ({
    label: `${c.dropSafe ? '$(trash) ' : '$(circle-large-outline) '}${c.cleanSubject || c.stash.ref}`,
    description: formatStashRow(c),
    detail: `${c.stash.ref}${c.named ? '  \u00b7  named' : ''}`,
    picked: c.dropSafe,
    _candidate: c,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'GitSight: Stash Trash Bin',
    placeHolder: `${describeStashTrash(summary)} \u00b7 stale=${staleAfterDays}d \u00b7 ancient=${ancientAfterDays}d`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked.length) return;

  const sel = picked.map(p => p._candidate);
  const ok = await vscode.window.showWarningMessage(
    `Permanently drop ${sel.length} stash${sel.length === 1 ? '' : 'es'}? Reflog entries are deleted and cannot be recovered.`,
    { modal: true, detail: sel.slice(0, 5).map(c => `\u2022 ${c.stash.ref}  ${c.cleanSubject}`).join('\n')
      + (sel.length > 5 ? `\n\u2026and ${sel.length - 5} more.` : '') },
    'Drop',
  );
  if (ok !== 'Drop') return;

  // Drop from highest index DOWN — git stash drop renumbers the reflog so
  // dropping {2} before {5} shifts {5} to {4} and we'd hit the wrong stash.
  const ordered = [...sel].sort((a, b) => b.stash.index - a.stash.index);
  const failures: { ref: string; error: string }[] = [];
  const succeeded: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: dropping ${sel.length} stash${sel.length === 1 ? '' : 'es'}\u2026` },
    async (progress) => {
      for (const c of ordered) {
        progress.report({ message: c.stash.ref, increment: 100 / ordered.length });
        try {
          await git.stashDrop(c.stash.ref);
          succeeded.push(c.stash.ref);
        } catch (e: any) {
          failures.push({ ref: c.stash.ref, error: (e?.message ?? String(e)).toString().split('\n')[0] });
        }
      }
    },
  );

  if (succeeded.length) {
    vscode.window.setStatusBarMessage(
      `GitSight: dropped ${succeeded.length} stash${succeeded.length === 1 ? '' : 'es'}.`,
      4000,
    );
  }
  if (failures.length) {
    const head = failures.slice(0, 3).map(f => `${f.ref}: ${f.error}`).join('\n');
    vscode.window.showWarningMessage(
      `GitSight: ${failures.length} stash${failures.length === 1 ? '' : 'es'} could not be dropped.\n\n${head}` +
        (failures.length > 3 ? `\n\u2026and ${failures.length - 3} more.` : ''),
    );
  }
  vscode.commands.executeCommand('gitsight.refresh');
}

async function safeStashes(git: Git): Promise<Stash[]> {
  try { return await git.stashes(); } catch { return []; }
}

async function listLocalBranches(git: Git): Promise<Set<string>> {
  try {
    const out = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
