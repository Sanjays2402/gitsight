import * as vscode from 'vscode';
import { Git } from '../git/git';
import { PR, PrProvider, detectProvider } from '../git/prProviders';
import { timeAgo } from '../git/format';

const FILTER_KEY = 'gitsight.prAuthorFilter';

export class PullRequestProvider implements vscode.TreeDataProvider<PrItem> {
  private _change = new vscode.EventEmitter<PrItem | void>();
  onDidChangeTreeData = this._change.event;
  private prs: PR[] = [];
  private loading = false;
  private error?: string;
  private provider?: PrProvider;
  private authorFilter?: string;     // exact-match (case-insensitive) on PR.author
  private currentUser?: string;      // resolved @me for current provider

  constructor(private getGit: () => Git | undefined, private ctx?: vscode.ExtensionContext) {
    this.authorFilter = ctx?.workspaceState.get<string>(FILTER_KEY) || undefined;
  }

  refresh(): void { this.prs = []; this.error = undefined; this.provider = undefined; this.currentUser = undefined; this.load(); }

  /** Set/clear the active author filter. Pass `undefined` to clear. */
  async setAuthorFilter(value: string | undefined) {
    this.authorFilter = value && value.trim() ? value.trim() : undefined;
    await this.ctx?.workspaceState.update(FILTER_KEY, this.authorFilter);
    vscode.commands.executeCommand('setContext', 'gitsight.prFilterActive', !!this.authorFilter);
    this._change.fire();
  }

