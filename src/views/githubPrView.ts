import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';

const pexec = promisify(execFile);

export interface PR {
  number: number;
  title: string;
  state: string;          // OPEN | MERGED | CLOSED
  isDraft: boolean;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  baseRefName: string;
  headRefName: string;
  url: string;
  additions: number;
  deletions: number;
  reviewDecision?: string;
  checksState?: string;   // SUCCESS | FAILURE | PENDING
  labels: string[];
}

export class PullRequestProvider implements vscode.TreeDataProvider<PrItem> {
  private _change = new vscode.EventEmitter<PrItem | void>();
  onDidChangeTreeData = this._change.event;
  private prs: PR[] = [];
  private loading = false;
  private error?: string;

  constructor(private git: Git) {}

  refresh(): void { this.prs = []; this.error = undefined; this.load(); }

  async load() {
    this.loading = true;
    this._change.fire();
    try {
      const { stdout } = await pexec(
        'gh',
        ['pr', 'list', '--limit', '30', '--state', 'all',
         '--json', 'number,title,state,isDraft,author,createdAt,updatedAt,baseRefName,headRefName,url,additions,deletions,reviewDecision,statusCheckRollup,labels'],
        { cwd: this.git.cwd, maxBuffer: 50 * 1024 * 1024 }
      );
      const raw = JSON.parse(stdout);
      this.prs = raw.map((p: any) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        isDraft: p.isDraft,
        author: p.author?.login ?? 'unknown',
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
        baseRefName: p.baseRefName,
        headRefName: p.headRefName,
        url: p.url,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        reviewDecision: p.reviewDecision,
        checksState: rollupState(p.statusCheckRollup),
        labels: (p.labels ?? []).map((l: any) => l.name),
      }));
    } catch (e: any) {
      this.error = e.message?.includes('not found')
        ? 'gh CLI not installed. Install: brew install gh'
        : (e.stderr || e.message).toString().split('\n')[0].slice(0, 200);
    } finally {
      this.loading = false;
      this._change.fire();
    }
  }

  getTreeItem(i: PrItem) { return i; }
  getChildren(parent?: PrItem): PrItem[] {
    if (parent) return [];
    if (this.loading) return [new PrItem('Loading PRs…', '', 'loading')];
    if (this.error) return [new PrItem(`⚠ ${this.error}`, '', 'error')];
    if (!this.prs.length) return [new PrItem('No pull requests. Click ↻ to refresh.', '', 'empty')];

    const groups: Record<string, PR[]> = { OPEN: [], DRAFT: [], MERGED: [], CLOSED: [] };
    for (const pr of this.prs) {
      const key = pr.isDraft ? 'DRAFT' : pr.state;
      (groups[key] ?? (groups[key] = [])).push(pr);
    }
    const items: PrItem[] = [];
    for (const [k, list] of Object.entries(groups)) {
      if (!list.length) continue;
      items.push(new PrItem(`${k} · ${list.length}`, '', 'group'));
      for (const pr of list) {
        const checkIcon = pr.checksState === 'SUCCESS' ? '✓' : pr.checksState === 'FAILURE' ? '✗' : pr.checksState === 'PENDING' ? '○' : ' ';
        const reviewBadge = pr.reviewDecision === 'APPROVED' ? '✓' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '✗' : pr.reviewDecision === 'REVIEW_REQUIRED' ? '◐' : ' ';
        const label = `#${pr.number} ${checkIcon}${reviewBadge} ${pr.title}`;
        const desc = `${pr.author} · +${pr.additions}/-${pr.deletions} · ${timeAgo(pr.updatedAt)}`;
        const it = new PrItem(label, desc, 'pr', pr);
        it.tooltip = new vscode.MarkdownString([
          `**#${pr.number} ${esc(pr.title)}**`,
          ``,
          `**Author:** @${pr.author}`,
          `**Branch:** \`${pr.headRefName}\` → \`${pr.baseRefName}\``,
          `**Updated:** ${pr.updatedAt.toLocaleString()}`,
          `**Diff:** +${pr.additions} / -${pr.deletions}`,
          `**Checks:** ${pr.checksState ?? '—'}  •  **Review:** ${pr.reviewDecision ?? '—'}`,
          pr.labels.length ? `**Labels:** ${pr.labels.join(', ')}` : '',
          ``,
          `[Open on GitHub →](${pr.url})`,
        ].join('\n'));
        items.push(it);
      }
    }
    return items;
  }
}

