/**
 * F90 — SCM Diff Size Heuristic.
 *
 * Passive controller similar to F39 forgottenFiles + F78
 * stagedConflictGate. Watches the SCM input box; when there's a commit
 * being composed AND the staged diff exceeds a configurable line/file
 * threshold, surfaces:
 *
 *   1. A status-bar pill (priority 87, left of F89 secretAudit at 88)
 *      that lights up amber for `warning`/`noisy` and red for `huge`.
 *      Click -> picker with the breakdown + suggestions.
 *
 *   2. A Diagnostic on the SCM input box itself (Information severity
 *      for warning/noisy, Warning for huge) so the user sees the hint
 *      in the Problems panel too. We attach the diagnostic to a
 *      `gitsight://scm-input/<repo>` virtual URI rather than a real
 *      file because VS Code's SCM input box isn't a text document we
 *      can target directly.
 *
 *   3. A picker showing the breakdown (files, +/- lines, noisy fraction)
 *      with action buttons:
 *        - "Open `git add -p`" — opens a terminal with the patch picker
 *        - "Unstage some files\u2026" — multi-select unstage picker
 *        - "Show numstat" — opens a scratch buffer with the per-file
 *          numstat for the staged diff
 *
 * Cadence: every 3s (one tick slower than F78 because git diff
 * --cached --numstat is more expensive than diff --cached -U0). Also
 * re-runs on RepoManager.onDidChange + on SCM-input-text changes
 * (debounced 1s).
 *
 * Pairs with F60 commitScaffold + F84 regenerate so the suggestion
 * surfaces precisely when the user is composing a commit message —
 * the worst time to discover the diff is 1500 lines.
 *
 * Configurable via:
 *   gitsight.diffSize.enabled            (default true)
 *   gitsight.diffSize.lineThreshold      (default 400)
 *   gitsight.diffSize.fileThreshold      (default 20)
 *   gitsight.diffSize.hugeLineThreshold  (default 2000)
 *   gitsight.diffSize.noisyDominance     (default 0.7 = 70%)
 *   gitsight.diffSize.requireSCMInput    (default true) — only show when SCM input has text
 */
import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  parseNumstat,
  computeDiffStats,
  classifyDiffSize,
  extractSubjectType,
  DiffSizeDecision,
  DiffSizeStats,
} from '../git/diffSizeHeuristic';

const SHOW_COMMAND = 'gitsight.diffSize.show';
const RESCAN_COMMAND = 'gitsight.diffSize.rescan';

export class DiffSizeHeuristicController implements vscode.Disposable {
  private pill: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private diagnostics: vscode.DiagnosticCollection;
  private latest?: { stats: DiffSizeStats; decision: DiffSizeDecision; repo: string };
  private lastScmValue = '';
  private inFlight = false;

  constructor(private repos: RepoManager) {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 87);
    this.pill.command = SHOW_COMMAND;
    this.diagnostics = vscode.languages.createDiagnosticCollection('gitsight.diffSize');
    this.disposables.push(this.pill, this.diagnostics);

