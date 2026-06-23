/**
 * F122 - Per-PR test-impact suggester.
 *
 * One command (`gitsight.testImpact`) that, given the current branch's
 * PR (or the configured base..HEAD range), ranks test files most likely
 * to exercise the changed code.
 *
 * Three signals:
 *   1. Direct imports - git grep -lE for "<importPath>" inside test
 *      files. Strongest signal (weight 10).
 *   2. Co-location - test files in the same directory as a changed
 *      source. Medium signal (weight 5).
 *   3. Naming siblings - test files whose stem matches the source
 *      file's stem under a sibling test dir. Low signal (weight 3).
 *
 * Composes with F111 (per-file complexity) + F114 (PR aggregate
 * complexity): all three accept a similar "files changed in the PR"
 * input. We use `gh pr view --json files` when a PR exists; otherwise
 * fall back to the range diff against the merge base.
 *
 * Hard requirements:
 *   - None! Works without gh (uses base..HEAD), without GitHub remote.
 *   - When gh is missing, the range is auto-detected via origin/HEAD
 *     symbolic ref (same heuristic as detectDefaultBranch).
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  isSourceFile,
  isTestFile,
  generateSiblingCandidates,
  composeImpact,
  formatImpactHeader,
  buildImpactReport,
  buildImportProbe,
  TestImpactSummary,
} from '../git/testImpact';

const pexec = promisify(execFile);

export async function showTestImpactForCurrentPr(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gitsight.testImpact');
  const sourceCap = Math.max(5, Math.min(500, cfg.get<number>('sourceCap', 100)));
  const includeNamingSiblings = cfg.get<boolean>('includeNamingSiblings', true);

  const summary = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitSight: ranking test impact\u2026', cancellable: true },
    async (_progress, token) => {
      const changed = await loadChangedFiles(git, token);
      if (!changed) return undefined;
      const sourceFiles = changed.filter(isSourceFile).slice(0, sourceCap);
      const testFilesChanged = changed.filter(isTestFile);
      if (sourceFiles.length === 0) {
        return composeImpact({
          sourceFiles: [], testFilesChanged,
          importMatches: {}, coLocated: {}, namingSiblings: {},
        });
      }
      const [importMatches, coLocated, namingSiblings] = await Promise.all([
        scanImports(git, sourceFiles, token),
        scanCoLocated(git, sourceFiles, token),
        includeNamingSiblings ? scanNamingSiblings(git, sourceFiles, token) : Promise.resolve({}),
      ]);
      return composeImpact({ sourceFiles, testFilesChanged, importMatches, coLocated, namingSiblings });
    },
  );

  if (!summary) {
    vscode.window.showInformationMessage('GitSight: could not determine PR range.');
    return;
  }
  await renderPicker(git, summary);
}

async function loadChangedFiles(git: Git, _token: vscode.CancellationToken): Promise<string[] | undefined> {
  // Prefer gh PR view --json files when available.
  if (await ghAvailable()) {
    try {
      const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'files'], {
        cwd: git.cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024,
      });
      const obj = JSON.parse(stdout);
      if (Array.isArray(obj?.files)) {
        return obj.files
          .map((f: any) => typeof f?.path === 'string' ? f.path : '')
          .filter((s: string) => !!s);
      }
    } catch { /* fall through to range diff */ }
  }
  // Fall back to range diff against detected default branch.
  const range = await detectRange(git);
  if (!range) return undefined;
  try {
    const out = await git.raw(['diff', '--name-only', range]);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return undefined;
  }
}

async function detectRange(git: Git): Promise<string | undefined> {
  // Same heuristic as ai/prDescription.ts.
  let baseRef: string | undefined;
  try {
    const out = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (out) baseRef = out;
  } catch { /* not set */ }
  if (!baseRef) {
    for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
      try { await git.raw(['rev-parse', '--verify', cand]); baseRef = cand; break; } catch {}
    }
  }
  if (!baseRef) return undefined;
  try {
    const mb = (await git.raw(['merge-base', baseRef, 'HEAD'])).trim();
    return mb ? `${mb}..HEAD` : `${baseRef}..HEAD`;
  } catch {
    return `${baseRef}..HEAD`;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

async function scanImports(git: Git, sources: string[], token: vscode.CancellationToken): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const src of sources) {
    if (token.isCancellationRequested) break;
    const { pattern } = buildImportProbe(src);
    try {
      const stdout = await git.raw(['grep', '-lE', '--', pattern]);
      for (const file of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
        if (!isTestFile(file)) continue;
        if (!out[file]) out[file] = [];
        if (!out[file].includes(src)) out[file].push(src);
      }
    } catch { /* git grep returns exit 1 on no match - swallow */ }
  }
  return out;
}

