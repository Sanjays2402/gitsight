/**
 * F116 - DCO Signed-off-by enforcement.
 *
 * Two surfaces:
 *
 *  1. SCM input box watcher: when the project requires DCO sign-off
 *     (per `detectDcoRequirement`) AND the user is composing a commit
 *     message that's missing the trailer, surface a pill warning.
 *     Severity = required -> error; suggested -> warning.
 *     Click -> picker offering "Add Signed-off-by" (appendSignoffTrailer
 *     directly into the SCM input box) / "Open CONTRIBUTING" / "Disable".
 *
 *  2. Standalone `gitsight.dcoSignoff.addToScm` command that always
 *     appends the trailer (handy for keybinding); never asks if the
 *     trailer is already present.
 *
 * The detection runs once per RepoManager change (cheap - one cached
 * read of CONTRIBUTING.md / DCO file). The pill itself polls SCM input
 * on the existing 1.5s commitLint cadence so DCO + commitLint feel
 * synchronised.
 *
 * Config:
 *   gitsight.dcoSignoff.enabled        (default true)
 *   gitsight.dcoSignoff.alwaysEnforce  (default false; forces required
 *                                       even when CONTRIBUTING is silent)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  detectDcoRequirement,
  lintCommitMessageForDco,
  appendSignoffTrailer,
  composeSignoffLine,
  hasSignoffTrailer,
  DCO_CANDIDATE_FILES,
  DcoVerdict,
  DcoSource,
  SignoffIdentity,
} from '../git/dcoSignoff';

const pexec = promisify(execFile);

interface RepoCache {
  verdict: DcoVerdict;
  source?: string;
  identity?: SignoffIdentity;
  computedAt: number;
}

export class DcoSignoffController implements vscode.Disposable {
  private pill: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout;
  private cache = new Map<string, RepoCache>();
  private lastValue = '';
  private latestProblems: { severity: 'error' | 'warning'; message: string; code: string }[] = [];
  private cmdId = 'gitsight.dcoSignoff.pill';

  constructor(private repos: RepoManager) {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 85);
    this.pill.command = this.cmdId;
    this.timer = setInterval(() => this.tick().catch(() => {}), 1500);
    this.disposables.push(
      this.pill,
      { dispose: () => clearInterval(this.timer) },
      this.repos.onDidChange(() => this.cache.clear()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.dcoSignoff')) this.cache.clear();
      }),
    );
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(this.cmdId, () => this.showMenu()),
      vscode.commands.registerCommand('gitsight.dcoSignoff.addToScm', () => this.addToScm()),
    ];
  }

  private async tick(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.dcoSignoff');
    if (!cfg.get<boolean>('enabled', true)) { this.pill.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.pill.hide(); return; }
    const value = readScmInput();
    if (value == null) { this.pill.hide(); return; }
    if (!value.trim()) { this.lastValue = ''; this.latestProblems = []; this.pill.hide(); return; }
    if (value === this.lastValue) {
      if (this.latestProblems.length) this.pill.show();
      return;
    }
    this.lastValue = value;
    const cache = await this.ensureCache(git);
    if (!cache) { this.pill.hide(); return; }
    const force = cfg.get<boolean>('alwaysEnforce', false);
    const verdict = force ? 'required' : cache.verdict;
    if (verdict === 'unknown' || verdict === 'disabled') { this.pill.hide(); return; }
    const sev = verdict === 'required' ? 'error' : 'warning';
    const problems = lintCommitMessageForDco(value, { identity: cache.identity, severity: sev });
    this.latestProblems = problems;
    if (!problems.length) { this.pill.hide(); return; }
    this.pill.text = sev === 'error'
      ? '$(error) sign-off missing'
      : '$(warning) sign-off recommended';
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**GitSight DCO**\n\n`);
    md.appendMarkdown(`${problems[0].message}\n\n`);
    if (cache.source) md.appendMarkdown(`_Detected via ${cache.source}_\n\n`);
    md.appendMarkdown('Click to add a `Signed-off-by:` trailer.');
    this.pill.tooltip = md;
    this.pill.backgroundColor = new vscode.ThemeColor(
      sev === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground',
    );
    this.pill.show();
  }

  private async ensureCache(git: Git): Promise<RepoCache | undefined> {
    const key = git.cwd;
    const existing = this.cache.get(key);
    if (existing) return existing;
    const sources = await loadDcoSources(git.cwd);
    const verdict = detectDcoRequirement(sources);
    const identity = await loadIdentity(git);
    const cache: RepoCache = {
      verdict: verdict.verdict,
      source: verdict.source,
      identity,
      computedAt: Date.now(),
    };
    this.cache.set(key, cache);
    return cache;
  }

  private async showMenu(): Promise<void> {
    type Pk = vscode.QuickPickItem & { _action: 'append' | 'open-source' | 'disable' };
    const git = this.repos.primary();
    if (!git) return;
    const cache = await this.ensureCache(git);
    const items: Pk[] = [];
    if (cache?.identity) {
      items.push({
        label: '$(check) Add Signed-off-by trailer to commit message',
        description: composeSignoffLine(cache.identity),
        _action: 'append',
      });
    } else {
      items.push({
        label: '$(warning) git identity not configured',
        description: 'Set user.name and user.email first',
        _action: 'append',
      });
    }
    if (cache?.source) {
      items.push({ label: `$(book) Open ${cache.source}`, _action: 'open-source' });
    }
    items.push({ label: '$(circle-slash) Disable DCO checking for this workspace', _action: 'disable' });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: this.latestProblems[0]?.message ?? 'DCO sign-off',
    });
    if (!picked) return;
    if (picked._action === 'append') {
      await this.addToScm();
    } else if (picked._action === 'open-source' && cache?.source) {
      try {
        const abs = path.join(git.cwd, cache.source);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch {
        vscode.window.showWarningMessage(`GitSight: could not open ${cache.source}.`);
      }
    } else if (picked._action === 'disable') {
      await vscode.workspace.getConfiguration('gitsight.dcoSignoff').update('enabled', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.setStatusBarMessage('GitSight: DCO sign-off check disabled for this workspace.', 3000);
    }
  }

  private async addToScm(): Promise<void> {
    const git = this.repos.primary();
    if (!git) return;
    const cache = await this.ensureCache(git);
    if (!cache?.identity) {
      vscode.window.showWarningMessage('GitSight: cannot add Signed-off-by - user.name / user.email not configured in git.');
      return;
    }
    const repo = scmRepository();
    if (!repo) {
      vscode.window.showWarningMessage('GitSight: built-in git extension not available.');
      return;
    }
    const before = repo.inputBox?.value ?? '';
    if (hasSignoffTrailer(before, cache.identity)) {
      vscode.window.setStatusBarMessage('GitSight: Signed-off-by trailer already present.', 2000);
      return;
    }
    const after = appendSignoffTrailer(before, cache.identity);
    if (repo.inputBox) repo.inputBox.value = after;
    vscode.window.setStatusBarMessage('GitSight: Signed-off-by appended.', 2500);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

async function loadDcoSources(cwd: string): Promise<DcoSource[]> {
  const out: DcoSource[] = [];
  for (const rel of DCO_CANDIDATE_FILES) {
    const abs = path.join(cwd, rel);
    try {
      const buf = await fs.readFile(abs, 'utf8');
      out.push({ path: rel, body: buf });
    } catch { /* missing - skip */ }
  }
  return out;
}

async function loadIdentity(git: Git): Promise<SignoffIdentity | undefined> {
  try {
    const name = (await git.raw(['config', 'user.name'])).trim();
    const email = (await git.raw(['config', 'user.email'])).trim();
    if (!name || !email) return undefined;
    return { name, email };
  } catch {
    return undefined;
  }
}

function scmRepository(): any {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return undefined;
    if (!gitExt.isActive) return undefined;
    const api = gitExt.exports?.getAPI?.(1);
    return api?.repositories?.[0];
  } catch {
    return undefined;
  }
}

function readScmInput(): string | null {
  const repo = scmRepository();
  if (!repo) return null;
  return repo.inputBox?.value ?? '';
}
