/**
 * F101 — PR checkout pre-flight.
 *
 * New command `gitsight.prCheckoutPreflight` and a fold-in path from
 * the F75 PR review-inbox picker. Given a PR (number + repoSlug +
 * head/base ref names), runs a battery of pure checks (see
 * src/git/prCheckoutPreflight.ts) and presents the results as a
 * picker with three actions:
 *
 *   - Proceed with checkout (only enabled when verdict != 'blocked')
 *   - Open report in scratch buffer
 *   - Open PR in browser
 *
 * Inputs are gathered from:
 *   - workspace origin (slug)
 *   - git status --porcelain (dirty count)
 *   - git for-each-ref refs/heads (local branch list)
 *   - git rev-list --left-right --count base...origin/base (base divergence)
 *   - gh pr view --json files (PR file list)
 *   - git log --since=<window>d --author=<self> --name-only (recent files)
 *
 * The PR descriptor can be supplied directly (from F75) or accepted
 * as `{ number }` and resolved via gh on the fly.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { parseRemote } from '../git/hostDetect';
import {
  runPreflight,
  describeReport,
  renderPreflightMarkdown,
  countOverlap,
  PreflightInputs,
  PreflightReport,
} from '../git/prCheckoutPreflight';

const pexec = promisify(execFile);

export interface PrDescriptor {
  number: number;
  repoSlug: string;
  headRefName: string;
  baseRefName: string;
  url?: string;
  /** Optional PR file list - we'll fetch it if absent. */
  files?: string[];
}

export async function runPrCheckoutPreflight(git: Git, pr: PrDescriptor): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  const inputs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: pre-flight for ${pr.repoSlug}#${pr.number}\u2026` },
    () => gatherPreflightInputs(git, pr),
  );
  const report = runPreflight(inputs);

  const display = `${pr.repoSlug}#${pr.number} (${pr.headRefName} \u2192 ${pr.baseRefName})`;
  await presentPicker(git, pr, report, display);
}

/**
 * Entry-point for `gitsight.prCheckoutPreflight` command palette.
 * Prompts for a PR number and resolves the rest via gh.
 */
export async function runPrCheckoutPreflightInteractive(git: Git): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: 'PR number to pre-flight',
    placeHolder: '42',
    validateInput: v => /^\d+$/.test(v.trim()) ? undefined : 'Enter a positive integer',
  });
  if (!input) return;
  const num = parseInt(input.trim(), 10);
  const pr = await resolvePrByNumber(git, num);
  if (!pr) return;
  await runPrCheckoutPreflight(git, pr);
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version']); return true; } catch { return false; }
}

async function resolvePrByNumber(git: Git, number: number): Promise<PrDescriptor | undefined> {
  try {
    const { stdout } = await pexec(
      'gh',
      ['pr', 'view', String(number), '--json', 'number,url,headRefName,baseRefName,repository,files'],
      { cwd: git.cwd, maxBuffer: 8 * 1024 * 1024 },
    );
    const obj = JSON.parse(stdout);
    const slug = obj?.repository?.nameWithOwner
      ?? (obj?.repository?.owner?.login && obj?.repository?.name
            ? `${obj.repository.owner.login}/${obj.repository.name}`
            : undefined);
    if (!slug || !obj?.headRefName || !obj?.baseRefName) {
      vscode.window.showErrorMessage(`GitSight: could not resolve PR #${number}.`);
      return undefined;
    }
    return {
      number,
      repoSlug: slug,
      headRefName: obj.headRefName,
      baseRefName: obj.baseRefName,
      url: obj.url,
      files: Array.isArray(obj.files) ? obj.files.map((f: any) => String(f.path ?? '')).filter(Boolean) : undefined,
    };
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr view #${number} failed - ${String(e.stderr ?? e.message ?? '').split('\n')[0]}`);
    return undefined;
  }
}

async function gatherPreflightInputs(git: Git, pr: PrDescriptor): Promise<PreflightInputs> {
  // 1. Origin slug.
  const localSlug = await resolveLocalSlug(git);

  // 2. Dirty paths.
  const dirtyPaths = await countDirty(git);

  // 3. Local branches.
  const localBranches = await listLocalBranches(git);

  // 4. Base divergence: compute <base>..origin/<base>.
  const { behindBy, aheadBy } = await computeBaseDivergence(git, pr.baseRefName);

  // 5. PR files (fetch if not pre-supplied).
  let prFiles = pr.files ?? [];
  if (!prFiles.length) {
    prFiles = await fetchPrFiles(git, pr.number);
  }

  // 6. My recent files on the current branch.
  const myRecent = await fetchMyRecentFiles(git);
  const overlappingFiles = countOverlap(prFiles, myRecent);

  return {
    localSlug,
    prSlug: pr.repoSlug,
    dirtyPaths,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    localBranches,
    baseBehindBy: behindBy,
    baseAheadBy: aheadBy,
    overlappingFiles,
    prTotalFiles: prFiles.length,
  };
}