    this.timer = setInterval(() => this.tick().catch(() => {}), 3000);
    this.disposables.push(
      { dispose: () => clearInterval(this.timer) },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.diffSize')) this.tick().catch(() => {});
      }),
      repos.onDidChange(() => this.tick().catch(() => {})),
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
        vscode.window.setStatusBarMessage('GitSight: rescanned staged diff size', 2000);
      }),
    ];
  }

  private async tick(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.diffSize');
    if (!cfg.get<boolean>('enabled', true)) {
      this.pill.hide();
      this.diagnostics.clear();
      this.latest = undefined;
      return;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const git = this.repos.primary();
      if (!git) { this.pill.hide(); this.diagnostics.clear(); return; }

      const requireScmInput = cfg.get<boolean>('requireSCMInput', true);
      const scm = readScmInput() ?? '';
      this.lastScmValue = scm;

      if (requireScmInput && !scm.trim()) {
        this.pill.hide();
        this.diagnostics.clear();
        this.latest = undefined;
        return;
      }

      const numstatRaw = await safe(git, ['diff', '--cached', '--numstat']);
      const rows = parseNumstat(numstatRaw);
      const stats = computeDiffStats(rows);

      const decision = classifyDiffSize({
        stats,
        lineThreshold: clampInt(cfg.get<number>('lineThreshold', 400), 50, 100000),
        fileThreshold: clampInt(cfg.get<number>('fileThreshold', 20), 2, 1000),
        hugeLineThreshold: clampInt(cfg.get<number>('hugeLineThreshold', 2000), 200, 100000),
        noisyDominanceThreshold: clampFloat(cfg.get<number>('noisyDominance', 0.7), 0.1, 1),
        subjectType: extractSubjectType(scm),
      });

      this.latest = { stats, decision, repo: git.cwd };
      this.repaint(decision, git.cwd);
    } finally {
      this.inFlight = false;
    }
  }

  private repaint(decision: DiffSizeDecision, repo: string): void {
    if (decision.severity === 'ok') {
      this.pill.hide();
      this.diagnostics.clear();
      return;
    }
    const icon = decision.severity === 'huge'
      ? '$(error)'
      : decision.severity === 'noisy'
        ? '$(package)'
        : '$(warning)';
    this.pill.text = `${icon} ${decision.pillLabel}`;
    const md = new vscode.MarkdownString(`**GitSight: ${decision.summary}**\n\n${decision.detail.replace(/\n/g, '  \n')}\n\nClick to review.`);
    md.isTrusted = false;
    this.pill.tooltip = md;
    this.pill.backgroundColor = decision.severity === 'huge'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : new vscode.ThemeColor('statusBarItem.warningBackground');
    this.pill.show();

    // Diagnostic surface — attach to a virtual URI keyed by the repo so
    // the Problems panel can list the entry.
    this.diagnostics.clear();
    const uri = vscode.Uri.parse(`gitsight-diffsize:${repo}/STAGED`);
    const range = new vscode.Range(0, 0, 0, 0);
    const severity = decision.severity === 'huge'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
    const diag = new vscode.Diagnostic(range, decision.summary, severity);
    diag.source = 'GitSight';
    diag.code = 'gitsight.diffSize';
    this.diagnostics.set(uri, [diag]);
  }

  private async showPicker(): Promise<void> {
    if (!this.latest) {
      await this.tick();
    }
    const state = this.latest;
    if (!state || state.decision.severity === 'ok') {
      vscode.window.showInformationMessage('GitSight: staged diff is healthy.');
      return;
    }
    const { stats, decision, repo } = state;
    type Pk = vscode.QuickPickItem & { _action: 'addp' | 'unstage' | 'numstat' | 'noop' };
    const items: Pk[] = [];
    items.push({
      label: decision.summary,
      kind: vscode.QuickPickItemKind.Separator,
      _action: 'noop',
    } as any);
    items.push({
      label: '$(symbol-text) Open `git add -p` in a terminal',
      description: 'Interactive hunk-by-hunk staging — split a big working tree into focused commits',
      _action: 'addp',
    });
    if (stats.files > 1) {
      items.push({
        label: '$(discard) Unstage some files\u2026',
        description: `Pick which files to remove from staging (${stats.files} currently staged)`,
        _action: 'unstage',
      });
    }
    items.push({
      label: '$(list-unordered) Show per-file numstat',
      description: 'Open a scratch buffer with +/- counts per staged file',
      _action: 'numstat',
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: decision.pillLabel,
      matchOnDescription: true,
    });
    if (!picked) return;
    if (picked._action === 'addp') return this.openAddP(repo);
    if (picked._action === 'unstage') return this.unstagePicker(repo, stats);
    if (picked._action === 'numstat') return this.showNumstat(stats);
  }

  private openAddP(repo: string): void {
    const term = vscode.window.createTerminal({ name: 'git add -p', cwd: repo });
    term.show();
    term.sendText('git add -p', false);
  }

  private async unstagePicker(repo: string, stats: DiffSizeStats): Promise<void> {
    const git = this.repos.primary();
    if (!git) return;
    type Pk = vscode.QuickPickItem & { _path: string };
    const items: Pk[] = stats.rows
      .slice()
      .sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted))
      .map(r => ({
        label: r.path,
        description: r.isBinary ? 'binary' : `+${r.added} -${r.deleted}`,
        _path: r.path,
      }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Pick the files to unstage (largest first)',
      matchOnDescription: true,
    });
    if (!picked || !picked.length) return;
    const paths = picked.map(p => p._path);
    try {
      await git.raw(['reset', 'HEAD', '--', ...paths]);
      vscode.window.setStatusBarMessage(
        `GitSight: unstaged ${paths.length} file${paths.length === 1 ? '' : 's'}`,
        3000,
      );
      void repo;
      void vscode.commands.executeCommand('gitsight.refresh');
      await this.tick();
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: unstage failed: ${e.message ?? e}`);
    }
  }

  private async showNumstat(stats: DiffSizeStats): Promise<void> {
    const rows = stats.rows.slice().sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
    const lines: string[] = [];
    lines.push(`# Staged diff (${stats.files} files, +${stats.added} / -${stats.deleted})`);
    lines.push('');
    lines.push('| Added | Deleted | Path |');
    lines.push('| ---: | ---: | --- |');
    for (const r of rows) {
      const added = r.isBinary ? 'bin' : String(r.added);
      const deleted = r.isBinary ? 'bin' : String(r.deleted);
      lines.push(`| ${added} | ${deleted} | ${r.path} |`);
    }
    if (stats.noisyPaths.length) {
      lines.push('');
      lines.push(`> ${stats.noisyLines} lines (${pct(stats.noisyLines / stats.total)}) are lockfile/generated noise.`);
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') + '\n' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

function readScmInput(): string | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt || !gitExt.isActive) return null;
    const api = gitExt.exports?.getAPI?.(1);
    const repo = api?.repositories?.[0];
    return repo?.inputBox?.value ?? null;
  } catch {
    return null;
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(v: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function pct(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  return `${Math.round(fraction * 100)}%`;
}
