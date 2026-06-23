/**
 * F114 - PR Complexity Aggregate view.
 *
 * Compose F111 complexity badges across the current branch's open PR.
 * Two surfaces:
 *
 *   1. `gitsight.complexityBadge.showForPr` command — full picker over
 *      the PR's changed files with per-file bucket + jump-to-file.
 *   2. `compileForPrTooltip(git)` helper — returns a markdown body the
 *      PrTimelinePill can fold into its tooltip OR a short pill label
 *      to add as an extra picker row.
 *
 * Why this lives in views/ even though F111's pure helpers live in
 * git/: this is the orchestrator that touches `gh pr view`, `git
 * show <sha>:<path>` and the workspace - all VS Code/fs concerns. The
 * heuristic + sort lives in `git/complexityForPr.ts`.
 *
 * Constraints:
 *   - Hides silently when `gh` CLI missing or repo isn't github.com.
 *   - Caches per-PR-tip-sha (a single PR's results are reused while
 *     the tip doesn't move).
 *   - Bounded fan-out: only the first 100 changed source files are
 *     scored. The "Open report" action notes when the cap was hit.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  summarisePrComplexity,
  formatPillLabel,
  buildPrComplexityTooltip,
  buildPrComplexityReport,
  PrChangedFile,
  PrComplexitySummary,
} from '../git/complexityForPr';
import { isAnalysableFile } from '../git/complexityBadge';

const pexec = promisify(execFile);
const FILE_CAP = 100;

interface CacheEntry { tipSha: string; summary: PrComplexitySummary; prNumber?: number; rangeRef?: string; }
const summaryCache = new Map<string, CacheEntry>();

export async function showComplexityForPr(git: Git): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot fetch PR file list.');
    return;
  }
  const meta = await loadPrMeta(git);
  if (!meta) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: scoring complexity for PR #${meta.number}\u2026`,
    },
    async () => {
      const summary = await loadOrComputeSummary(git, meta);
      await renderPicker(git, meta, summary);
    },
  );
}

/**
 * Helper for the PrTimelinePill: load the (possibly cached) summary
 * and return a one-line label fit for an extra picker row, plus the
 * full markdown body for the picker.
 */
export async function loadPillData(git: Git): Promise<{ label: string; markdown: string } | undefined> {
  if (!(await ghAvailable())) return undefined;
  const meta = await loadPrMeta(git);
  if (!meta) return undefined;
  try {
    const summary = await loadOrComputeSummary(git, meta);
    return {
      label: formatPillLabel(summary),
      markdown: buildPrComplexityTooltip(summary),
    };
  } catch {
    return undefined;
  }
}

