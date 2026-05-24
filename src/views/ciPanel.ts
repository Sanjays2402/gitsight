import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { parseRemote } from '../git/hostDetect';

const pexec = promisify(execFile);

interface Run {
  id: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out';
  branch: string;
  url: string;
  createdAt: Date;
  durationSec?: number;
}

export class CiPanel implements vscode.Disposable {
  private status: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private lastRuns: Run[] = [];
  private kind: 'github' | 'azure-devops' | 'none' = 'none';

  constructor(private readonly getGit: () => Git | undefined) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    this.status.command = 'gitsight.ciShow';
    this.disposables.push(this.status);
    this.poll();
    this.timer = setInterval(() => this.poll(), 60_000);
  }

  dispose() { if (this.timer) clearInterval(this.timer); this.disposables.forEach(d => d.dispose()); }

  private async poll() {
    const git = this.getGit(); if (!git) { this.status.hide(); return; }
    const remotes = await git.remotes().catch(() => []);
    const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
    const info = origin && parseRemote(origin.fetchUrl);
    if (!info) { this.status.hide(); return; }
    try {
      if (info.host === 'github') {
        this.kind = 'github';
        this.lastRuns = await fetchGitHubRuns(git.cwd);
      } else if (info.host === 'azure-devops') {
        this.kind = 'azure-devops';
        this.lastRuns = await fetchAzureRuns(git.cwd, info.owner, info.project!, info.repo);
      } else {
        this.status.hide(); return;
      }
      this.updateStatus();
    } catch {
      this.status.hide();
    }
  }

  private updateStatus() {
    if (!this.lastRuns.length) { this.status.hide(); return; }
    const latest = this.lastRuns[0];
    const icon = iconFor(latest);
    this.status.text = `${icon} CI ${latest.name.slice(0, 24)}`;
    this.status.tooltip = `${this.kind === 'github' ? 'GitHub Actions' : 'Azure Pipelines'}\n${latest.name} → ${latest.status}${latest.conclusion ? ` (${latest.conclusion})` : ''}\nClick for full list.`;
    if (latest.conclusion === 'failure') {
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (latest.status === 'in_progress' || latest.status === 'queued') {
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.status.backgroundColor = undefined;
    }
    this.status.show();
  }

  async show() {
    if (!this.lastRuns.length) {
      await this.poll();
      if (!this.lastRuns.length) return vscode.window.showInformationMessage('No CI runs found.');
    }
    type Item = vscode.QuickPickItem & { _url?: string };
    const items: Item[] = this.lastRuns.map(r => ({
      label: `${iconFor(r)} ${r.name}`,
      description: `${r.branch} · ${r.status}${r.conclusion ? `/${r.conclusion}` : ''}${r.durationSec ? ` · ${Math.round(r.durationSec)}s` : ''}`,
      detail: r.createdAt.toLocaleString(),
      _url: r.url,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${this.kind === 'github' ? 'GitHub Actions' : 'Azure Pipelines'} runs (newest first)`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked?._url) vscode.env.openExternal(vscode.Uri.parse(picked._url));
  }

  async refresh() { await this.poll(); vscode.window.showInformationMessage('CI status refreshed.'); }
}

function iconFor(r: Run): string {
  if (r.status === 'in_progress') return '$(sync~spin)';
  if (r.status === 'queued') return '$(clock)';
  if (r.conclusion === 'success') return '$(check)';
  if (r.conclusion === 'failure') return '$(error)';
  if (r.conclusion === 'cancelled') return '$(circle-slash)';
  return '$(circle-large-outline)';
}

async function fetchGitHubRuns(cwd: string): Promise<Run[]> {
  const { stdout } = await pexec('gh', [
    'run', 'list', '--limit', '20',
    '--json', 'databaseId,name,status,conclusion,headBranch,url,createdAt,updatedAt',
  ], { cwd });
  const raw = JSON.parse(stdout);
  return raw.map((r: any) => ({
    id: String(r.databaseId),
    name: r.name || 'workflow',
    status: r.status,
    conclusion: r.conclusion || undefined,
    branch: r.headBranch,
    url: r.url,
    createdAt: new Date(r.createdAt),
    durationSec: r.updatedAt ? (new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000 : undefined,
  }));
}

async function fetchAzureRuns(cwd: string, org: string, project: string, repo: string): Promise<Run[]> {
  const { stdout } = await pexec('az', [
    'pipelines', 'runs', 'list', '--top', '20',
    '--org', `https://dev.azure.com/${org}`, '--project', project, '--output', 'json',
  ], { cwd });
  const raw = JSON.parse(stdout);
  return raw.map((r: any) => ({
    id: String(r.id),
    name: r.definition?.name || 'pipeline',
    status: r.status === 'completed' ? 'completed' : r.status === 'inProgress' ? 'in_progress' : 'queued',
    conclusion: r.result === 'succeeded' ? 'success' : r.result === 'failed' ? 'failure' : r.result === 'canceled' ? 'cancelled' : undefined,
    branch: r.sourceBranch?.replace('refs/heads/', '') ?? '',
    url: `https://dev.azure.com/${org}/${project}/_build/results?buildId=${r.id}`,
    createdAt: new Date(r.queueTime ?? r.startTime ?? Date.now()),
    durationSec: r.finishTime && r.startTime ? (new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()) / 1000 : undefined,
  }));
}
