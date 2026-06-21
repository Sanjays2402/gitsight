/**
 * GitHub Actions Run Pill (F62).
 *
 * Status-bar pill that shows the latest GitHub Actions run for the
 * current branch (`gh run list -L 1 --branch <branch>`). Click opens an
 * action menu with rerun / view logs / open in browser.
 *
 * Constraints:
 *   - Only activates when the repo has a `github.com` origin remote AND
 *     a `.github/workflows/*.{yml,yaml}` directory with at least one
 *     workflow file. Without both, the pill silently hides \u2014 nobody
 *     wants a "$(question) CI: unknown" pill on a personal repo with
 *     no CI.
 *   - Refreshes on `RepoManager.onDidChange` AND a 30s timer. The pill
 *     debounces ref-change refreshes by 2s so a multi-step rebase
 *     doesn't fire five `gh run` calls.
 *   - Uses `gh` CLI rather than the API directly so the existing auth
 *     state is shared (matches F38 open-last-pushed-branch and F57
 *     default-reviewers patterns).
 *   - Skips silently when `gh` isn't on PATH or auth is missing \u2014
 *     surfacing a noisy error every 30s would be hostile.
 *
 * Configurable via:
 *   gitsight.actionsPill.enabled       (default true)
 *   gitsight.actionsPill.refreshSeconds (default 30, minimum 10)
 *   gitsight.actionsPill.hideOnSuccess  (default false) \u2014 hide the pill
 *                                                          when the
 *                                                          latest run
 *                                                          was a green
 *                                                          success.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  parseGhRunList,
  formatPillLabel,
  formatTooltipMarkdown,
  severityForRun,
  hasGithubWorkflows,
  CiRun,
  RunState,
} from '../git/ghActions';
import { ageLabel } from '../git/recentBranches';

const pexec = promisify(execFile);

export class ActionsPill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private refreshDebounce?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private cmdId = 'gitsight.actionsPill.menu';
  private latest: { run?: CiRun; branch?: string; repo?: string } = {};

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = this.cmdId;
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(this.cmdId, () => this.showMenu()),
      repos.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.actionsPill')) this.scheduleRefresh();
      }),
    );
    const initialSec = readRefreshSeconds();
    this.timer = setInterval(() => this.refresh().catch(() => {}), initialSec * 1000);
    queueMicrotask(() => this.refresh().catch(() => {}));
  }

  private scheduleRefresh() {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => this.refresh().catch(() => {}), 2000);
  }

  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.actionsPill');
    if (!cfg.get<boolean>('enabled', true)) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }

    if (!(await isGithubRepoWithWorkflows(git))) { this.item.hide(); return; }
    if (!(await hasGhCli())) { this.item.hide(); return; }

    const branch = await safeBranch(git);
    if (!branch || branch === 'HEAD') { this.item.hide(); return; }
    const run = await loadLatestRun(git, branch);
    if (!run) {
      this.item.hide();
      return;
    }
    if (run.state === 'success' && cfg.get<boolean>('hideOnSuccess', false)) {
      this.item.hide();
      this.latest = { run, branch, repo: git.cwd };
      return;
    }
    this.latest = { run, branch, repo: git.cwd };
    this.item.text = formatPillLabel(run);
    const sev = severityForRun(run.state);
    this.item.backgroundColor = sev === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : sev === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    const tip = new vscode.MarkdownString(
      formatTooltipMarkdown(run, {
        branch,
        ageLabel: run.updatedAt ? ageLabel(run.updatedAt) : undefined,
      }),
    );
    tip.isTrusted = true;
    this.item.tooltip = tip;
    this.item.show();
  }

  private async showMenu() {
    const { run, branch, repo } = this.latest;
    if (!run || !branch || !repo) {
      vscode.window.showInformationMessage('GitSight: no GitHub Actions run for the current branch yet.');
      return;
    }
    type Pk = vscode.QuickPickItem & { _action: 'open' | 'logs' | 'rerun' | 'rerun-failed' | 'cancel' | 'refresh' };
    const items: Pk[] = [
      { label: '$(globe) Open run in browser', description: run.url, _action: 'open' },
      { label: '$(output) View logs (terminal)', description: `gh run view ${run.databaseId} --log`, _action: 'logs' },
    ];
    if (run.state === 'failure' || run.state === 'cancelled' || run.state === 'other') {
      items.push({ label: '$(debug-restart) Rerun failed jobs', description: `gh run rerun ${run.databaseId} --failed`, _action: 'rerun-failed' });
    }
    items.push({ label: '$(refresh) Rerun all jobs', description: `gh run rerun ${run.databaseId}`, _action: 'rerun' });
    if (run.state === 'running') {
      items.push({ label: '$(stop) Cancel run', description: `gh run cancel ${run.databaseId}`, _action: 'cancel' });
    }
    items.push({ label: '$(sync) Refresh now', description: 'force a re-fetch', _action: 'refresh' });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${run.workflowName || 'workflow'} \u00b7 ${run.state} \u00b7 ${run.headSha.slice(0, 7)}`,
    });
    if (!picked) return;
    switch (picked._action) {
      case 'open':         return openUrl(run.url);
      case 'logs':         return runInTerminal(repo, `gh run view ${run.databaseId} --log`);
      case 'rerun':        return runGhCommand(repo, ['run', 'rerun', String(run.databaseId)], 'rerun');
      case 'rerun-failed': return runGhCommand(repo, ['run', 'rerun', String(run.databaseId), '--failed'], 'rerun failed');
      case 'cancel':       return runGhCommand(repo, ['run', 'cancel', String(run.databaseId)], 'cancel');
      case 'refresh':      return this.refresh();
    }
  }

  dispose() {
    clearInterval(this.timer);
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.disposables.forEach(d => d.dispose());
  }
}

function readRefreshSeconds(): number {
  const cfg = vscode.workspace.getConfiguration('gitsight.actionsPill');
  const v = cfg.get<number>('refreshSeconds', 30) ?? 30;
  return Math.max(10, Math.min(600, v));
}

async function isGithubRepoWithWorkflows(git: Git): Promise<boolean> {
  // 1. Origin must point at github.com.
  const url = (await safe(git, ['config', '--get', 'remote.origin.url'])).trim();
  if (!url || !/github\.com[:/]/.test(url)) return false;
  // 2. .github/workflows/ must exist with at least one .yml/.yaml file.
  try {
    const dirUri = vscode.Uri.file(path.join(git.cwd, '.github', 'workflows'));
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    return hasGithubWorkflows(entries.map(([name]) => name));
  } catch {
    return false;
  }
}

async function hasGhCli(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

async function safeBranch(git: Git): Promise<string> {
  try { return (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }
  catch { return ''; }
}

async function loadLatestRun(git: Git, branch: string): Promise<CiRun | undefined> {
  try {
    const { stdout } = await pexec(
      'gh',
      [
        'run', 'list',
        '--branch', branch,
        '--limit', '1',
        '--json', 'databaseId,status,conclusion,name,workflowName,headSha,startedAt,updatedAt,url,event',
      ],
      { cwd: git.cwd, timeout: 8000, maxBuffer: 1024 * 1024 },
    );
    const runs = parseGhRunList(stdout);
    return runs[0];
  } catch {
    return undefined;
  }
}

function runInTerminal(cwd: string, cmd: string) {
  const term = vscode.window.createTerminal({ name: 'GitSight: gh run', cwd });
  term.show();
  term.sendText(cmd);
}

async function runGhCommand(cwd: string, args: string[], label: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: gh ${args.join(' ')}\u2026` },
    async () => {
      try {
        await pexec('gh', args, { cwd, timeout: 15000 });
        vscode.window.showInformationMessage(`GitSight: ${label} requested.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: gh ${args.join(' ')} failed: ${(e.stderr || e.message || '').toString().split('\n')[0]}`);
      }
    },
  );
}

function openUrl(url: string): Thenable<boolean> {
  if (!url) return Promise.resolve(false);
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

/** Adapter so the controller doesn't need to know how runs are classified. */
export const __runState = (s: CiRun): RunState => s.state;
