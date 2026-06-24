/**
 * F147 - GitHub Pages preview status-bar pill.
 *
 * Companion to F79 (gitsight.ghPagesPreview command). The pill is the
 * passive surface that surfaces the command when relevant; click =>
 * opens the F79 picker.
 *
 * Cadence:
 *   - On RepoManager change (debounced 2s) AND a 60s timer for the
 *     "user edited a docs file but didn't touch git" case.
 *   - Cheap path: `git status --porcelain` + `git diff --name-only
 *     <upstream>..HEAD` (no shell-outs to gh per tick; the Pages
 *     surface probe is cached across refresh cycles).
 *
 * Visibility:
 *   - hides on hide-clean / hide-not-applicable / hide-disabled
 *   - shows otherwise (with the pill text + tooltip from the pure
 *     helper)
 *
 * The "hasPagesSurface" probe is intentionally cached for the lifetime
 * of the controller (refreshed on config change). We don't want a
 * `gh api repos/.../pages` call every 60s.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  classifyPagesPill,
  formatPillText,
  buildPillTooltip,
  workflowsAdvertisePages,
  hasPagesSurface,
  PagesPillState,
} from '../git/ghPagesPreviewPill';

const pexec = promisify(execFile);
const PILL_PRIORITY = 84; // sits left of prTimelinePill (86)
const REFRESH_MS = 60_000;
const DEBOUNCE_MS = 2_000;

export class GhPagesPreviewPill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private cachedSurface?: { repoCwd: string; hasSurface: boolean; expiresAt: number };

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PILL_PRIORITY);
    this.item.command = 'gitsight.ghPagesPreview';
    this.disposables.push(
      this.item,
      this.repos.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.ghPagesPreviewPill') || e.affectsConfiguration('gitsight.ghPagesPreview')) {
          this.cachedSurface = undefined;
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
    );
    this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
    queueMicrotask(() => this.refresh().catch(() => {}));
  }

  private scheduleRefresh() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh().catch(() => {}), DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.ghPagesPreviewPill');
    const enabled = cfg.get<boolean>('enabled', true);
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    if (!enabled) { this.item.hide(); return; }

    const pagesDirs = vscode.workspace.getConfiguration('gitsight.ghPagesPreview')
      .get<string[]>('docsDirs', ['docs', '_site', 'site', 'public', 'build', 'dist', 'content']);

    // Probe the Pages surface (cached).
    const hasSurface = await this.probePagesSurface(git);

    // Gather the working-tree changed paths cheaply.
    const [workingTreeFiles, unpushedFiles] = await Promise.all([
      this.workingTreeChangedFiles(git).catch(() => [] as string[]),
      this.unpushedChangedFiles(git).catch(() => [] as string[]),
    ]);

    const state: PagesPillState = classifyPagesPill({
      enabled,
      workingTreeChangedFiles: workingTreeFiles,
      unpushedFiles,
      pagesDirs,
      hasPagesSurface: hasSurface,
    });

    if (state.verdict !== 'show') {
      this.item.hide();
      return;
    }
    this.item.text = `$(book) ${formatPillText(state)}`;
    const md = new vscode.MarkdownString(buildPillTooltip({ state }));
    md.isTrusted = true;
    md.supportThemeIcons = true;
    this.item.tooltip = md;
    this.item.backgroundColor = undefined; // info-level, no urgency
    this.item.show();
  }

  private async probePagesSurface(git: Git): Promise<boolean> {
    const repoCwd = git.cwd;
    const now = Date.now();
    if (this.cachedSurface && this.cachedSurface.repoCwd === repoCwd && this.cachedSurface.expiresAt > now) {
      return this.cachedSurface.hasSurface;
    }
    // 10-minute TTL on the surface probe; rare to flip and a stale negative
    // just hides the pill (graceful).
    const TTL = 10 * 60 * 1000;
    const [apiSaysEnabled, workflowSaysEnabled] = await Promise.all([
      this.probePagesApi(git).catch(() => false),
      this.scanWorkflowsForPages(git).catch(() => false),
    ]);
    const result = hasPagesSurface({ apiSaysEnabled, workflowSaysEnabled });
    this.cachedSurface = { repoCwd, hasSurface: result, expiresAt: now + TTL };
    return result;
  }

  private async probePagesApi(git: Git): Promise<boolean> {
    // Resolve repo slug. Hard-fail to false if we can't.
    try {
      const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
      const m = parseSlugFromUrl(url);
      if (!m) return false;
      const { stdout } = await pexec('gh', [
        'api',
        `repos/${m.owner}/${m.repo}/pages`,
      ], { timeout: 8000, maxBuffer: 256 * 1024 });
      return !!stdout && stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async scanWorkflowsForPages(git: Git): Promise<boolean> {
    try {
      const wfDir = path.join(git.cwd, '.github', 'workflows');
      const entries = await fs.readdir(wfDir).catch(() => [] as string[]);
      const ymls = entries.filter(e => /\.ya?ml$/i.test(e));
      if (ymls.length === 0) return false;
      // Read up to 20 workflow files; sufficient for any real repo.
      const reads = await Promise.all(ymls.slice(0, 20).map(async name => {
        try {
          return await fs.readFile(path.join(wfDir, name), 'utf8');
        } catch {
          return '';
        }
      }));
      return workflowsAdvertisePages(reads);
    } catch {
      return false;
    }
  }

  private async workingTreeChangedFiles(git: Git): Promise<string[]> {
    const raw = await git.raw(['status', '--porcelain', '-z']);
    if (!raw) return [];
    const out: string[] = [];
    // -z output is NUL-separated; the format is "XY path" or "XY path\0src" for renames.
    const records = raw.split('\0').filter(r => r.length > 0);
    for (const r of records) {
      // First two chars are status, then space, then path. Renames have "path\0src"
      // shape but the rename split is already handled by NUL.
      const path = r.slice(3);
      if (path) out.push(path);
    }
    return out;
  }

  private async unpushedChangedFiles(git: Git): Promise<string[]> {
    // What's in our HEAD but not on the upstream?
    try {
      const upstream = (await git.raw(['rev-parse', '--abbrev-ref', '@{upstream}'])).trim();
      if (!upstream) return [];
      const raw = await git.raw(['diff', '--name-only', `${upstream}..HEAD`]);
      return raw.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      // No upstream / detached HEAD - no unpushed range.
      return [];
    }
  }

  dispose() {
    clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.disposables.forEach(d => d.dispose());
  }
}

function parseSlugFromUrl(url: string): { owner: string; repo: string } | undefined {
  // git@github.com:owner/repo.git
  const ssh = /^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(url);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // https://github.com/owner/repo(.git)
  const https = /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i.exec(url);
  if (https) return { owner: https[1], repo: https[2] };
  return undefined;
}
