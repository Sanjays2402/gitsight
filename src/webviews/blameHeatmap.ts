import * as vscode from 'vscode';
import * as path from 'path';
import { Git, BlameLine } from '../git/git';
import { colorForAuthor, heatmapColor, timeAgo } from '../git/format';

let panel: vscode.WebviewPanel | undefined;

export async function showBlameHeatmap(git: Git, file: string) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'gitsight.blameHeatmap',
      'GitSight: Blame Heatmap',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => (panel = undefined));
  } else {
    panel.reveal(vscode.ViewColumn.Active);
  }
  panel.title = `Blame — ${path.basename(file)}`;
  const blame = await git.blame(file);
  const content = await git.showFile('HEAD', file).catch(() => '');
  panel.webview.html = renderHeatmap(file, blame, content);
}

function renderHeatmap(file: string, blame: BlameLine[], content: string): string {
  const lines = content.split('\n');
  const now = Date.now();
  const ages = blame.map(b => now - b.date.getTime());
  const maxAge = Math.max(...ages, 1);
  const rows = lines.map((src, i) => {
    const b = blame[i];
    if (!b) return `<div class="row"><span class="ln">${i + 1}</span><span class="src">${esc(src)}</span></div>`;
    const heat = heatmapColor(b.date, 365);
    const authorColor = colorForAuthor(b.author);
    const dot = `<span class="dot" style="background:${authorColor}" title="${esc(b.author)}"></span>`;
    return `<div class="row" title="${esc(b.author)} • ${timeAgo(b.date)} • ${esc(b.summary)}">
      <span class="heat" style="background:${heat}"></span>
      ${dot}
      <span class="sha">${b.sha.slice(0, 7)}</span>
      <span class="author">${esc(b.author.padEnd(18).slice(0, 18))}</span>
      <span class="ago">${timeAgo(b.date).padStart(7)}</span>
      <span class="ln">${i + 1}</span>
      <span class="src">${esc(src)}</span>
    </div>`;
  }).join('');

  // Author distribution
  const byAuthor = new Map<string, number>();
  for (const b of blame) byAuthor.set(b.author, (byAuthor.get(b.author) ?? 0) + 1);
  const total = blame.length || 1;
  const authors = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const legend = authors.map(([a, n]) =>
    `<div class="lg-item"><span class="dot" style="background:${colorForAuthor(a)}"></span>${esc(a)}<span class="lg-n">${n} (${((n / total) * 100).toFixed(0)}%)</span></div>`
  ).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size: 12px; }
    .toolbar { display:flex; padding:8px 12px; gap:12px; border-bottom:1px solid var(--vscode-panel-border); align-items:center; background:var(--vscode-editorWidget-background); }
    .toolbar h2 { font-size:13px; margin:0; font-weight:600; }
    .toolbar .meta { color: var(--vscode-descriptionForeground); font-size:11px; }
    .legend { display:flex; gap:8px; flex-wrap:wrap; padding:6px 12px; background:var(--vscode-editorWidget-background); border-bottom:1px solid var(--vscode-panel-border); font-family: var(--vscode-font-family); }
    .lg-item { display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:2px 6px; background:#ffffff08; border-radius:3px; }
    .lg-n { color: var(--vscode-descriptionForeground); margin-left:4px; }
    .dot { width:8px; height:8px; border-radius:4px; display:inline-block; }
    .row { display:flex; align-items:center; gap:8px; padding:0 12px; height:20px; white-space:pre; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .heat { width:4px; height:20px; flex-shrink:0; }
    .sha { color:#fbbf24; width:60px; flex-shrink:0; }
    .author { color:#9d9d9d; width:140px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; }
    .ago { color:#6a9955; width:70px; flex-shrink:0; }
    .ln { color:#666; width:50px; text-align:right; flex-shrink:0; }
    .src { flex:1; color:#d4d4d4; overflow:hidden; text-overflow:ellipsis; }
  </style></head><body>
    <div class="toolbar">
      <h2>${esc(path.basename(file))}</h2>
      <span class="meta">${blame.length} lines • ${byAuthor.size} authors</span>
    </div>
    <div class="legend">${legend}</div>
    ${rows}
  </body></html>`;
}

function esc(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
