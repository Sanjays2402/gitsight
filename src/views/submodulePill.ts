/**
 * Submodule Status Pill (F59) — when the workspace has submodules, surface
 * "$(repo-forked) N \u00b7 in sync" or "$(repo-forked) N \u00b7 M out \u00b7 K not init"
 * in the status bar.
 *
 * Click \u2192 picker with:
 *   - Run `git submodule update --init --recursive`
 *   - Run `git submodule update --remote --merge`
 *   - Open each submodule's path in the explorer
 *   - Copy the submodule status block (for bug reports / chat)
 *
 * Refreshes on RepoManager change + a 30s timer (submodule status is one
 * shell call but it walks the recursive tree, so we don't want to hammer
 * it; 30s matches the cadence of other recursive-walk pills).
 *
 * Configurable via:
 *   gitsight.submodules.enabled        (default true)
 *   gitsight.submodules.hideWhenNone   (default true) \u2014 hide entirely if
 *                                                       the repo has zero
 *                                                       submodules
 *   gitsight.submodules.recursive      (default true) \u2014 pass --recursive
 *                                                       to status (nested
 *                                                       submodules)
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseSubmoduleStatus,
  summariseSubmodules,
  formatPillLabel,
  pillSeverity,
  formatTooltipMarkdown,
  Submodule,
} from '../git/submodules';
import * as path from 'path';

export class SubmodulePill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private latest: Submodule[] = [];

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    this.item.command = 'gitsight.submoduleMenu';
    this.disposables.push(
      this.item,
      repos.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.submodules')) this.refresh();
      }),
    );
    this.timer = setInterval(() => this.refresh(), 30_000);
    this.refresh();
  }

  async refresh(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.submodules');
    if (!cfg.get<boolean>('enabled', true)) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    try {
      const subs = await loadSubmodules(git, cfg.get<boolean>('recursive', true));
      this.latest = subs;
      const summary = summariseSubmodules(subs);
      if (summary.total === 0) {
        if (cfg.get<boolean>('hideWhenNone', true)) { this.item.hide(); return; }
        this.item.text = '$(repo-forked) no submodules';
        this.item.tooltip = new vscode.MarkdownString('**GitSight: Submodules**  \nNo submodules in this workspace.');
        this.item.backgroundColor = undefined;
        this.item.show();
        return;
      }
      this.item.text = formatPillLabel(summary);
      const severity = pillSeverity(summary);
      this.item.backgroundColor = severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : severity === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      const md = new vscode.MarkdownString(`**GitSight: Submodules**\n\n${formatTooltipMarkdown(subs)}\n\nClick for actions.`);
      md.isTrusted = false;
      this.item.tooltip = md;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  getLatest(): Submodule[] { return this.latest; }

  dispose(): void {
    clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}

export async function showSubmoduleMenu(git: Git, subs: Submodule[]): Promise<void> {
  type Pk = vscode.QuickPickItem & {
    _action?: 'init' | 'remote-merge' | 'foreach-status' | 'copy-status';
    _path?: string;
  };
  const summary = summariseSubmodules(subs);
  if (summary.total === 0) {
    vscode.window.showInformationMessage('GitSight: no submodules in this workspace.');
    return;
  }
  const items: Pk[] = [];
  if (summary.uninitialised > 0) {
    items.push({
      label: '$(plug) Init + update all submodules',
      description: `git submodule update --init --recursive (${summary.uninitialised} not initialised)`,
      _action: 'init',
    });
  }
  if (summary.outOfSync > 0 || summary.uninitialised > 0) {
    items.push({
      label: '$(sync) Update to remote tips (merge)',
      description: 'git submodule update --remote --merge',
      _action: 'remote-merge',
    });
  }
  items.push({
    label: '$(list-tree) Run status in each submodule',
    description: 'git submodule foreach git status -s (output in a scratch buffer)',
    _action: 'foreach-status',
  });
  items.push({
    label: '$(copy) Copy submodule status',
    description: 'puts the status block on the clipboard',
    _action: 'copy-status',
  });
  items.push({ label: 'Submodules', kind: vscode.QuickPickItemKind.Separator } as Pk);
  for (const sub of subs) {
    const stateLabel = ({
      'in-sync': 'in sync',
      'out-of-sync': 'out of sync',
      'uninitialised': 'not initialised',
      'conflicted': 'conflict',
      'unknown': 'unknown',
    } as const)[sub.state];
    items.push({
      label: `$(repo) ${sub.path}`,
      description: `[${stateLabel}] ${sub.sha.slice(0, 7)}${sub.describe ? ` \u00b7 ${sub.describe}` : ''}`,
      _path: sub.path,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${summary.total} submodule${summary.total === 1 ? '' : 's'} \u00b7 pick an action or a submodule to open`,
    matchOnDescription: true,
  });
  if (!picked) return;

  if (picked._action === 'init') return runSubmoduleCommand(git, ['submodule', 'update', '--init', '--recursive']);
  if (picked._action === 'remote-merge') return runSubmoduleCommand(git, ['submodule', 'update', '--remote', '--merge']);
  if (picked._action === 'foreach-status') return openForeachStatus(git);
  if (picked._action === 'copy-status') return copyStatus(git);
  if (picked._path) {
    const abs = path.join(git.cwd, picked._path);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(abs), { forceNewWindow: true });
  }
}

async function runSubmoduleCommand(git: Git, args: string[]): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: git ${args.join(' ')}\u2026` },
    async () => {
      try {
        await git.raw(args);
        vscode.window.showInformationMessage(`GitSight: ${args.join(' ')} complete.`);
        vscode.commands.executeCommand('gitsight.refresh');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${args.join(' ')} failed: ${(e.message ?? e).toString().trim().split('\n')[0]}`);
      }
    },
  );
}

async function openForeachStatus(git: Git): Promise<void> {
  try {
    const out = await git.raw(['submodule', 'foreach', '--recursive', 'git status -s -b']);
    const doc = await vscode.workspace.openTextDocument({
      content: out || '# all submodules clean',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: submodule foreach failed: ${e.message ?? e}`);
  }
}

async function copyStatus(git: Git): Promise<void> {
  try {
    const out = await git.raw(['submodule', 'status', '--recursive']);
    await vscode.env.clipboard.writeText(out || '(no submodules)');
    vscode.window.setStatusBarMessage('GitSight: submodule status copied.', 3000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: copy failed: ${e.message ?? e}`);
  }
}

async function loadSubmodules(git: Git, recursive: boolean): Promise<Submodule[]> {
  const args = ['submodule', 'status'];
  if (recursive) args.push('--recursive');
  try {
    const raw = await git.raw(args);
    return parseSubmoduleStatus(raw);
  } catch {
    return [];
  }
}