async function resolveLocalSlug(git: Git): Promise<string | undefined> {
  try {
    const remotes = await git.remotes();
    const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
    if (!origin) return undefined;
    const info = parseRemote(origin.fetchUrl);
    if (!info || info.host !== 'github') return undefined;
    if (!info.owner || !info.repo) return undefined;
    return `${info.owner}/${info.repo}`;
  } catch { return undefined; }
}

async function countDirty(git: Git): Promise<number> {
  try {
    const out = await git.raw(['status', '--porcelain']);
    return out.split('\n').filter(l => l.trim().length > 0).length;
  } catch { return 0; }
}

async function listLocalBranches(git: Git): Promise<string[]> {
  try {
    const out = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

async function computeBaseDivergence(git: Git, baseRef: string): Promise<{ behindBy: number; aheadBy: number }> {
  // Match the convention used in F26: <base>...<head>; here we want
  // local-base vs origin-base.
  const local = baseRef;
  const remote = `origin/${baseRef}`;
  try {
    // <local>...<remote> = left-right counts; left=ahead-of-remote, right=behind-by.
    const out = await git.raw(['rev-list', '--left-right', '--count', `${local}...${remote}`]);
    const parts = out.trim().split(/\s+/);
    const ahead = Number(parts[0] || '0');
    const behind = Number(parts[1] || '0');
    return { behindBy: behind, aheadBy: ahead };
  } catch { return { behindBy: 0, aheadBy: 0 }; }
}

async function fetchPrFiles(git: Git, number: number): Promise<string[]> {
  try {
    const { stdout } = await pexec(
      'gh',
      ['pr', 'view', String(number), '--json', 'files'],
      { cwd: git.cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    const obj = JSON.parse(stdout);
    if (!Array.isArray(obj?.files)) return [];
    return obj.files.map((f: any) => String(f.path ?? '')).filter(Boolean);
  } catch { return []; }
}

async function fetchMyRecentFiles(git: Git): Promise<string[]> {
  try {
    const email = (await git.raw(['config', 'user.email'])).trim();
    if (!email) return [];
    const days = vscode.workspace.getConfiguration('gitsight.prCheckoutPreflight').get<number>('recentWindowDays', 7);
    const out = await git.raw([
      'log',
      `--since=${Math.max(1, Math.min(60, days))}.days`,
      `--author=${email}`,
      '--name-only',
      '--pretty=format:',
    ]);
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
    return Array.from(set);
  } catch { return []; }
}

async function presentPicker(
  git: Git,
  pr: PrDescriptor,
  report: PreflightReport,
  display: string,
): Promise<void> {
  const summary = describeReport(report);
  const items: (vscode.QuickPickItem & { _action?: string })[] = [];

  // Check rows (informational).
  items.push({ label: summary, kind: vscode.QuickPickItemKind.Separator });
  for (const c of report.checks) {
    const glyph = c.severity === 'error' ? '$(error)' :
                  c.severity === 'warning' ? '$(warning)' : '$(pass)';
    items.push({
      label: `  ${glyph} ${c.title}`,
      description: c.message,
      detail: c.hint,
    });
  }

  // Action separator.
  items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
  if (report.verdict === 'blocked') {
    items.push({
      label: '$(circle-slash) Checkout blocked',
      description: 'Resolve the error checks first',
    });
  } else {
    items.push({
      label: '$(git-pull-request) Proceed with gh pr checkout',
      description: report.verdict === 'caution' ? 'with warnings - review report first' : 'verdict is clear',
      _action: 'checkout',
    });
  }
  items.push({
    label: '$(file-text) Open full report',
    description: 'Markdown scratch buffer',
    _action: 'report',
  });
  if (pr.url) {
    items.push({
      label: '$(link-external) Open PR in browser',
      description: pr.url,
      _action: 'browser',
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Pre-flight ${display} - ${summary}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked?._action) return;

  if (picked._action === 'report') {
    const md = renderPreflightMarkdown(display, report);
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    return;
  }
  if (picked._action === 'browser' && pr.url) {
    await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    return;
  }
  if (picked._action === 'checkout') {
    if (report.verdict === 'caution') {
      const ok = await vscode.window.showWarningMessage(
        `Pre-flight has ${report.counts.warning} warning${report.counts.warning === 1 ? '' : 's'}. Proceed with checkout?`,
        { modal: true, detail: report.checks.filter(c => c.severity !== 'ok').map(c => `\u2022 ${c.title}: ${c.message}`).join('\n') },
        'Proceed',
      );
      if (ok !== 'Proceed') return;
    }
    await doCheckout(git, pr);
  }
}

async function doCheckout(git: Git, pr: PrDescriptor): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: gh pr checkout ${pr.number}\u2026` },
      () => pexec('gh', ['pr', 'checkout', String(pr.number)], { cwd: git.cwd, maxBuffer: 4 * 1024 * 1024 }).then(() => undefined),
    );
    vscode.window.setStatusBarMessage(`Checked out PR #${pr.number}`, 3000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr checkout failed - ${String(e.stderr ?? e.message ?? '').split('\n')[0]}`);
  }
}
