import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import { parseRemote } from '../git/hostDetect';

const pexec = promisify(execFile);

export interface Issue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  author: string;
  createdAt: Date;
  updatedAt: Date;
  url: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  comments: number;
  isPullRequest?: boolean;
}

export class IssuesProvider implements vscode.TreeDataProvider<IssueItem> {
  private _change = new vscode.EventEmitter<IssueItem | void>();
  onDidChangeTreeData = this._change.event;
  private issues: Issue[] = [];
  private loading = false;
  private error?: string;
  private filter: 'all' | 'assigned' | 'created' = 'all';

  constructor(private getGit: () => Git | undefined) {}

  refresh(): void { this.issues = []; this.error = undefined; this.load(); }
  setFilter(f: 'all' | 'assigned' | 'created') { this.filter = f; this.refresh(); }

  async load() {
    const git = this.getGit();
    if (!git) { this.error = 'No Git repo.'; this._change.fire(); return; }
    this.loading = true; this._change.fire();
    try {
      const remotes = await git.remotes().catch(() => []);
      const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
      const info = origin && parseRemote(origin.fetchUrl);
      if (!info || info.host !== 'github') {
        this.error = 'GitHub Issues currently only supported for GitHub remotes.';
        return;
      }
      const args = ['issue', 'list', '--limit', '40', '--state', 'all',
        '--json', 'number,title,state,author,createdAt,updatedAt,url,labels,assignees,comments'];
      if (this.filter === 'assigned') args.push('--assignee', '@me');
      else if (this.filter === 'created') args.push('--author', '@me');
      const { stdout } = await pexec('gh', args, { cwd: git.cwd, maxBuffer: 100 * 1024 * 1024 });
      const raw = JSON.parse(stdout);
      this.issues = raw.map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        author: p.author?.login ?? 'unknown',
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
        url: p.url,
        labels: (p.labels ?? []).map((l: any) => ({ name: l.name, color: '#' + (l.color || '888888') })),
        assignees: (p.assignees ?? []).map((a: any) => a.login),
        comments: p.comments ?? 0,
      }));
    } catch (e: any) {
      const msg = (e.stderr || e.message || '').toString();
      this.error = msg.includes('not found') ? 'gh CLI missing. brew install gh && gh auth login' : msg.split('\n')[0].slice(0, 200);
    } finally {
      this.loading = false; this._change.fire();
    }
  }

  getTreeItem(i: IssueItem) { return i; }
  getChildren(parent?: IssueItem): IssueItem[] {
    if (parent) return [];
    if (this.loading) return [new IssueItem('Loading issues…', '', 'loading')];
    if (this.error) return [new IssueItem(`⚠ ${this.error}`, '', 'error')];
    if (!this.issues.length) return [new IssueItem('No issues. Click ↻ to refresh.', '', 'empty')];

    const items: IssueItem[] = [new IssueItem(`Filter: ${this.filter}`, '', 'filter')];
    const open = this.issues.filter(i => i.state === 'OPEN');
    const closed = this.issues.filter(i => i.state === 'CLOSED');

    for (const [name, list] of [['OPEN', open], ['CLOSED', closed]] as const) {
      if (!list.length) continue;
      items.push(new IssueItem(`${name} · ${list.length}`, '', 'group'));
      for (const iss of list) {
        const labelStr = iss.labels.length ? '  ' + iss.labels.map(l => `[${l.name}]`).join(' ') : '';
        const label = `#${iss.number} ${iss.title}${labelStr}`;
        const desc = `${iss.assignees.length ? '@' + iss.assignees[0] + ' · ' : ''}${iss.comments > 0 ? '💬 ' + iss.comments + ' · ' : ''}${timeAgo(iss.updatedAt)}`;
        const it = new IssueItem(label, desc, 'issue', iss);
        it.tooltip = new vscode.MarkdownString([
          `**#${iss.number} ${esc(iss.title)}**`,
          ``,
          `**State:** ${iss.state}`,
          `**Author:** @${iss.author}`,
          `**Updated:** ${iss.updatedAt.toLocaleString()}`,
          iss.assignees.length ? `**Assignees:** ${iss.assignees.map(a => '@' + a).join(', ')}` : '',
          iss.labels.length ? `**Labels:** ${iss.labels.map(l => l.name).join(', ')}` : '',
          `**Comments:** ${iss.comments}`,
          ``,
          `[Open on GitHub →](${iss.url})`,
        ].filter(Boolean).join('\n'));
        items.push(it);
      }
    }
    return items;
  }
}

