/**
 * Stash Trash Bin (F67) - batch picker for long-lived stashes.
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
 *   5. F127: optionally export each stash's diff to a timestamped
 *      `.patch` file BEFORE dropping (safety net for "I dropped that
 *      one I needed!").
 *   6. Drop each from the highest index DOWN so reflog renumbering doesn't
 *      shift the indices of stashes we still need to address. Collect
 *      failures and surface them in a follow-up warning.
 *
 * Configurable via:
 *   gitsight.stashTrash.staleAfterDays    (default 60)
 *   gitsight.stashTrash.ancientAfterDays  (default 180)
 *   gitsight.stashTrash.extraLiveBranches (default [])
 *   gitsight.stashTrash.exportPatchesByDefault (default false, F127)
 *   gitsight.stashTrash.patchExportDir    (default '.gitsight/stash-patches', F127)
 */
import * as vscode from 'vscode';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Git, Stash } from '../git/git';
import {
  buildStashCandidates,
  summariseStashTrash,
  describeStashTrash,
  formatStashRow,
  StashCandidate,
} from '../git/stashTrash';
import {
  buildExportPlan,
  describeExportPlan,
  summariseExportPlan,
  buildExportReport,
  validateFilename,
  PatchExportCandidate,
} from '../git/stashPatchExport';

interface PickItem extends vscode.QuickPickItem {
  _candidate: StashCandidate;
}