async function scanCoLocated(git: Git, sources: string[], _token: vscode.CancellationToken): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  // Cache directory listings to avoid re-scanning the same dirs.
  const dirCache = new Map<string, string[]>();
  for (const src of sources) {
    const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
    const absDir = dir ? path.join(git.cwd, dir) : git.cwd;
    let entries: string[] | undefined = dirCache.get(absDir);
    if (!entries) {
      try {
        const ents = await fs.readdir(absDir, { withFileTypes: true });
        entries = ents.filter(e => e.isFile()).map(e => e.name);
      } catch {
        entries = [];
      }
      dirCache.set(absDir, entries);
    }
    for (const name of entries) {
      const relPath = dir ? `${dir}/${name}` : name;
      if (!isTestFile(relPath)) continue;
      if (!out[relPath]) out[relPath] = [];
      if (!out[relPath].includes(src)) out[relPath].push(src);
    }
    // Also peek for __tests__ subdir
    const testsDir = path.join(absDir, '__tests__');
    try {
      const ents = await fs.readdir(testsDir, { withFileTypes: true });
      for (const e of ents) {
        if (!e.isFile()) continue;
        const relPath = `${dir ? dir + '/' : ''}__tests__/${e.name}`;
        if (!isTestFile(relPath)) continue;
        if (!out[relPath]) out[relPath] = [];
        if (!out[relPath].includes(src)) out[relPath].push(src);
      }
    } catch { /* no __tests__ */ }
  }
  return out;
}

async function scanNamingSiblings(git: Git, sources: string[], _token: vscode.CancellationToken): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const src of sources) {
    const cands = generateSiblingCandidates(src);
    for (const cand of cands) {
      const abs = path.join(git.cwd, cand);
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile()) {
          if (!out[cand]) out[cand] = [];
          if (!out[cand].includes(src)) out[cand].push(src);
        }
      } catch { /* candidate doesn't exist */ }
    }
  }
  return out;
}

async function renderPicker(git: Git, summary: TestImpactSummary): Promise<void> {
  type Pk = vscode.QuickPickItem & { _testFile?: string; _action?: 'open-report' | 'refresh' };
  const items: Pk[] = [];
  items.push({ label: formatImpactHeader(summary), kind: vscode.QuickPickItemKind.Separator } as any);
  if (summary.rows.length === 0) {
    if (summary.orphanSources.length) {
      items.push({ label: '$(warning) No tests detected for the changed sources' });
      for (const orphan of summary.orphanSources.slice(0, 15)) {
        items.push({ label: `  $(circle-large-outline) ${orphan}` });
      }
    } else {
      items.push({ label: '$(check) No source files changed in this PR' });
    }
  } else {
    for (const row of summary.rows) {
      const sigs = row.signals.join(', ');
      items.push({
        label: `$(beaker) ${row.testFile}`,
        description: `score ${row.score} - ${row.sourceFiles.length} source${row.sourceFiles.length === 1 ? '' : 's'} via ${sigs}`,
        detail: row.sourceFiles.slice(0, 4).join(', ') + (row.sourceFiles.length > 4 ? `\u2026 (+${row.sourceFiles.length - 4})` : ''),
        _testFile: row.testFile,
      });
    }
    if (summary.orphanSources.length) {
      items.push({ label: `${summary.orphanSources.length} orphan source${summary.orphanSources.length === 1 ? '' : 's'}`, kind: vscode.QuickPickItemKind.Separator } as any);
      for (const orphan of summary.orphanSources.slice(0, 10)) {
        items.push({ label: `  $(circle-slash) ${orphan}`, description: 'no suggested test' });
      }
    }
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(notebook) Open full report', _action: 'open-report' });
  items.push({ label: '$(refresh) Refresh', _action: 'refresh' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: summary.rows.length ? 'Test impact (top first)' : 'No tests suggested',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'refresh') {
    await vscode.commands.executeCommand('gitsight.testImpact');
    return;
  }
  if (picked._action === 'open-report') {
    const doc = await vscode.workspace.openTextDocument({
      content: buildImpactReport(summary),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    return;
  }
  if (picked._testFile) {
    const abs = path.join(git.cwd, picked._testFile);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showWarningMessage(`GitSight: could not open ${picked._testFile}.`);
    }
  }
}
