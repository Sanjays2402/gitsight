/**
 * Submodule Auto-Pull Watcher (F70).
 *
 * Passive controller, mirroring the F28 LockfileWatcher shape: hooks
 * `RepoManager.onDidChange` (which fires on `.git/` ref moves), debounces
 * 1500ms, then for each repo whose HEAD moved between ticks runs
 * `git diff --raw -z <prev>..<head>` and looks for submodule gitlink
 * changes. If any are found, surface a non-modal toast with one-click
 * update actions.
 *
 * Configurable via:
 *   gitsight.submoduleAutoPull.enabled  (default true)
 *   gitsight.submoduleAutoPull.cooldownMinutes (default 5)
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseGitlinkChanges,
  summariseGitlinkChanges,
  suggestUpdateActions,
  cooldownKey,
  SubmoduleGitlinkChange,
  UpdateAction,
} from '../git/submoduleAutoPull';

export class SubmoduleAutoPullWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;
  private lastHead = new Map<string, string>();
  private cooldown = new Map<string, number>();

  constructor(private repos: RepoManager) {
    this.disposables.push(
      repos.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.submoduleAutoPull')) this.schedule();
      }),
    );
    queueMicrotask(() => this.primeHeads());
  }

  private async primeHeads() {
    for (const git of this.repos.all()) {
      const head = await safe(git, ['rev-parse', 'HEAD']);
      this.lastHead.set(git.cwd, head.trim());
    }
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.tick().catch(() => {}), 1500);
  }

  private async tick() {
    const cfg = vscode.workspace.getConfiguration('gitsight.submoduleAutoPull');
    if (!cfg.get<boolean>('enabled', true)) return;
    for (const git of this.repos.all()) {
      try { await this.checkRepo(git); }
      catch { /* per-repo failures shouldn't poison the loop */ }
    }
  }

  private async checkRepo(git: Git) {
    // Cheap pre-filter: skip repos that don't have submodules at all.
    const has = await safe(git, ['config', '--file', `${git.cwd}/.gitmodules`, '--get-regexp', '^submodule\\.']);
    if (!has.trim()) return;

    const head = (await safe(git, ['rev-parse', 'HEAD'])).trim();
    if (!head) return;
    const prev = this.lastHead.get(git.cwd);
    if (!prev) { this.lastHead.set(git.cwd, head); return; }
    if (prev === head) return;
    this.lastHead.set(git.cwd, head);

    const raw = await safe(git, ['diff', '--raw', '-z', `${prev}..${head}`]);
    const changes = parseGitlinkChanges(raw);
    if (!changes.length) return;

    const cfg = vscode.workspace.getConfiguration('gitsight.submoduleAutoPull');
    const cooldownMs = clamp(cfg.get<number>('cooldownMinutes', 5) ?? 5, 1, 1440) * 60_000;
    const key = cooldownKey(git.cwd, changes);
    const last = this.cooldown.get(key) ?? 0;
    if (Date.now() - last < cooldownMs) return;
    this.cooldown.set(key, Date.now());

    await this.surfaceToast(git, changes);
  }

  private async surfaceToast(git: Git, changes: SubmoduleGitlinkChange[]) {
    const actions = suggestUpdateActions(changes);
    const buttons = actions.slice(0, 2).map(a => a.label);
    buttons.push('Show all');
    const picked = await vscode.window.showInformationMessage(
      `GitSight: ${summariseGitlinkChanges(changes)}`,
      { modal: false },
      ...buttons,
    );
    if (!picked) return;
    if (picked === 'Show all') return this.fullPicker(git, changes, actions);
    const match = actions.find(a => a.label === picked);
    if (match) await runUpdate(git, match);
  }

  private async fullPicker(git: Git, changes: SubmoduleGitlinkChange[], actions: UpdateAction[]) {
    type Pk = vscode.QuickPickItem & { _action?: UpdateAction; _path?: string };
    const items: Pk[] = [];
    items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator } as Pk);
    for (const a of actions) {
      items.push({
        label: `$(plug) ${a.label}`,
        detail: `git ${a.args.join(' ')}`,
        _action: a,
      });
    }
    items.push({ label: 'Changes', kind: vscode.QuickPickItemKind.Separator } as Pk);
    for (const c of changes) {
      items.push({
        label: `$(repo) ${c.path}`,
        description: `${c.status}${c.prevSha ? `  \u00b7  ${c.prevSha.slice(0, 7)}` : ''}${c.newSha ? ` \u2192 ${c.newSha.slice(0, 7)}` : ''}`,
        _path: c.path,
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${changes.length} submodule change${changes.length === 1 ? '' : 's'} \u00b7 pick an action or a submodule to open`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked._action) return runUpdate(git, picked._action);
    if (picked._path) {
      const abs = `${git.cwd}/${picked._path}`;
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(abs));
    }
  }

  dispose() {
    if (this.debounce) clearTimeout(this.debounce);
    this.disposables.forEach(d => d.dispose());
  }
}

async function runUpdate(git: Git, action: UpdateAction): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: git ${action.args.join(' ')}\u2026` },
    async () => {
      try {
        await git.raw(action.args);
        vscode.window.showInformationMessage(`GitSight: ${action.label} \u2014 done.`);
        vscode.commands.executeCommand('gitsight.refresh');
        vscode.commands.executeCommand('gitsight.refreshSubmodules');
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${action.label} failed: ${(e.message ?? e).toString().trim().split('\n')[0]}`);
      }
    },
  );
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
