/**
 * Worktree Disk-Usage Report (F24).
 *
 * Picks a worktree from `git worktree list`, walks its files, and
 * renders a Markdown report ("Worktree size: 1.2 GB across 4,210
 * files. node_modules: 950 MB. src: 240 KB. …") in a side editor.
 *
 * Implementation notes:
 *  - The walk uses the real `fs.promises` (production adapter below),
 *    but the pure helper accepts any FsAdapter so the unit tests
 *    feed it an in-memory tree.
 *  - We exclude `.git` by default (users want WORKING tree size) but
 *    include node_modules — that's usually the surprise everyone is
 *    chasing. A config knob (`gitsight.worktreeDu.skip`) lets the
 *    user override.
 *  - Long walks run inside a `withProgress` notification so VS Code
 *    shows the spinner. We cap entries at 250k by default to avoid
 *    locking up the extension host on a sprawling monorepo.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Git } from '../git/git';
import {
  computeDu,
  renderDuMarkdown,
  formatBytes,
  FsAdapter,
  DirEntry,
} from '../git/worktreeDu';

const realFs: FsAdapter = {
  async readdir(p: string): Promise<DirEntry[]> {
    const ents = await fs.readdir(p, { withFileTypes: true });
    return ents.map(e => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  },
  async stat(p: string) {
    const s = await fs.lstat(p);
    return {
      size: s.size,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink: s.isSymbolicLink(),
    };
  },
};

export async function showWorktreeDiskUsage(git: Git): Promise<void> {
  // 1. Resolve the candidate worktrees. Always include the primary.
  let worktrees: { path: string; branch?: string; head?: string }[] = [];
  try {
    worktrees = await git.worktrees();
  } catch {
    worktrees = [];
  }
  if (!worktrees.length) {
    worktrees = [{ path: git.cwd }];
  }

  // 2. Picker (auto-pick when there's only one).
  let target: string;
  if (worktrees.length === 1) {
    target = worktrees[0].path;
  } else {
    type Pk = vscode.QuickPickItem & { _path: string };
    const items: Pk[] = worktrees.map(w => ({
      label: `$(folder) ${path.basename(w.path)}`,
      description: w.branch ?? w.head?.slice(0, 7) ?? '',
      detail: w.path,
      _path: w.path,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Pick a worktree to measure',
      matchOnDetail: true,
    });
    if (!picked) return;
    target = picked._path;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.worktreeDu');
  const skip = cfg.get<string[]>('skip', ['.git']) ?? ['.git'];
  const maxEntries = clamp(cfg.get<number>('maxEntries', 250_000), 1_000, 5_000_000);
  const topLevelLimit = clamp(cfg.get<number>('topLevelLimit', 25), 5, 200);
  const largestLimit = clamp(cfg.get<number>('largestLimit', 10), 3, 100);
  const followSymlinks = cfg.get<boolean>('followSymlinks', false);

  // 3. Walk.
  const startedAt = Date.now();
  let report;
  try {
    report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `GitSight: measuring ${path.basename(target)}…`,
        cancellable: false,
      },
      async () => computeDu(target, realFs, { skipNames: skip, maxEntries, followSymlinks }, largestLimit),
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: worktree DU failed: ${e.message ?? e}`);
    return;
  }
  const elapsedMs = Date.now() - startedAt;

  // 4. Render.
  const heading = `# Worktree disk usage — \`${path.basename(target)}\`\n\n`;
  const body = renderDuMarkdown(report, { root: target, topLevelLimit, largestLimit });
  const footer = `\n\n_Measured in ${(elapsedMs / 1000).toFixed(1)}s · ${formatBytes(report.totalBytes)} total · skip = [${skip.map(s => `\`${s}\``).join(', ')}]_`;
  const md = heading + body + footer;

  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

  // 5. Toast a one-liner so the user knows the file landed.
  vscode.window.setStatusBarMessage(
    `GitSight: ${path.basename(target)} = ${formatBytes(report.totalBytes)} (${report.fileCount.toLocaleString()} files)`,
    5000,
  );
}

function clamp(v: number | undefined, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