  getAuthorFilter(): string | undefined { return this.authorFilter; }
  getAuthors(): string[] {
    return [...new Set(this.prs.map(p => p.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  /** Returns PRs after applying the current filter (or all if no filter). */
  private filtered(): PR[] {
    if (!this.authorFilter) return this.prs;
    const needle = this.authorFilter.toLowerCase();
    // "@me" is resolved during load(); fall back to literal match if not resolved yet.
    const me = this.currentUser?.toLowerCase();
    return this.prs.filter(p => {
      const a = (p.author || '').toLowerCase();
      if (needle === '@me') return me ? a === me : false;
      return a === needle || a.includes(needle);  // exact OR substring fallback
    });
  }

  async load() {
    const git = this.getGit();
    if (!git) {
      this.error = 'No Git repository in workspace.';
      this._change.fire();
      return;
    }
    this.loading = true;
    this._change.fire();
    try {
      this.provider = await detectProvider(git);
      if (!this.provider) {
        this.error = 'No supported PR provider (GitHub, Azure DevOps) detected on origin remote.';
        return;
      }
      this.prs = await this.provider.list();
      // Best-effort: resolve current user for @me filter
      try { this.currentUser = await this.provider.currentUser?.(); } catch {/* ignore */}
      vscode.commands.executeCommand('setContext', 'gitsight.prFilterActive', !!this.authorFilter);
    } catch (e: any) {
      const msg = (e.stderr || e.message || '').toString();
      if (msg.includes('not found') || msg.includes('command not found')) {
        this.error = this.provider?.providerKey === 'azure-devops'
          ? 'az CLI missing. Install: brew install azure-cli && az extension add --name azure-devops && az login'
          : 'gh CLI missing. Install: brew install gh && gh auth login';
      } else if (msg.includes('TF400813') || msg.includes('not authenticated') || msg.includes('login')) {
        this.error = this.provider?.providerKey === 'azure-devops'
          ? 'az not logged in. Run: az login (or set AZURE_DEVOPS_EXT_PAT_AUTH)'
          : 'gh not authenticated. Run: gh auth login';
      } else {
        this.error = msg.split('\n')[0].slice(0, 200);
      }
    } finally {
      this.loading = false;
      this._change.fire();
    }
  }

  getProvider(): PrProvider | undefined { return this.provider; }

  getTreeItem(i: PrItem) { return i; }
  getChildren(parent?: PrItem): PrItem[] {
    if (parent) return [];
    if (this.loading) return [new PrItem('Loading PRs…', '', 'loading')];
    if (this.error) return [new PrItem(`⚠ ${this.error}`, '', 'error')];

    const items: PrItem[] = [];
    if (this.provider) items.push(new PrItem(`Provider: ${this.provider.name}`, '', 'provider'));

    // Filter chip (always visible when active, clickable to clear)
    if (this.authorFilter) {
      const label = this.authorFilter === '@me'
        ? `Filter: @me${this.currentUser ? ` (${this.currentUser})` : ''}`
        : `Filter: author = ${this.authorFilter}`;
      const chip = new PrItem(`✕  ${label}`, 'click to clear', 'filter');
      chip.command = { command: 'gitsight.clearPrAuthorFilter', title: 'Clear filter' };
      items.push(chip);
    }

    const visible = this.filtered();

    if (!this.prs.length) {
      const hint = this.provider ? `No pull requests on ${this.provider.name}. Click ↻ to refresh.` : 'No pull requests. Click ↻ to refresh.';
      items.push(new PrItem(hint, '', 'empty'));
      return items;
    }
    if (!visible.length && this.authorFilter) {
      items.push(new PrItem(`No PRs match author "${this.authorFilter}".`, `${this.prs.length} hidden`, 'empty'));
      return items;
    }

    const groups: Record<string, PR[]> = { OPEN: [], DRAFT: [], MERGED: [], CLOSED: [] };
    for (const pr of visible) {
      const key = pr.isDraft ? 'DRAFT' : pr.state;
      (groups[key] ?? (groups[key] = [])).push(pr);
    }
    for (const [k, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const total = this.prs.filter(p => (p.isDraft ? 'DRAFT' : p.state) === k).length;
      const countLabel = this.authorFilter && total !== list.length ? `${k} · ${list.length} of ${total}` : `${k} · ${list.length}`;
      items.push(new PrItem(countLabel, '', 'group'));
      for (const pr of list) {
        const checkIcon = pr.checksState === 'SUCCESS' ? '✓' : pr.checksState === 'FAILURE' ? '✗' : pr.checksState === 'PENDING' ? '○' : ' ';
        const reviewBadge = pr.reviewDecision === 'APPROVED' ? '✓' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '✗' : pr.reviewDecision === 'REVIEW_REQUIRED' ? '◐' : ' ';
        const label = `#${pr.number} ${checkIcon}${reviewBadge} ${pr.title}`;
        const diff = (pr.additions || pr.deletions) ? ` · +${pr.additions}/-${pr.deletions}` : '';
        const desc = `${pr.author}${diff} · ${timeAgo(pr.updatedAt)}`;
        const it = new PrItem(label, desc, 'pr', pr);
        it.tooltip = new vscode.MarkdownString([
          `**#${pr.number} ${esc(pr.title)}**`,
          ``,
          `**Provider:** ${pr.provider === 'azure-devops' ? 'Azure DevOps' : 'GitHub'}`,
          `**Author:** ${esc(pr.author)}`,
          `**Branch:** \`${pr.headRefName}\` → \`${pr.baseRefName}\``,
          `**Updated:** ${pr.updatedAt.toLocaleString()}`,
          (pr.additions || pr.deletions) ? `**Diff:** +${pr.additions} / -${pr.deletions}` : '',
          `**Checks:** ${pr.checksState ?? '—'}  •  **Review:** ${pr.reviewDecision ?? '—'}`,
          pr.labels.length ? `**Labels:** ${pr.labels.join(', ')}` : '',
          ``,
          `[Open in browser →](${pr.url})`,
        ].filter(Boolean).join('\n'));
        items.push(it);
      }
    }
    return items;
  }
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
    } else if (kind === 'group') this.iconPath = new vscode.ThemeIcon('folder');
    else if (kind === 'provider') this.iconPath = new vscode.ThemeIcon('rocket');
    else if (kind === 'filter') this.iconPath = new vscode.ThemeIcon('filter-filled', new vscode.ThemeColor('charts.yellow'));
    else if (kind === 'loading') this.iconPath = new vscode.ThemeIcon('loading~spin');
    else if (kind === 'error') this.iconPath = new vscode.ThemeIcon('warning');
  }
}

/** Show a quick-pick to choose a filter: @me / specific author / clear / custom. */
export async function pickPrAuthorFilter(prs: PullRequestProvider) {
  const authors = prs.getAuthors();
  const current = prs.getAuthorFilter();
  const items: vscode.QuickPickItem[] = [
    { label: '$(account) @me', description: 'PRs authored by you (resolved from gh/az)', detail: current === '@me' ? '✓ current' : undefined },
    { label: '$(clear-all) Clear filter', description: 'Show all PRs', detail: !current ? '✓ current' : undefined },
    { label: '$(edit) Custom…', description: 'Type any author name / substring' },
    { kind: vscode.QuickPickItemKind.Separator, label: 'Authors in current list' },
    ...authors.map(a => ({ label: `$(person) ${a}`, description: undefined, detail: current?.toLowerCase() === a.toLowerCase() ? '✓ current' : undefined })),
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: current ? `Filtering by: ${current}` : 'Filter PRs by author', matchOnDescription: true });
  if (!pick) return;
  if (pick.label.includes('@me')) return prs.setAuthorFilter('@me');
  if (pick.label.includes('Clear filter')) return prs.setAuthorFilter(undefined);
  if (pick.label.includes('Custom')) {
    const v = await vscode.window.showInputBox({ prompt: 'Author name (exact or substring)', value: current ?? '' });
    if (v !== undefined) await prs.setAuthorFilter(v || undefined);
    return;
  }
  // Author pick — strip the icon prefix
  const name = pick.label.replace(/^\$\(person\)\s*/, '');
  await prs.setAuthorFilter(name);
}

function esc(s: string) { return (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!)); }

export async function openPrWebview(pr: PR, provider: PrProvider | undefined) {
  const panel = vscode.window.createWebviewPanel(
    'gitsight.pr',
    `PR #${pr.number}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  let body = '', files: any[] = [], reviews: any[] = [];
  try {
    if (provider) {
      const d = await provider.detail(pr.number);
      body = d.body; files = d.files; reviews = d.reviews;
    }
  } catch {/* ignore */}

  const providerBadge = pr.provider === 'azure-devops' ? 'Azure DevOps' : 'GitHub';

  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; padding:24px; max-width:900px; }
    h1 { font-size:20px; margin:0 0 8px; }
    .meta { color: var(--vscode-descriptionForeground); margin-bottom:16px; font-size:12px; }
    .badge { padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; margin-right:6px; }
    .b-OPEN { background:#10b98133; color:#4ade80; }
    .b-MERGED { background:#a855f733; color:#c084fc; }
    .b-CLOSED { background:#6b728033; color:#9ca3af; }
    .b-DRAFT { background:#6b728033; color:#9ca3af; }
    .b-PROV { background:#0e639c33; color:#7dd3fc; }
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
      <span class="badge b-PROV">${providerBadge}</span>
      <strong>#${pr.number}</strong> by ${esc(pr.author)} • <code>${esc(pr.headRefName)}</code> → <code>${esc(pr.baseRefName)}</code>
      ${(pr.additions || pr.deletions) ? `• +${pr.additions} / -${pr.deletions}` : ''}
      • Updated ${timeAgo(pr.updatedAt)}
      • <a href="${esc(pr.url)}">Open in browser →</a>
    </div>
    <div class="body">${esc(body) || '<em>No description.</em>'}</div>
    <h2>Files (${files.length})</h2>
    ${files.map(f => `<div class="file"><span class="path">${esc(f.path)}</span><span><span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></span></div>`).join('') || '<em>No files.</em>'}
    <h2>Reviews (${reviews.length})</h2>
    ${reviews.map(r => `<div style="padding:8px 0"><strong>${esc(r.author)}</strong> — ${esc(r.state)}<div style="opacity:.7;font-size:12px;margin-top:4px">${esc(r.body || '').slice(0, 500)}</div></div>`).join('') || '<em>No reviews.</em>'}
  </body></html>`;
}