function rollupState(rollup: any[] | undefined): string | undefined {
  if (!Array.isArray(rollup) || !rollup.length) return undefined;
  const states = rollup.map(s => s.conclusion ?? s.state ?? s.status).filter(Boolean);
  if (states.includes('FAILURE') || states.includes('failure')) return 'FAILURE';
  if (states.includes('PENDING') || states.includes('pending') || states.includes('IN_PROGRESS')) return 'PENDING';
  if (states.every(s => s === 'SUCCESS' || s === 'success')) return 'SUCCESS';
  return 'PENDING';
}

class PrItem extends vscode.TreeItem {
  constructor(label: string, description: string, public kind: string, public pr?: PR) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = `pr-${kind}`;
    if (pr) {
      this.iconPath = new vscode.ThemeIcon(
        pr.isDraft ? 'git-pull-request-draft'
          : pr.state === 'MERGED' ? 'git-merge'
          : pr.state === 'CLOSED' ? 'git-pull-request-closed'
          : 'git-pull-request',
        new vscode.ThemeColor(
          pr.checksState === 'FAILURE' ? 'charts.red'
            : pr.state === 'MERGED' ? 'charts.purple'
            : pr.state === 'CLOSED' ? 'charts.foreground'
            : 'charts.green'
        )
      );
      this.command = { command: 'gitsight.openPr', title: 'Open PR', arguments: [pr] };
    } else if (kind === 'group') {
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (kind === 'loading') {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (kind === 'error') {
      this.iconPath = new vscode.ThemeIcon('warning');
    }
  }
}

function esc(s: string) { return (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!)); }

export async function openPrWebview(pr: PR, repoCwd: string) {
  const panel = vscode.window.createWebviewPanel(
    'gitsight.pr',
    `PR #${pr.number}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  let body = '', files: any[] = [], reviews: any[] = [];
  try {
    const { stdout } = await pexec(
      'gh', ['pr', 'view', String(pr.number), '--json', 'body,files,reviews,commits'],
      { cwd: repoCwd, maxBuffer: 100 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout);
    body = parsed.body || '';
    files = parsed.files || [];
    reviews = parsed.reviews || [];
  } catch {/* ignore */}

  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; padding:24px; max-width:900px; }
    h1 { font-size:20px; margin:0 0 8px; }
    .meta { color: var(--vscode-descriptionForeground); margin-bottom:16px; font-size:12px; }
    .badge { padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-right:6px; }
    .b-OPEN { background:#10b98133; color:#4ade80; }
    .b-MERGED { background:#a855f733; color:#c084fc; }
    .b-CLOSED { background:#6b728033; color:#9ca3af; }
    .b-DRAFT { background:#6b728033; color:#9ca3af; }
    .body { background: var(--vscode-editorWidget-background); padding:16px; border-radius:6px; white-space:pre-wrap; line-height:1.6; font-size:13px; }
    h2 { font-size:14px; margin:24px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--vscode-panel-border); }
    .file { display:flex; justify-content:space-between; padding:6px 8px; border-radius:3px; }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .file .path { font-family: var(--vscode-editor-font-family); }
    .file .add { color:#4ade80; } .file .del { color:#f87171; }
    a { color: var(--vscode-textLink-foreground); }
  </style></head><body>
    <h1>${esc(pr.title)}</h1>
    <div class="meta">
      <span class="badge b-${pr.isDraft ? 'DRAFT' : pr.state}">${pr.isDraft ? 'DRAFT' : pr.state}</span>
      <strong>#${pr.number}</strong> by @${esc(pr.author)} • <code>${esc(pr.headRefName)}</code> → <code>${esc(pr.baseRefName)}</code>
      • +${pr.additions} / -${pr.deletions} • Updated ${timeAgo(pr.updatedAt)}
      • <a href="${esc(pr.url)}">Open on GitHub →</a>
    </div>
    <div class="body">${esc(body) || '<em>No description.</em>'}</div>
    <h2>Files (${files.length})</h2>
    ${files.map(f => `<div class="file"><span class="path">${esc(f.path)}</span><span><span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></span></div>`).join('') || '<em>No files.</em>'}
    <h2>Reviews (${reviews.length})</h2>
    ${reviews.map(r => `<div style="padding:8px 0"><strong>@${esc(r.author?.login ?? '')}</strong> — ${esc(r.state)}<div style="opacity:.7;font-size:12px;margin-top:4px">${esc(r.body || '').slice(0,500)}</div></div>`).join('') || '<em>No reviews.</em>'}
  </body></html>`;
}
