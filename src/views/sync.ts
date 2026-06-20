/**
 * One-Click Sync — fetch + pull + push in a single command, with a dedicated
 * status-bar pill that surfaces ahead/behind counts and clicks back into the
 * sync action.
 *
 * Pull strategy is configurable (ff-only | rebase) via `gitsight.sync.pullMode`.
 * Push is only attempted when the current branch has an upstream; otherwise we
 * offer to set one with `--set-upstream origin <branch>`.
 *
 * The pill polls every 60 seconds and on RepoManager change events.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';

export type PullMode = 'ff-only' | 'rebase';

async function pullModeFor(): Promise<PullMode> {
  const v = vscode.workspace.getConfiguration('gitsight').get<string>('sync.pullMode', 'ff-only');
  return v === 'rebase' ? 'rebase' : 'ff-only';
}

/** Returns ahead/behind vs the configured upstream, or undefined if there is none. */
async function aheadBehind(git: Git): Promise<{ ahead: number; behind: number; upstream?: string } | undefined> {
  try {
    const upstream = (await git.raw(['rev-parse', '--abbrev-ref', '@{u}'])).trim();
    if (!upstream) return undefined;
    const out = (await git.raw(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim();
    const [behindStr, aheadStr] = out.split(/\s+/);
    return { ahead: +aheadStr || 0, behind: +behindStr || 0, upstream };
  } catch {
    return undefined;
  }
}

export async function runSync(git: Git): Promise<{ ok: boolean; message: string }> {
  const branch = (await git.currentBranch()).trim();
  if (!branch || branch === 'HEAD') {
    return { ok: false, message: 'Detached HEAD — sync needs a named branch.' };
  }

  const mode = await pullModeFor();
  let pulled = false, pushed = false, didSetUpstream = false;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: sync ${branch}`, cancellable: false },
      async progress => {
        progress.report({ message: 'fetching…' });
        await git.raw(['fetch', '--prune', '--all']);

        progress.report({ message: `pulling (${mode})…` });
        const upstream = await aheadBehind(git);
        if (upstream && upstream.behind > 0) {
          if (mode === 'rebase') {
            await git.raw(['pull', '--rebase', '--autostash']);
          } else {
            await git.raw(['pull', '--ff-only']);
          }
          pulled = true;
        }

        progress.report({ message: 'pushing…' });
        const after = await aheadBehind(git);
        if (!after) {
          // No upstream — offer to set it
          const ok = await vscode.window.showInformationMessage(
            `Branch '${branch}' has no upstream. Push and set 'origin/${branch}' as upstream?`,
            { modal: false },
            'Push and set upstream',
          );
          if (ok === 'Push and set upstream') {
            await git.raw(['push', '--set-upstream', 'origin', branch]);
            didSetUpstream = true; pushed = true;
          }
        } else if (after.ahead > 0) {
          await git.raw(['push', 'origin', branch]);
          pushed = true;
        }
      },
    );

    const parts: string[] = [];
    if (pulled) parts.push(`pulled (${mode})`);
    if (pushed) parts.push(didSetUpstream ? `pushed + set upstream` : `pushed`);
    if (!parts.length) parts.push('already in sync');
    return { ok: true, message: parts.join(' · ') };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

export class SyncStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    this.item.command = 'gitsight.sync';
    this.disposables.push(
      this.item,
      repos.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.sync')) this.refresh();
      }),
    );
    this.timer = setInterval(() => this.refresh(), 60_000);
    this.refresh();
  }

  async refresh() {
    const cfg = vscode.workspace.getConfiguration('gitsight.sync');
    if (!cfg.get<boolean>('pill.enabled', true)) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    try {
      const branch = (await git.currentBranch()).trim();
      const ab = await aheadBehind(git);
      let icon = '$(sync)';
      let txt = `${icon} sync`;
      let tooltip = `GitSight: sync ${branch}\n`;
      if (!ab) {
        icon = '$(arrow-up)';
        txt = `${icon} ${branch} (no upstream)`;
        tooltip += 'Branch has no upstream. Click to push and set it.';
      } else if (ab.ahead === 0 && ab.behind === 0) {
        icon = '$(check)';
        txt = `${icon} ${branch}`;
        tooltip += 'Up to date with ' + ab.upstream;
      } else {
        const bits: string[] = [];
        if (ab.ahead) bits.push(`↑${ab.ahead}`);
        if (ab.behind) bits.push(`↓${ab.behind}`);
        icon = ab.behind ? '$(arrow-down)' : '$(arrow-up)';
        txt = `${icon} ${bits.join(' ')}`;
        tooltip += `Upstream: ${ab.upstream}\nAhead ${ab.ahead}, behind ${ab.behind}. Click to sync.`;
      }
      this.item.text = txt;
      this.item.tooltip = tooltip;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
