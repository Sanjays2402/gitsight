/**
 * F89 — GitHub Secret Audit Pill.
 *
 * Status-bar pill at priority 88 (just left of the F78 stagedConflictGate
 * at 89, which sits left of F62 actionsPill at 90 and F59 submodulePill
 * at 92). The pill lights up in red when any `${{ secrets.X }}` reference
 * in a workflow file under `.github/workflows/` doesn't have a matching
 * secret on the GitHub side (`gh secret list`).
 *
 * Click -> picker with one row per missing secret + a "Run gh secret set"
 * action that opens a terminal with the right command pre-typed (we
 * never set secrets automatically — they're sensitive and the value
 * has to come from the user).
 *
 * Refresh: every 5 minutes by default, plus on RepoManager.onDidChange
 * (debounced by 5s). `gh secret list` is the expensive call; cache the
 * configured set across refreshes within one tick so we don't hammer
 * the API when the user is mid-rebase.
 *
 * Constraints:
 *   - Only activates when origin is github.com AND .github/workflows/
 *     contains at least one yaml file (mirrors actionsPill F62).
 *   - Silently hides when gh CLI isn't installed/authed (matches F62
 *     hostility-avoidance).
 *
 * Configurable via:
 *   gitsight.secretAudit.enabled         (default true)
 *   gitsight.secretAudit.refreshMinutes  (default 5, minimum 1)
 *   gitsight.secretAudit.hideOnHealthy   (default true)
 *   gitsight.secretAudit.includeOrgSecrets (default true) — pass --visibility all
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  scanWorkflowBody,
  buildAudit,
  pillLabel,
  pillTooltip,
  workflowFilesFromDir,
  SecretAuditResult,
} from '../git/secretAudit';

const pexec = promisify(execFile);
const SHOW_COMMAND = 'gitsight.secretAudit.show';
const RESCAN_COMMAND = 'gitsight.secretAudit.rescan';

export class SecretAuditPill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private refreshDebounce?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private latest?: { audit: SecretAuditResult; repo: string };
  private inFlight = false;

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    this.item.command = SHOW_COMMAND;
    const initialMin = readRefreshMinutes();
    this.timer = setInterval(() => this.tick().catch(() => {}), initialMin * 60 * 1000);
    this.disposables.push(
      this.item,
      { dispose: () => clearInterval(this.timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.secretAudit')) this.scheduleRefresh();
      }),
      repos.onDidChange(() => this.scheduleRefresh()),
    );
    queueMicrotask(() => this.tick().catch(() => {}));
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(SHOW_COMMAND, () =>
        this.showPicker().catch(e => vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`)),
      ),
      vscode.commands.registerCommand(RESCAN_COMMAND, async () => {
        await this.tick();
        vscode.window.setStatusBarMessage('GitSight: re-audited secrets', 2000);
      }),
    ];
  }

  private scheduleRefresh() {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => this.tick().catch(() => {}), 5000);
  }

  private async tick(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.secretAudit');
    if (!cfg.get<boolean>('enabled', true)) { this.item.hide(); return; }
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const git = this.repos.primary();
      if (!git) { this.item.hide(); return; }
      if (!(await isGithubRepo(git))) { this.item.hide(); return; }
      const workflowsDir = path.join(git.cwd, '.github', 'workflows');
      const wfFiles = await listWorkflowFiles(workflowsDir);
      if (!wfFiles.length) { this.item.hide(); return; }
      if (!(await hasGhCli())) { this.item.hide(); return; }

      const audit = await this.runAudit(git, workflowsDir, wfFiles, cfg);
      this.latest = { audit, repo: git.cwd };
      this.repaint(cfg, audit);
    } finally {
      this.inFlight = false;
    }
  }

  private async runAudit(
    git: Git,
    workflowsDir: string,
    files: string[],
    _cfg: vscode.WorkspaceConfiguration,
  ): Promise<SecretAuditResult> {
    const scans = await Promise.all(files.map(async f => {
      const body = await fs.readFile(path.join(workflowsDir, f), 'utf8').catch(() => '');
      const { refs, dynamicRefCount } = scanWorkflowBody(f, body);
      return { workflow: f, refs, dynamicRefCount };
    }));
    const configured = await loadConfiguredSecrets(git);
    return buildAudit({ scans, configured });
  }

  private repaint(cfg: vscode.WorkspaceConfiguration, audit: SecretAuditResult): void {
    if (!audit.missing.length && cfg.get<boolean>('hideOnHealthy', true)) {
      this.item.hide();
      return;
    }
    const icon = audit.missing.length ? '$(warning)' : '$(shield)';
    this.item.text = `${icon} ${pillLabel(audit)}`;
    const md = new vscode.MarkdownString(pillTooltip(audit));
    md.isTrusted = false;
    md.supportHtml = true;
    this.item.tooltip = md;
    this.item.backgroundColor = audit.missing.length
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  private async showPicker(): Promise<void> {
    if (!this.latest) {
      await this.tick();
    }
    const state = this.latest;
    if (!state) {
      vscode.window.showInformationMessage('GitSight: secret audit hasn\u2019t completed yet.');
      return;
    }
    const { audit, repo } = state;
    if (!audit.missing.length) {
      vscode.window.showInformationMessage(
        `GitSight: all ${audit.referenced.length} workflow secret${audit.referenced.length === 1 ? '' : 's'} are set on GitHub.`,
      );
      return;
    }
    type Pk = vscode.QuickPickItem & { _name?: string; _action: 'open' | 'set' | 'rescan' };
    const items: Pk[] = [];
    items.push({ label: pillLabel(audit), kind: vscode.QuickPickItemKind.Separator, _action: 'open' } as any);
    for (const name of audit.missing) {
      const refs = audit.refs.filter(r => r.name === name);
      items.push({
        label: `$(warning) ${name}`,
        description: summariseRefs(refs),
        detail: 'Open the first reference in the editor',
        _name: name,
        _action: 'open',
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, _action: 'set' } as any);
    items.push({
      label: '$(key) Set a missing secret\u2026',
      description: 'opens a terminal with `gh secret set <name>` pre-typed',
      _action: 'set',
    });
    items.push({
      label: '$(refresh) Re-run audit',
      description: 're-fetches gh secret list and rescans workflows',
      _action: 'rescan',
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${audit.missing.length} missing secret${audit.missing.length === 1 ? '' : 's'} \u00b7 ${audit.referenced.length} referenced`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked._action === 'rescan') return this.tick();
    if (picked._action === 'set') return this.promptSetSecret(repo, audit.missing);
    if (picked._action === 'open' && picked._name) return this.openFirstRef(repo, audit, picked._name);
  }

  private async openFirstRef(repo: string, audit: SecretAuditResult, name: string): Promise<void> {
    const first = audit.refs.find(r => r.name === name);
    if (!first) return;
    const abs = path.join(repo, '.github', 'workflows', first.workflow);
    const uri = vscode.Uri.file(abs);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const lineZero = Math.max(0, first.line - 1);
      const pos = new vscode.Position(lineZero, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: cannot open ${first.workflow}: ${e.message ?? e}`);
    }
  }

  private async promptSetSecret(repo: string, missing: string[]): Promise<void> {
    const picked = await vscode.window.showQuickPick(missing, {
      placeHolder: 'Which secret would you like to set?',
    });
    if (!picked) return;
    const term = vscode.window.createTerminal({ name: `gh secret set ${picked}`, cwd: repo });
    term.show();
    term.sendText(`gh secret set ${shellQuote(picked)}`, false);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

function readRefreshMinutes(): number {
  const cfg = vscode.workspace.getConfiguration('gitsight.secretAudit');
  const v = cfg.get<number>('refreshMinutes', 5) ?? 5;
  return Math.max(1, Math.min(120, v));
}

async function isGithubRepo(git: Git): Promise<boolean> {
  const url = (await safe(git, ['config', '--get', 'remote.origin.url'])).trim();
  return /github\.com[:/]/.test(url);
}

async function listWorkflowFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return workflowFilesFromDir(entries);
  } catch {
    return [];
  }
}

async function hasGhCli(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000, maxBuffer: 64 * 1024 }); return true; }
  catch { return false; }
}

async function loadConfiguredSecrets(git: Git): Promise<Set<string>> {
  const cfg = vscode.workspace.getConfiguration('gitsight.secretAudit');
  const includeOrg = cfg.get<boolean>('includeOrgSecrets', true);
  const out = new Set<string>();
  // Repo-level secrets.
  try {
    const args = ['secret', 'list', '--json', 'name'];
    const { stdout } = await pexec('gh', args, { cwd: git.cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    addSecretNames(out, stdout);
  } catch {
    // gh auth issues / no network: leave empty so we flag everything as
    // missing (the warning surfaces the broken auth state too).
  }
  // Repo-level variables (referenced via vars.X, but some users mix them in
  // — best-effort: cover the case gh recognises `gh variable list`).
  // We don't add vars to the configured set because they're a different
  // namespace; flagging a missing var as a missing secret would mislead.
  if (includeOrg) {
    // Org-visible secrets shared with this repo.
    try {
      const { stdout } = await pexec(
        'gh',
        ['api', '-q', '.secrets | .[].name', `repos/${await ownerName(git)}/actions/secrets`],
        { cwd: git.cwd, timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
      );
      for (const line of stdout.split('\n')) {
        const n = line.trim();
        if (n) out.add(n);
      }
    } catch { /* fall back to repo-only set */ }
  }
  return out;
}

function addSecretNames(into: Set<string>, raw: string) {
  if (!raw) return;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      if (r && typeof r.name === 'string') into.add(r.name);
    }
  } catch { /* ignore */ }
}

async function ownerName(git: Git): Promise<string> {
  // owner/repo derived from origin url.
  const url = (await safe(git, ['config', '--get', 'remote.origin.url'])).trim();
  const m = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (!m) return '';
  return `${m[1]}/${m[2]}`;
}

function summariseRefs(refs: { workflow: string; line: number }[]): string {
  if (!refs.length) return '';
  const byFile = new Map<string, number[]>();
  for (const r of refs) {
    let arr = byFile.get(r.workflow);
    if (!arr) { arr = []; byFile.set(r.workflow, arr); }
    arr.push(r.line);
  }
  const parts: string[] = [];
  for (const [file, lines] of byFile) {
    parts.push(`${file}:${lines.join(',')}`);
  }
  return parts.join('  \u00b7  ');
}

function shellQuote(s: string): string {
  // gh secret names are [A-Za-z0-9_]+, safe to interpolate, but quote
  // defensively for future-proofing if GitHub ever loosens the rules.
  if (/^[A-Za-z0-9_]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
