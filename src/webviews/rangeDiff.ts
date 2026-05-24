import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';

/**
 * Multi-file split-diff viewer for an arbitrary commit range.
 * Renders left/right panes per file with line-by-line highlighting and a
 * collapsible file tree sidebar. Useful for reviewing a feature branch
 * before merging without bouncing through VS Code's per-file diff dance.
 */
export async function showRangeDiff(git: Git, fromRef?: string, toRef?: string) {
  fromRef = fromRef || await vscode.window.showInputBox({ prompt: 'From ref', value: 'main' });
  if (!fromRef) return;
  toRef = toRef || await vscode.window.showInputBox({ prompt: 'To ref', value: 'HEAD' });
  if (!toRef) return;

  const panel = vscode.window.createWebviewPanel(
    'gitsight.rangeDiff',
    `Diff: ${fromRef} ↔ ${toRef}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const diff = await git.diff({ from: fromRef, to: toRef });
  const files = parseDiff(diff);
  panel.webview.html = renderRangeDiff(fromRef, toRef, files);
}

interface DiffFile { path: string; oldPath?: string; hunks: DiffHunk[]; additions: number; deletions: number; }
interface DiffHunk { header: string; lines: { type: ' ' | '+' | '-' ; oldLine?: number; newLine?: number; text: string }[]; }

export function parseDiff(raw: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLn = 0, newLn = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = /a\/(.+) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] || '?', oldPath: m?.[1], hunks: [], additions: 0, deletions: 0 };
      out.push(cur);
      hunk = undefined;
    } else if (line.startsWith('@@') && cur) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (m) { oldLn = +m[1]; newLn = +m[2]; }
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk && cur) {
      const t = line[0];
      if (t === '+') { hunk.lines.push({ type: '+', newLine: newLn++, text: line.slice(1) }); cur.additions++; }
      else if (t === '-') { hunk.lines.push({ type: '-', oldLine: oldLn++, text: line.slice(1) }); cur.deletions++; }
      else if (t === ' ') { hunk.lines.push({ type: ' ', oldLine: oldLn++, newLine: newLn++, text: line.slice(1) }); }
    }
  }
  return out;
}

const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderRangeDiff(from: string, to: string, files: DiffFile[]): string {
  const totalAdd = files.reduce((a, f) => a + f.additions, 0);
  const totalDel = files.reduce((a, f) => a + f.deletions, 0);

  const tree = files.map((f, i) => `
    <div class="tree-item" onclick="document.getElementById('f${i}').scrollIntoView({behavior:'smooth'})">
      <span class="tree-path">${esc(f.path)}</span>
      <span class="tree-stat"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span>
    </div>
  `).join('');

  const filesHtml = files.map((f, i) => {
    const rows: string[] = [];
    for (const h of f.hunks) {
      rows.push(`<tr class="hunk-head"><td colspan="4">${esc(h.header)}</td></tr>`);
      // Build split pairs: left=del/ctx, right=add/ctx
      const left: typeof h.lines = [];
      const right: typeof h.lines = [];
      let lq: typeof h.lines = [], rq: typeof h.lines = [];
      const flush = () => {
        const n = Math.max(lq.length, rq.length);
        for (let i = 0; i < n; i++) { left.push(lq[i] || { type: ' ', text: '' } as any); right.push(rq[i] || { type: ' ', text: '' } as any); }
        lq = []; rq = [];
      };
      for (const ln of h.lines) {
        if (ln.type === '-') lq.push(ln);
        else if (ln.type === '+') rq.push(ln);
        else { flush(); left.push(ln); right.push(ln); }
      }
      flush();
      for (let i = 0; i < left.length; i++) {
        const l = left[i], r = right[i];
        const lc = l.type === '-' ? 'd' : (l.type === ' ' ? 'c' : 'e');
        const rc = r.type === '+' ? 'a' : (r.type === ' ' ? 'c' : 'e');
        rows.push(`<tr><td class="ln">${l.oldLine ?? ''}</td><td class="src ${lc}">${esc(l.text)}</td><td class="ln">${r.newLine ?? ''}</td><td class="src ${rc}">${esc(r.text)}</td></tr>`);
      }
    }
    return `<section class="file" id="f${i}">
      <header class="file-head">
        <span class="fp">${esc(f.path)}</span>
        <span class="fs"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span>
      </header>
      <table class="diff"><tbody>${rows.join('')}</tbody></table>
    </section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font:13px var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); display:flex; height:100vh; }
    .sidebar { width:280px; flex-shrink:0; background:var(--vscode-sideBar-background); border-right:1px solid var(--vscode-panel-border); overflow-y:auto; }
    .sb-head { padding:12px 14px; border-bottom:1px solid var(--vscode-panel-border); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--vscode-descriptionForeground); background:var(--vscode-sideBarSectionHeader-background); }
    .sb-meta { padding:8px 14px; font-size:11px; color:var(--vscode-descriptionForeground); border-bottom:1px solid var(--vscode-panel-border); }
    .tree-item { padding:6px 14px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; font-size:12px; }
    .tree-item:hover { background:var(--vscode-list-hoverBackground); }
    .tree-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family); }
    .tree-stat { font-family:var(--vscode-editor-font-family); font-size:11px; flex-shrink:0; }
    .add { color:#4ade80; } .del { color:#f87171; }
    .main { flex:1; overflow:auto; padding:16px 20px; }
    .header { padding-bottom:14px; border-bottom:1px solid var(--vscode-panel-border); margin-bottom:16px; }
    .header h1 { margin:0 0 6px; font-size:16px; font-weight:600; }
    .header .ref { font-family:var(--vscode-editor-font-family); background:#0e639c33; color:#7dd3fc; padding:2px 8px; border-radius:10px; font-size:11px; }
    .file { margin-bottom:24px; border:1px solid var(--vscode-panel-border); border-radius:6px; overflow:hidden; }
    .file-head { padding:8px 12px; background:var(--vscode-editorWidget-background); display:flex; justify-content:space-between; font-family:var(--vscode-editor-font-family); font-size:12px; border-bottom:1px solid var(--vscode-panel-border); }
    .fp { color:var(--vscode-textLink-foreground); }
    table.diff { width:100%; border-collapse:collapse; font-family:var(--vscode-editor-font-family); font-size:12px; table-layout:fixed; }
    table.diff td { padding:1px 8px; vertical-align:top; white-space:pre; overflow:hidden; }
    td.ln { width:50px; color:#666; text-align:right; user-select:none; background:var(--vscode-editorGutter-background); border-right:1px solid var(--vscode-panel-border); }
    td.src { white-space:pre; }
    td.src.d { background:#ef444422; }
    td.src.a { background:#10b98122; }
    td.src.e { background:#3a3a3a44; }
    tr.hunk-head td { background:#0e639c22; color:#7dd3fc; padding:6px 12px; font-style:italic; font-size:11px; }
  </style></head><body>
    <aside class="sidebar">
      <div class="sb-head">Changed Files (${files.length})</div>
      <div class="sb-meta"><span class="add">+${totalAdd}</span> additions · <span class="del">−${totalDel}</span> deletions</div>
      ${tree}
    </aside>
    <main class="main">
      <div class="header">
        <h1>Comparing changes</h1>
        <div><span class="ref">${esc(from)}</span> → <span class="ref">${esc(to)}</span></div>
      </div>
      ${filesHtml || '<em>No changes.</em>'}
    </main>
  </body></html>`;
}
