/**
 * Lockfile Change Watcher (F28).
 *
 * Watches `RepoManager.onDidChange` (which fires when refs move under
 * `.git/`) and, when HEAD moves, runs `git diff --name-only HEAD@{1}..HEAD`
 * to see which files just landed. If any of them are well-known lockfiles
 * (package-lock.json, pnpm-lock.yaml, Cargo.lock, go.sum, …) we surface a
 * single non-modal notification with one-click "Run install" actions.
 *
 * Why HEAD@{1}..HEAD rather than `git status`: this catches the pull / merge
 * / rebase / branch-switch case (the user didn't *make* the change, they
 * *received* it) without nagging about edits the user typed themselves.
 *
 * Configurable via `gitsight.lockfileWatch.enabled` (default true).
 * Debounced 1500ms so a multi-step rebase only fires one toast at the end.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  findChangedLockfiles,
  classifyLockfile,
  aggregateInstallCommands,
  summariseChanged,
  LockfileEntry,
} from '../git/lockfileWatch';

export class LockfileWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;
  /** Last HEAD SHA we observed per repo root. */
  private lastHead = new Map<string, string>();
  /** Don't re-prompt for the exact same set of lockfiles within 5 minutes. */
  private cooldown = new Map<string, number>();
  private static COOLDOWN_MS = 5 * 60 * 1000;

  constructor(private repos: RepoManager) {
    this.disposables.push(
      repos.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.lockfileWatch')) this.schedule();
      }),
    );
    // Prime the lastHead cache so the *next* HEAD move triggers a check,
    // not the initial workspace load (which would be noisy).
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
    const cfg = vscode.workspace.getConfiguration('gitsight.lockfileWatch');
    if (!cfg.get<boolean>('enabled', true)) return;
    for (const git of this.repos.all()) {
      try {
        await this.checkRepo(git);
      } catch {
        // Per-repo failures shouldn't poison the watcher loop.
      }
    }
  }

  private async checkRepo(git: Git) {
    const head = (await safe(git, ['rev-parse', 'HEAD'])).trim();
    if (!head) return;
    const prev = this.lastHead.get(git.cwd);
    if (!prev) { this.lastHead.set(git.cwd, head); return; }
    if (prev === head) return;
    this.lastHead.set(git.cwd, head);

    // Which files moved between the two HEADs? --name-only is cheap.
    const diff = await safe(git, ['diff', '--name-only', `${prev}..${head}`]);
    const changed: LockfileEntry[] = [];
    for (const path of diff.split('\n')) {
      const trimmed = path.trim();
      if (!trimmed) continue;
      const cls = classifyLockfile(trimmed);
      if (cls) changed.push(cls);
    }
    if (!changed.length) return;

    // Cooldown by the exact set of lockfile paths so we don't spam the same
    // toast on every rebase step.
    const key = `${git.cwd}::${changed.map(c => c.path).sort().join('|')}`;
    const last = this.cooldown.get(key) ?? 0;
    if (Date.now() - last < LockfileWatcher.COOLDOWN_MS) return;
    this.cooldown.set(key, Date.now());

    this.surfaceToast(git, changed);
  }

  private async surfaceToast(git: Git, entries: LockfileEntry[]) {
    // Build action labels. Cap at three per-toast actions (VS Code renders
    // them as buttons; more than three becomes a dropdown which feels worse
    // than the implicit "use the full picker" fallback).
    const aggregated = aggregateInstallCommands(entries);
    const buttons: string[] = aggregated.slice(0, 2);
    buttons.push('Show all');
    const picked = await vscode.window.showInformationMessage(
      `GitSight: ${summariseChanged(entries)}`,
      { modal: false },
      ...buttons,
    );
    if (!picked) return;
    if (picked === 'Show all') {
      return this.fullPicker(git, entries);
    }
    // Otherwise treat the picked button as one of the install commands —
    // run it in the integrated terminal scoped to the right cwd.
    const repoRoot = git.cwd;
    const folder = pickFolderFor(entries, picked, repoRoot);
    runInTerminal(picked, folder);
  }

  private async fullPicker(git: Git, entries: LockfileEntry[]) {
    type Pk = vscode.QuickPickItem & { _cmd?: string; _cwd?: string };
    const items: Pk[] = [];
    for (const e of entries) {
      const cwd = subdirOf(e.path, git.cwd);
      items.push({
        label: e.path,
        kind: vscode.QuickPickItemKind.Separator,
      });
      for (const cmd of e.installCommands) {
        items.push({
          label: `$(terminal) ${cmd}`,
          description: e.ecosystem,
          detail: cwd === git.cwd ? 'repo root' : cwd.replace(git.cwd + '/', ''),
          _cmd: cmd,
          _cwd: cwd,
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Pick an install command to run',
      matchOnDescription: true,
    });
    if (!picked || !picked._cmd) return;
    runInTerminal(picked._cmd, picked._cwd ?? git.cwd);
  }

  dispose() {
    if (this.debounce) clearTimeout(this.debounce);
    this.disposables.forEach(d => d.dispose());
  }
}

function pickFolderFor(entries: LockfileEntry[], chosenCmd: string, repoRoot: string): string {
  // The aggregated command came from the *first* entry whose first install
  // command equals chosenCmd. Run from that lockfile's directory so nested
  // lockfiles get the right cwd.
  const match = entries.find(e => e.installCommands[0] === chosenCmd);
  if (!match) return repoRoot;
  return subdirOf(match.path, repoRoot);
}

function subdirOf(lockfilePath: string, repoRoot: string): string {
  const i = lockfilePath.lastIndexOf('/');
  if (i < 0) return repoRoot;
  return `${repoRoot}/${lockfilePath.slice(0, i)}`;
}

function runInTerminal(cmd: string, cwd: string) {
  const term = vscode.window.createTerminal({ name: `GitSight: ${cmd}`, cwd });
  term.show();
  term.sendText(cmd);
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