class IssueItem extends vscode.TreeItem {
  constructor(label: string, description: string, public kind: string, public issue?: Issue) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = `issue-${kind}`;
    if (issue) {
      this.iconPath = new vscode.ThemeIcon(
        issue.state === 'OPEN' ? 'issues' : 'issue-closed',
        new vscode.ThemeColor(issue.state === 'OPEN' ? 'charts.green' : 'charts.purple')
      );
      this.command = { command: 'gitsight.openIssue', title: 'Open Issue', arguments: [issue] };
    } else if (kind === 'group') this.iconPath = new vscode.ThemeIcon('folder');
    else if (kind === 'filter') this.iconPath = new vscode.ThemeIcon('filter');
    else if (kind === 'loading') this.iconPath = new vscode.ThemeIcon('loading~spin');
    else if (kind === 'error') this.iconPath = new vscode.ThemeIcon('warning');
  }
}

const esc = (s: string) => (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));

export async function openIssueWebview(issue: Issue, git: Git) {
  const panel = vscode.window.createWebviewPanel(
    'gitsight.issue', `Issue #${issue.number}`,
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }
  );
  let body = '', comments: any[] = [];
  try {
    const { stdout } = await pexec('gh', ['issue', 'view', String(issue.number), '--json', 'body,comments'],
      { cwd: git.cwd, maxBuffer: 100 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    body = j.body || ''; comments = j.comments || [];
  } catch {/* ignore */}

  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font:13px var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); margin:0; padding:24px; max-width:900px; }
    h1 { font-size:20px; margin:0 0 8px; }
    .meta { color:var(--vscode-descriptionForeground); margin-bottom:16px; font-size:12px; }
    .badge { padding:2px 10px; border-radius:10px; font-size:11px; font-weight:600; margin-right:8px; }
    .b-OPEN { background:#10b98133; color:#4ade80; }
    .b-CLOSED { background:#a855f733; color:#c084fc; }
    .label { padding:2px 8px; border-radius:10px; font-size:11px; margin-right:4px; font-weight:600; color:#000; }
    .body { background:var(--vscode-editorWidget-background); padding:18px; border-radius:6px; white-space:pre-wrap; line-height:1.6; }
    h2 { font-size:14px; margin:24px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--vscode-panel-border); }
    .comment { background:var(--vscode-editorWidget-background); padding:12px 16px; border-radius:6px; margin:8px 0; }
    .comment .who { font-weight:600; margin-bottom:4px; }
    .comment .when { color:var(--vscode-descriptionForeground); font-size:11px; margin-left:8px; }
    a { color:var(--vscode-textLink-foreground); }
  </style></head><body>
    <h1>${esc(issue.title)}</h1>
    <div class="meta">
      <span class="badge b-${issue.state}">${issue.state}</span>
      <strong>#${issue.number}</strong> opened by @${esc(issue.author)} · ${timeAgo(issue.createdAt)}
      · <a href="${esc(issue.url)}">Open on GitHub →</a>
      <div style="margin-top:8px">${issue.labels.map(l => `<span class="label" style="background:${l.color}">${esc(l.name)}</span>`).join('')}</div>
    </div>
    <div class="body">${esc(body) || '<em>No description.</em>'}</div>
    <h2>Comments (${comments.length})</h2>
    ${comments.map(c => `<div class="comment"><div class="who">@${esc(c.author?.login ?? '')}<span class="when">${timeAgo(new Date(c.createdAt))}</span></div><div>${esc((c.body || '').slice(0, 800))}</div></div>`).join('') || '<em>No comments.</em>'}
  </body></html>`;
}
