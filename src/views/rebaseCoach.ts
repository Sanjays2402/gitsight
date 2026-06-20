/**
 * Smart Rebase Conflict Coach (F10) — detects an in-progress rebase, surfaces a
 * status-bar pill with step counter + conflict count, and offers a quick-pick of
 * the only sensible next actions: edit a conflict, mark as resolved + continue,
 * skip the current commit, or abort.
 *
 * The pill auto-hides when no rebase is in progress, and updates on:
 *   - RepoManager change events (which include .git/refs + REBASE_HEAD + index)
 *   - a 4s poll fallback (cheap: at most two file reads + one `git status`)
 *
 * Pure detection lives in src/git/rebaseState.ts so the entire decision tree is
 * unit-testable; the controller only owns vscode plumbing and shell execution.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  parseRebaseState,
  parseConflictedFiles,
  shortRebaseLabel,
  describeRebase,
  RebaseState,
} from '../git/rebaseState';

const REBASE_MERGE_FILES = ['msgnum', 'end', 'head-name', 'head', 'interactive', 'stopped-sha'];
const REBASE_APPLY_FILES = ['next', 'last', 'head-name', 'apply-mailbox'];

interface Snapshot { state: RebaseState; conflicts: string[]; gitDir: string; }

async function readGitDir(git: Git): Promise<string> {
  const out = await git.raw(['rev-parse', '--git-dir']);
  const rel = out.trim();
  return path.isAbsolute(rel) ? rel : path.resolve(git.cwd, rel);
}

async function readSnapshot(git: Git): Promise<Snapshot | undefined> {
  const gitDir = await readGitDir(git);
  const mergeDir = path.join(gitDir, 'rebase-merge');
  const applyDir = path.join(gitDir, 'rebase-apply');
  const contents: Record<string, string | undefined> = {};
  // Try rebase-merge first (covers `-i` and `--merge`).
  for (const f of REBASE_MERGE_FILES) {
    try { contents[f] = await fs.readFile(path.join(mergeDir, f), 'utf8'); } catch { /* missing */ }
  }
  if (Object.keys(contents).length === 0) {
    for (const f of REBASE_APPLY_FILES) {
      try { contents[f] = await fs.readFile(path.join(applyDir, f), 'utf8'); } catch { /* missing */ }
    }
  }
  const state = parseRebaseState(contents);
  if (!state) return undefined;
  let conflicts: string[] = [];
  try { conflicts = parseConflictedFiles(await git.raw(['status', '--porcelain'])); } catch { /* ignore */ }
  return { state, conflicts, gitDir };
}

export class RebaseCoach implements vscode.Disposable {
  private pill: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private last?: Snapshot;

  constructor(private repos: RepoManager) {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    this.pill.command = 'gitsight.rebaseCoach';
    this.disposables.push(
      this.pill,
      repos.onDidChange(() => this.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.rebaseCoach')) this.refresh();
      }),
    );
    this.timer = setInterval(() => this.refresh(), 4_000);
    this.refresh();
  }

  async refresh() {
    const cfg = vscode.workspace.getConfiguration('gitsight.rebaseCoach');
    if (!cfg.get<boolean>('enabled', true)) { this.pill.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.pill.hide(); return; }
    try {
      const snap = await readSnapshot(git);
      if (!snap) { this.last = undefined; this.pill.hide(); return; }
      this.last = snap;
      const conf = snap.conflicts.length;
      const icon = conf ? '$(warning)' : '$(git-merge)';
      this.pill.text = `${icon} ${shortRebaseLabel(snap.state)}${conf ? ` · ${conf} conflict${conf === 1 ? '' : 's'}` : ''}`;
      this.pill.tooltip = new vscode.MarkdownString(
        `**GitSight: Rebase coach**  \n${describeRebase(snap.state, conf)}\n\nClick for next actions.`,
      );
      this.pill.backgroundColor = conf
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      this.pill.show();
    } catch {
      this.pill.hide();
    }
  }

  /** Quick-pick of the next sensible actions during a rebase. */
  async showMenu() {
    const git = this.repos.primary();
    if (!git) { vscode.window.showWarningMessage('GitSight: no Git repo.'); return; }
    const snap = await readSnapshot(git);
    if (!snap) {
      vscode.window.showInformationMessage('GitSight: no rebase in progress.');
      return;
    }
    type Item = vscode.QuickPickItem & {
      _action?: 'continue' | 'skip' | 'abort' | 'edit' | 'stage-all';
      _file?: string;
    };
    const items: Item[] = [];
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, description: describeRebase(snap.state, snap.conflicts.length) });
    if (snap.conflicts.length) {
      for (const f of snap.conflicts) {
        items.push({ label: `$(warning) ${f}`, description: 'Open in editor', _action: 'edit', _file: f });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: '$(check-all) Stage all resolved files', description: 'git add -u', _action: 'stage-all' });
    }
    items.push({ label: '$(debug-continue) Continue', description: 'git rebase --continue', _action: 'continue' });
    items.push({ label: '$(debug-step-over) Skip this commit', description: 'git rebase --skip', _action: 'skip' });
    items.push({ label: '$(stop-circle) Abort rebase', description: 'git rebase --abort  ·  returns to start', _action: 'abort' });

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: snap.conflicts.length
        ? `${snap.conflicts.length} conflict${snap.conflicts.length === 1 ? '' : 's'} — pick a file to open or an action`
        : 'No conflicts — pick an action',
      matchOnDescription: true,
    });
    if (!pick?._action) return;
    switch (pick._action) {
      case 'edit': {
        if (!pick._file) return;
        const uri = vscode.Uri.file(path.join(git.cwd, pick._file));
        await vscode.commands.executeCommand('vscode.open', uri);
        break;
      }
      case 'stage-all': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'GitSight: staging resolved files…' },
          async () => {
            try {
              await git.raw(['add', '-u']);
              vscode.window.setStatusBarMessage('GitSight: resolved files staged.', 2500);
              this.refresh();
            } catch (e: any) {
              vscode.window.showErrorMessage(`GitSight: ${e.message}`);
            }
          },
        );
        break;
      }
      case 'continue': {
        if (snap.conflicts.length) {
          const ans = await vscode.window.showWarningMessage(
            `${snap.conflicts.length} file${snap.conflicts.length === 1 ? '' : 's'} still unresolved. Continue anyway?`,
            { modal: true },
            'Continue',
          );
          if (ans !== 'Continue') return;
        }
        await runRebase(git, ['--continue']);
        this.refresh();
        vscode.commands.executeCommand('gitsight.refresh');
        break;
      }
      case 'skip': {
        const ans = await vscode.window.showWarningMessage(
          'Skip the current commit during rebase?', { modal: true }, 'Skip',
        );
        if (ans !== 'Skip') return;
        await runRebase(git, ['--skip']);
        this.refresh();
        vscode.commands.executeCommand('gitsight.refresh');
        break;
      }
      case 'abort': {
        const ans = await vscode.window.showWarningMessage(
          'Abort rebase and return to the starting state?', { modal: true }, 'Abort',
        );
        if (ans !== 'Abort') return;
        await runRebase(git, ['--abort']);
        this.refresh();
        vscode.commands.executeCommand('gitsight.refresh');
        break;
      }
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}

async function runRebase(git: Git, args: string[]) {
  try {
    await git.raw(['rebase', ...args]);
  } catch (e: any) {
    // Rebase commands return non-zero on conflict / no-op — surface but don't block.
    vscode.window.showWarningMessage(`GitSight rebase ${args[0]}: ${e.message}`);
  }
}
