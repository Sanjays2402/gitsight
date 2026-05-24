import * as vscode from 'vscode';
import { Git, Commit } from '../git/git';
import { timeAgo, colorForAuthor } from '../git/format';
import { activePalette } from '../views/graphThemes';

export class CommitGraphPanel {
  private static current?: CommitGraphPanel;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, git: Git) {
    if (CommitGraphPanel.current) {
      CommitGraphPanel.current.panel.reveal();
      CommitGraphPanel.current.refresh(git);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'gitsight.commitGraph', 'GitSight: Commit Graph',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    CommitGraphPanel.current = new CommitGraphPanel(panel, git);
  }

  private constructor(panel: vscode.WebviewPanel, private git: Git) {
    this.panel = panel;
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'showCommit') {
        try {
          const out = await git.show(msg.sha);
          const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
        } catch (e: any) {
          vscode.window.showErrorMessage(`GitSight: ${e.message}`);
        }
      } else if (msg.type === 'copySha') {
        await vscode.env.clipboard.writeText(msg.sha);
        vscode.window.setStatusBarMessage(`Copied ${msg.sha.slice(0, 7)}`, 1500);
      } else if (msg.type === 'refresh') {
        await this.refresh(git);
      } else if (msg.type === 'search') {
        await this.refresh(git, msg.q);
      }
    });
    this.refresh(git);
  }

  async refresh(git: Git, search?: string) {
    const cfg = vscode.workspace.getConfiguration('gitsight.graph');
    const max = cfg.get<number>('maxCommits') ?? 1000;
    const all = cfg.get<boolean>('showAllBranches') ?? true;
    try {
      const commits = await git.log({ max, all, grep: search });
      this.panel.webview.html = renderGraph(commits, search ?? '');
    } catch (e: any) {
      this.panel.webview.html = `<pre style="padding:16px;color:#e44">${escape(e.message)}</pre>`;
    }
  }

  dispose() {
    CommitGraphPanel.current = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderGraph(commits: Commit[], search: string): string {
  type Lane = { sha: string; color: string };
  const lanes: (Lane | null)[] = [];
  const rows: { commit: Commit; lane: number; lanes: (Lane | null)[]; color: string }[] = [];
  const palette = activePalette();
  let colorIdx = 0;
  const byParent = new Map<string, number>();

  for (const c of commits) {
    let laneIdx = byParent.get(c.sha);
    let color: string;
    if (laneIdx === undefined) {
      laneIdx = lanes.findIndex(l => l === null);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(null); }
      color = palette[colorIdx++ % palette.length];
    } else color = lanes[laneIdx]!.color;
    lanes[laneIdx] = { sha: c.sha, color };
    const snapshot = lanes.map(l => (l ? { ...l } : null));

    if (c.parents.length === 0) lanes[laneIdx] = null;
    else {
      lanes[laneIdx] = { sha: c.parents[0], color };
      byParent.set(c.parents[0], laneIdx);
      for (let i = 1; i < c.parents.length; i++) {
        let n = lanes.findIndex(l => l === null);
        if (n === -1) { n = lanes.length; lanes.push(null); }
        const pc = palette[colorIdx++ % palette.length];
        lanes[n] = { sha: c.parents[i], color: pc };
        byParent.set(c.parents[i], n);
      }
    }
    rows.push({ commit: c, lane: laneIdx, lanes: snapshot, color });
  }

  const rowH = 28, colW = 16;
  const maxLanes = Math.max(...rows.map(r => r.lanes.length), 1);
  const graphW = maxLanes * colW + 10;

  const svgRows = rows.map((r, i) => {
    const cx = r.lane * colW + colW / 2 + 5;
    const nextLanes = rows[i + 1]?.lanes ?? [];
    const parts: string[] = [];
    r.lanes.forEach((l, idx) => {
      if (!l) return;
      const x = idx * colW + colW / 2 + 5;
      parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${rowH / 2}" stroke="${l.color}" stroke-width="2"/>`);
      const continues = nextLanes.some((nl, ni) => nl && nl.sha === l.sha && ni === idx);
      if (continues) parts.push(`<line x1="${x}" y1="${rowH / 2}" x2="${x}" y2="${rowH}" stroke="${l.color}" stroke-width="2"/>`);
    });
    r.commit.parents.forEach(p => {
      const nIdx = nextLanes.findIndex(nl => nl && nl.sha === p);
      if (nIdx === -1) return;
      const nx = nIdx * colW + colW / 2 + 5;
      if (nx === cx) parts.push(`<line x1="${cx}" y1="${rowH / 2}" x2="${nx}" y2="${rowH}" stroke="${r.color}" stroke-width="2"/>`);
      else parts.push(`<path d="M${cx},${rowH / 2} C${cx},${rowH * 0.85} ${nx},${rowH * 0.5} ${nx},${rowH}" stroke="${r.color}" stroke-width="2" fill="none"/>`);
    });
    parts.push(`<circle cx="${cx}" cy="${rowH / 2}" r="5" fill="${r.color}" stroke="var(--vscode-editor-background)" stroke-width="2"/>`);
    return `<g transform="translate(0,${i * rowH})">${parts.join('')}</g>`;
  }).join('');

  const list = rows.map(r => {
    const refsHtml = r.commit.refs.map(ref => {
      const cls = ref.startsWith('tag:') ? 'tag' : ref === 'HEAD' || ref.includes('HEAD') ? 'head' : ref.includes('/') ? 'remote' : 'branch';
      return `<span class="ref ${cls}">${escape(ref.replace(/^tag: /, ''))}</span>`;
    }).join('');
    return `
    <div class="row" data-sha="${r.commit.sha}" style="height:${28}px">
      <span class="refs">${refsHtml}</span>
      <span class="subject">${escape(r.commit.subject)}</span>
      <span class="meta">
        <span class="author" style="color:${colorForAuthor(r.commit.author)}">${escape(r.commit.author)}</span>
        <span class="ago">${timeAgo(r.commit.date)}</span>
        <span class="sha" data-sha="${r.commit.sha}" title="Click to copy">${r.commit.shortSha}</span>
      </span>
    </div>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark light; }
  body { margin:0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size: 13px; }
  .toolbar { display:flex; padding:8px 12px; gap:8px; border-bottom:1px solid var(--vscode-panel-border); position:sticky; top:0; background:var(--vscode-editor-background); z-index:10; align-items:center; }
  .toolbar input { flex:1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 3px; }
  .toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .stats { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .wrap { display: flex; }
  .graph { width: ${graphW}px; min-width: ${graphW}px; background: var(--vscode-editorWidget-background); }
  .list { flex: 1; overflow-x: hidden; }
  .row { display: flex; align-items: center; padding: 0 12px; gap: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; border-bottom: 1px solid transparent; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.active { background: var(--vscode-list-activeSelectionBackground); }
  .subject { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; gap: 12px; color: var(--vscode-descriptionForeground); font-size: 11px; align-items: center; }
  .sha { font-family: var(--vscode-editor-font-family); cursor: copy; padding: 1px 4px; border-radius: 2px; }
  .sha:hover { background: var(--vscode-toolbar-hoverBackground); }
  .refs { display:flex; gap: 4px; }
  .ref { padding: 1px 6px; border-radius: 3px; font-size: 10px; }
  .ref.branch { background: #2563eb22; color: #60a5fa; border:1px solid #60a5fa55; }
  .ref.remote { background: #16a34a22; color: #4ade80; border:1px solid #4ade8055; }
  .ref.tag    { background: #d9770622; color: #fbbf24; border:1px solid #fbbf2455; }
  .ref.head   { background: #dc262622; color: #f87171; border:1px solid #f8717155; font-weight:600; }
</style></head>
<body>
<div class="toolbar">
  <input id="search" placeholder="Search commits by message…" value="${escape(search)}"/>
  <button id="refresh">Refresh</button>
  <span class="stats">${rows.length} commits</span>
</div>
<div class="wrap">
  <svg class="graph" width="${graphW}" height="${rows.length * rowH}" xmlns="http://www.w3.org/2000/svg">${svgRows}</svg>
  <div class="list">${list}</div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.row').forEach(el => {
    el.addEventListener('click', e => {
      if ((e.target as HTMLElement).classList.contains('sha')) return;
      document.querySelectorAll('.row.active').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      vscode.postMessage({ type: 'showCommit', sha: el.dataset.sha });
    });
  });
  document.querySelectorAll('.sha').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      vscode.postMessage({ type: 'copySha', sha: el.dataset.sha });
    });
  });
  const input = document.getElementById('search');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => vscode.postMessage({ type: 'search', q: input.value }), 300);
  });
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
</script>
</body></html>`.replace('(e.target as HTMLElement)', 'e.target'); // strip TS cast for browser JS
}
