/**
 * F78 — Staged Conflict Marker Gate.
 *
 * A passive watcher that scans `git diff --cached` for unresolved
 * conflict markers in STAGED hunks and surfaces them as:
 *
 *   1. A status-bar pill at priority 89 (just left of the F62 actions
 *      pill at 90) that lights up when staged content contains
 *      `<<<<<<<` / `=======` / `>>>>>>>` markers on the `+` side.
 *      Click → picker.
 *
 *   2. A VS Code DiagnosticCollection so the markers appear in the
 *      Problems panel and the editor gutter (Severity.Error so the
 *      user can't miss them, with code 'gitsight.stagedConflict').
 *
 *   3. A picker (`gitsight.stagedConflictGate.show`) with one row per
 *      affected file + an "Open + jump to first conflict" action.
 *
 * Why STAGED-only: the F34 controller already catches markers in the
 * currently-open editor; the F14 pre-push lint catches them at push
 * time. The miss in the middle is "I staged a file that still has the
 * markers". That's where this watcher lives.
 *
 * Refresh cadence: every 2s timer (same as F39 forgottenFiles), plus
 * on RepoManager change so staging through the SCM view triggers a
 * rescan immediately.
 *
 * Configurable via:
 *   gitsight.stagedConflictGate.enabled    (default true)
 *   gitsight.stagedConflictGate.severity   ('error' | 'warning' | 'info',
 *                                            default 'error')
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  findStagedMarkers,
  groupByFile,
  summarisePill,
  tooltipLines,
  firstMarkerLine,
  StagedFileFinding,
} from '../git/stagedConflictGate';

const SHOW_COMMAND = 'gitsight.stagedConflictGate.show';
const RESCAN_COMMAND = 'gitsight.stagedConflictGate.rescan';

export class StagedConflictGateController implements vscode.Disposable {
  private pill: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private diagnostics: vscode.DiagnosticCollection;
  private latest: StagedFileFinding[] = [];
  private inFlight = false;

  constructor(private repos: RepoManager) {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    this.pill.command = SHOW_COMMAND;
    this.diagnostics = vscode.languages.createDiagnosticCollection('gitsight.stagedConflict');
    this.disposables.push(this.pill, this.diagnostics);

    this.timer = setInterval(() => this.tick().catch(() => {}), 2000);
    this.disposables.push(
      { dispose: () => clearInterval(this.timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.stagedConflictGate')) {
          this.tick().catch(() => {});
        }
      }),
      this.repos.onDidChange(() => this.tick().catch(() => {})),
    );
    // Initial paint.
    queueMicrotask(() => this.tick().catch(() => {}));
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(SHOW_COMMAND, () =>
        this.showPicker().catch(e => vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`)),
      ),
      vscode.commands.registerCommand(RESCAN_COMMAND, async () => {
        await this.tick();
        vscode.window.setStatusBarMessage('GitSight: rescanned staged conflict markers', 2000);
      }),
    ];
  }

  private async tick(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.stagedConflictGate');
    if (!cfg.get<boolean>('enabled', true)) {
      this.pill.hide();
      this.diagnostics.clear();
      this.latest = [];
      return;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.scan(cfg);
      this.repaintPill();
      this.repaintDiagnostics(cfg);
    } finally {
      this.inFlight = false;
    }
  }

  private async scan(_cfg: vscode.WorkspaceConfiguration): Promise<void> {
    const git = this.repos.primary();
    if (!git) { this.latest = []; return; }
    // -U0 keeps the diff cheap and removes context noise; --no-color
    // keeps the parser regex sane.
    const diff = await safe(git, ['diff', '--cached', '-U0', '--no-color']);
    const markers = findStagedMarkers(diff);
    this.latest = groupByFile(markers);
  }

  private repaintPill(): void {
    if (!this.latest.length) {
      this.pill.hide();
      return;
    }
    this.pill.text = `$(error) ${summarisePill(this.latest)}`;
    const md = new vscode.MarkdownString(
      `**GitSight: staged conflict markers**\n\n${tooltipLines(this.latest).join('\n')}\n\nClick to review.`,
    );
    md.isTrusted = false;
    this.pill.tooltip = md;
    this.pill.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.pill.show();
  }

  private repaintDiagnostics(cfg: vscode.WorkspaceConfiguration): void {
    this.diagnostics.clear();
    if (!this.latest.length) return;
    const git = this.repos.primary();
    if (!git) return;
    const severity = mapSeverity(cfg.get<string>('severity', 'error'));
    for (const f of this.latest) {
      const abs = path.join(git.cwd, f.path);
      const uri = vscode.Uri.file(abs);
      const diags: vscode.Diagnostic[] = f.markers.map(m => {
        const lineZero = Math.max(0, m.line - 1);
        const range = new vscode.Range(lineZero, 0, lineZero, 80);
        const refLabel = m.refName ? ` (${m.refName})` : '';
        const label = m.kind === 'start' ? 'Conflict marker <<<<<<<'
          : m.kind === 'separator' ? 'Conflict marker ======='
          : m.kind === 'end' ? 'Conflict marker >>>>>>>'
          : 'Conflict base marker |||||||';
        const d = new vscode.Diagnostic(range, `${label}${refLabel} in STAGED content — resolve before committing.`, severity);
        d.code = 'gitsight.stagedConflict';
        d.source = 'GitSight';
        return d;
      });
      this.diagnostics.set(uri, diags);
    }
  }

  private async showPicker(): Promise<void> {
    const git = this.repos.primary();
    if (!git) return;
    if (!this.latest.length) {
      vscode.window.showInformationMessage('GitSight: no conflict markers in staged content.');
      return;
    }
    type Pk = vscode.QuickPickItem & { _file?: StagedFileFinding; _action: 'open' | 'unstage' };
    const items: Pk[] = [];
    items.push({ label: summarisePill(this.latest), kind: vscode.QuickPickItemKind.Separator, _action: 'open' } as any);
    for (const f of this.latest) {
      const firstLine = firstMarkerLine(f) ?? 1;
      const conflicts = Math.max(f.byKind.start, 1);
      items.push({
        label: `$(go-to-file) ${f.path}`,
        description: `${conflicts} conflict${conflicts === 1 ? '' : 's'}  \u00b7  first @ L${firstLine}`,
        detail: 'Open the file and jump to the first marker',
        _action: 'open',
        _file: f,
      });
    }
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, _action: 'unstage' } as any);
    items.push({
      label: '$(discard) Unstage all flagged files',
      description: 'git reset HEAD -- <paths>',
      detail: 'Runs `git reset HEAD` for each file so you can fix the markers and re-stage cleanly',
      _action: 'unstage',
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: summarisePill(this.latest),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked._action === 'unstage') {
      await this.unstageAll(git);
      return;
    }
    if (picked._file) {
      await this.openAtFirstMarker(git, picked._file);
    }
  }

  private async openAtFirstMarker(git: Git, f: StagedFileFinding): Promise<void> {
    const abs = path.join(git.cwd, f.path);
    const uri = vscode.Uri.file(abs);
    const line = (firstMarkerLine(f) ?? 1) - 1;
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private async unstageAll(git: Git): Promise<void> {
    const paths = this.latest.map(f => f.path);
    if (!paths.length) return;
    try {
      await git.raw(['reset', 'HEAD', '--', ...paths]);
      vscode.window.setStatusBarMessage(
        `GitSight: unstaged ${paths.length} file${paths.length === 1 ? '' : 's'} with conflict markers`,
        3000,
      );
      vscode.commands.executeCommand('gitsight.refresh');
      await this.tick();
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: unstage failed: ${e.message ?? e}`);
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

function mapSeverity(raw: string): vscode.DiagnosticSeverity {
  const v = (raw ?? '').toLowerCase();
  if (v === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (v === 'info' || v === 'information') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Error;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