async function loadOrComputeSummary(git: Git, meta: PrMeta): Promise<PrComplexitySummary> {
  const cacheKey = `${git.cwd}\u0001${meta.number}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && cached.tipSha === meta.tipSha) return cached.summary;

  const files = await loadPrFiles(git, meta);
  const summary = summarisePrComplexity(files);
  summaryCache.set(cacheKey, { tipSha: meta.tipSha, summary, prNumber: meta.number, rangeRef: meta.rangeRef });
  return summary;
}

interface PrMeta {
  number: number;
  tipSha: string;
  baseRef: string;
  rangeRef: string;
}

async function loadPrMeta(git: Git): Promise<PrMeta | undefined> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view',
      '--json', 'number,baseRefName,headRefOid,headRefName',
    ], { cwd: git.cwd, timeout: 10000, maxBuffer: 1024 * 1024 });
    const o = JSON.parse(stdout);
    if (!o?.number || !o?.headRefOid) return undefined;
    const baseRef = String(o.baseRefName ?? 'main');
    const tipSha = String(o.headRefOid);
    return {
      number: Number(o.number),
      tipSha,
      baseRef,
      rangeRef: `${baseRef}...${tipSha.slice(0, 12)}`,
    };
  } catch {
    return undefined;
  }
}

async function loadPrFiles(git: Git, meta: PrMeta): Promise<PrChangedFile[]> {
  // Use `gh pr diff --name-only` for the list, then `git show` per-file
  // for the body. Cheaper than `gh pr diff` (which returns the patch).
  const list = await ghPrFileList(git, meta.number);
  const filtered: { path: string; changeKind?: PrChangedFile['changeKind'] }[] = [];
  for (const entry of list) {
    if (entry.changeKind === 'D') {
      filtered.push(entry);   // keep for the deleted-count bucket
      continue;
    }
    if (!isAnalysableFile(entry.path)) continue;
    filtered.push(entry);
    if (filtered.length >= FILE_CAP * 2) break;  // hard upper bound
  }

  const out: PrChangedFile[] = [];
  let analysable = 0;
  for (const f of filtered) {
    if (f.changeKind === 'D') { out.push({ path: f.path, body: '', changeKind: 'D' }); continue; }
    if (analysable >= FILE_CAP) {
      // Still record path so summary doesn't lose count, but body
      // empty so it scores low. We mark it skipped in the report.
      out.push({ path: f.path, body: '' });
      analysable++;
      continue;
    }
    const body = await readFileAtTip(git, meta.tipSha, f.path);
    out.push({ path: f.path, body, changeKind: f.changeKind });
    analysable++;
  }
  return out;
}

async function ghPrFileList(git: Git, num: number): Promise<{ path: string; changeKind?: PrChangedFile['changeKind'] }[]> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view', String(num), '--json', 'files',
    ], { cwd: git.cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    const o = JSON.parse(stdout);
    const arr = Array.isArray(o?.files) ? o.files : [];
    return arr.map((f: any) => ({
      path: String(f?.path ?? '').replace(/^\//, ''),
      changeKind: classifyKind(f),
    })).filter((f: { path: string }) => !!f.path);
  } catch {
    return [];
  }
}

function classifyKind(f: any): PrChangedFile['changeKind'] | undefined {
  // gh exposes additions/deletions per file; a pure 0 / +N maps to A,
  // +N / 0 alone on additions stays M.
  const adds = Number(f?.additions ?? 0);
  const dels = Number(f?.deletions ?? 0);
  if (adds === 0 && dels > 0) return 'D';
  if (dels === 0 && adds > 0) return 'A';
  if (adds > 0 && dels > 0) return 'M';
  return undefined;
}

async function readFileAtTip(git: Git, sha: string, repoRelPath: string): Promise<string> {
  try {
    return await git.raw(['show', `${sha}:${repoRelPath}`]) ?? '';
  } catch {
    return '';
  }
}

async function renderPicker(git: Git, meta: PrMeta, summary: PrComplexitySummary): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action?: 'report' | 'refresh' | 'jump'; _path?: string };
  const items: Pk[] = [];
  items.push({
    label: `PR #${meta.number}  -  ${formatPillLabel(summary)}`,
    kind: vscode.QuickPickItemKind.Separator,
  } as any);
  items.push({ label: '$(symbol-text) Open full report', detail: 'markdown table with every file and metric', _action: 'report' });
  if (summary.analysed >= FILE_CAP) {
    items.push({ label: '$(info) Result capped at ' + FILE_CAP + ' analysable files', kind: vscode.QuickPickItemKind.Separator } as any);
  }
  items.push({ label: '$(refresh) Refresh now', _action: 'refresh' });
  items.push({ label: 'Files', kind: vscode.QuickPickItemKind.Separator } as any);
  for (const row of summary.rows.slice(0, 80)) {
    const tag = row.badge || 'L';
    items.push({
      label: `$(file) ${row.path}`,
      description: `${tag} (score ${row.score.score})`,
      detail: `lines ${row.score.logicalLines}, decisions ${row.score.decisions}, nest ${row.score.maxNesting}, fns ${row.score.functions}`,
      _action: 'jump',
      _path: row.path,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${summary.analysed} files - extreme:${summary.buckets.extreme} high:${summary.buckets.high} medium:${summary.buckets.medium} low:${summary.buckets.low}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked._action) return;
  if (picked._action === 'refresh') {
    const cacheKey = `${git.cwd}\u0001${meta.number}`;
    summaryCache.delete(cacheKey);
    await showComplexityForPr(git);
    return;
  }
  if (picked._action === 'report') {
    const md = buildPrComplexityReport(summary, { prNumber: meta.number, range: meta.rangeRef });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md + '\n' });
    await vscode.window.showTextDocument(doc, { preview: true });
    return;
  }
  if (picked._action === 'jump' && picked._path) {
    const abs = path.join(git.cwd, picked._path);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showWarningMessage(`GitSight: could not open ${picked._path}.`);
    }
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

/**
 * Convenience wrapper for the `gitsight.complexityBadge.showForPr`
 * command registration (mirrors the showForActiveFile path).
 */
export async function showComplexityForPrCommand(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  await showComplexityForPr(git);
}