export async function showStashTrashBin(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.stashTrash');
  const staleAfterDays = clamp(cfg.get<number>('staleAfterDays', 60) ?? 60, 1, 3650);
  const ancientAfterDays = clamp(cfg.get<number>('ancientAfterDays', 180) ?? 180, staleAfterDays, 3650);
  const extraLiveBranches = (cfg.get<string[]>('extraLiveBranches') ?? []) as string[];
  const exportPatchesByDefault = cfg.get<boolean>('exportPatchesByDefault', false);
  const exportDirRel = (cfg.get<string>('patchExportDir', '.gitsight/stash-patches') ?? '').trim() || '.gitsight/stash-patches';

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

  // F127: build an export plan for the selected stashes and ask whether
  // to save patches to disk before dropping. Cleared from the picker
  // when the user has set exportPatchesByDefault=false (the default) -
  // in that case we'll auto-skip unless they explicitly opt-in.
  const exportPlan = buildExportPlan(sel, new Date());
  const exportSummary = summariseExportPlan(exportPlan);
  let exportDecision: 'none' | 'priority' | 'all' = 'none';
  if (exportSummary.exportPriority > 0 || exportPatchesByDefault) {
    const action = await vscode.window.showWarningMessage(
      `Export patches before dropping?`,
      {
        modal: true,
        detail:
          `Before deleting ${sel.length} stash${sel.length === 1 ? '' : 'es'}, GitSight can save each one's diff as a .patch file in \`${exportDirRel}\`.\n\n` +
          `${describeExportPlan(exportSummary)}.\n\n` +
          `Patches let you recover dropped work later with \`git apply <file.patch>\`.`,
      },
      'Save priority patches',
      'Save ALL patches',
      'Drop without saving',
    );
    if (!action) return;
    exportDecision = action === 'Drop without saving' ? 'none'
                   : action === 'Save ALL patches'   ? 'all'
                   : 'priority';
  } else {
    // Just confirm the drop without offering the export.
    const ok = await vscode.window.showWarningMessage(
      `Permanently drop ${sel.length} stash${sel.length === 1 ? '' : 'es'}? Reflog entries are deleted and cannot be recovered.`,
      { modal: true, detail: sel.slice(0, 5).map(c => `\u2022 ${c.stash.ref}  ${c.cleanSubject}`).join('\n')
        + (sel.length > 5 ? `\n\u2026and ${sel.length - 5} more.` : '') },
      'Drop',
    );
    if (ok !== 'Drop') return;
  }

  // Export patches if the user opted-in.
  const exportedFilenames: string[] = [];
  const exportFailures: { filename: string; error: string }[] = [];
  if (exportDecision !== 'none') {
    const toExport = exportDecision === 'all'
      ? exportPlan
      : exportPlan.filter(p => p.priority === 'export');
    if (toExport.length > 0) {
      const exportDirAbs = path.isAbsolute(exportDirRel)
        ? exportDirRel
        : path.join(git.cwd, exportDirRel);
      try {
        await fsPromises.mkdir(exportDirAbs, { recursive: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: could not create patch dir ${exportDirAbs}: ${e?.message ?? e}`);
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `GitSight: exporting ${toExport.length} stash patch${toExport.length === 1 ? '' : 'es'}\u2026` },
        async (progress) => {
          for (const p of toExport) {
            progress.report({ message: p.candidate.stash.ref, increment: 100 / toExport.length });
            const validationIssue = validateFilename(p.filename);
            if (validationIssue) {
              exportFailures.push({ filename: p.filename, error: `unsafe filename (${validationIssue})` });
              continue;
            }
            const target = path.join(exportDirAbs, p.filename);
            try {
              const diff = await git.raw(['stash', 'show', '-p', p.candidate.stash.ref]);
              await fsPromises.writeFile(target, diff, 'utf8');
              exportedFilenames.push(p.filename);
            } catch (e: any) {
              const first = (e?.message ?? String(e)).toString().split('\n')[0];
              exportFailures.push({ filename: p.filename, error: first });
            }
          }
        },
      );
      // Write the report alongside.
      try {
        const reportPath = path.join(exportDirAbs, `gitsight-stash-export-${formatTimestamp(new Date())}.md`);
        const report = buildExportReport({
          plan: toExport,
          exportedFilenames,
          failures: exportFailures,
          now: new Date(),
          exportDir: exportDirAbs,
        });
        await fsPromises.writeFile(reportPath, report, 'utf8');
      } catch { /* report is best-effort */ }
      if (exportedFilenames.length) {
        vscode.window.setStatusBarMessage(
          `GitSight: exported ${exportedFilenames.length} patch${exportedFilenames.length === 1 ? '' : 'es'} to ${exportDirAbs}`,
          5000,
        );
      }
    }
  }

  // Drop from highest index DOWN - git stash drop renumbers the reflog so
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
  if (exportFailures.length) {
    vscode.window.showWarningMessage(
      `GitSight: ${exportFailures.length} patch export${exportFailures.length === 1 ? '' : 's'} failed.\n\n${exportFailures.slice(0, 3).map(f => `${f.filename}: ${f.error}`).join('\n')}`,
    );
  }
  vscode.commands.executeCommand('gitsight.refresh');
}

/**
 * F127 - standalone command: export selected stash patches without
 * dropping. Useful when you just want a snapshot, e.g. before doing
 * a risky rebase.
 */
export async function exportStashPatches(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.stashTrash');
  const staleAfterDays = clamp(cfg.get<number>('staleAfterDays', 60) ?? 60, 1, 3650);
  const ancientAfterDays = clamp(cfg.get<number>('ancientAfterDays', 180) ?? 180, staleAfterDays, 3650);
  const extraLiveBranches = (cfg.get<string[]>('extraLiveBranches') ?? []) as string[];
  const exportDirRel = (cfg.get<string>('patchExportDir', '.gitsight/stash-patches') ?? '').trim() || '.gitsight/stash-patches';

  const [stashes, liveBranches] = await Promise.all([
    safeStashes(git),
    listLocalBranches(git),
  ]);
  if (!stashes.length) {
    vscode.window.showInformationMessage('GitSight: no stashes to export.');
    return;
  }
  const candidates = buildStashCandidates(
    stashes,
    { staleAfterDays, ancientAfterDays, liveBranches, extraLiveBranches },
    new Date(),
  );
  const exportPlan = buildExportPlan(candidates, new Date());

  type Pk = vscode.QuickPickItem & { _p: PatchExportCandidate };
  const items: Pk[] = exportPlan.map(p => ({
    label: `$(${p.priority === 'export' ? 'save' : 'save-as'}) ${p.candidate.cleanSubject || p.candidate.stash.ref}`,
    description: `${p.rationale} \u00b7 ${formatStashRow(p.candidate)}`,
    detail: `${p.candidate.stash.ref} \u2192 ${p.filename}`,
    picked: p.priority === 'export',
    _p: p,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'GitSight: Export Stash Patches',
    placeHolder: describeExportPlan(summariseExportPlan(exportPlan)),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || picked.length === 0) return;
  const toExport = picked.map(p => p._p);
  const exportDirAbs = path.isAbsolute(exportDirRel)
    ? exportDirRel
    : path.join(git.cwd, exportDirRel);
  try {
    await fsPromises.mkdir(exportDirAbs, { recursive: true });
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: could not create patch dir ${exportDirAbs}: ${e?.message ?? e}`);
    return;
  }
  const exported: string[] = [];
  const failed: { filename: string; error: string }[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: exporting ${toExport.length} stash patch${toExport.length === 1 ? '' : 'es'}\u2026` },
    async (progress) => {
      for (const p of toExport) {
        progress.report({ message: p.candidate.stash.ref, increment: 100 / toExport.length });
        const validationIssue = validateFilename(p.filename);
        if (validationIssue) {
          failed.push({ filename: p.filename, error: `unsafe filename (${validationIssue})` });
          continue;
        }
        const target = path.join(exportDirAbs, p.filename);
        try {
          const diff = await git.raw(['stash', 'show', '-p', p.candidate.stash.ref]);
          await fsPromises.writeFile(target, diff, 'utf8');
          exported.push(p.filename);
        } catch (e: any) {
          const first = (e?.message ?? String(e)).toString().split('\n')[0];
          failed.push({ filename: p.filename, error: first });
        }
      }
    },
  );
  if (exported.length) {
    const open = await vscode.window.showInformationMessage(
      `GitSight: exported ${exported.length} stash patch${exported.length === 1 ? '' : 'es'} to ${exportDirAbs}.`,
      'Reveal in OS', 'Open report',
    );
    if (open === 'Reveal in OS') {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(exportDirAbs));
    } else if (open === 'Open report') {
      const report = buildExportReport({
        plan: toExport, exportedFilenames: exported, failures: failed, now: new Date(), exportDir: exportDirAbs,
      });
      const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }
  }
  if (failed.length) {
    vscode.window.showWarningMessage(
      `GitSight: ${failed.length} patch export${failed.length === 1 ? '' : 's'} failed.\n\n${failed.slice(0, 3).map(f => `${f.filename}: ${f.error}`).join('\n')}`,
    );
  }
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
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
