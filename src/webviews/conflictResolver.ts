import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';

const pexec = promisify(execFile);

/**
 * Find all files currently in a merge conflict state and offer a 3-pane
 * resolver UI: BASE | LOCAL (ours) | REMOTE (theirs). User picks chunks
 * with click-to-accept buttons. Saves the resolved file and stages it.
 */
export async function showConflictResolver(git: Git) {
  const conflicts = await listConflicts(git);
  if (!conflicts.length) {
    vscode.window.showInformationMessage('No merge conflicts in working tree.');
    return;
  }

  const pick = conflicts.length === 1 ? conflicts[0] : await vscode.window.showQuickPick(
    conflicts.map(c => ({ label: c, description: `${c}` })),
    { placeHolder: `Pick a conflict to resolve (${conflicts.length} total)` }
  ).then(p => p?.label);
  if (!pick) return;

  const file = pick;
  const abs = path.join(git.cwd, file);
  const ours = await readStage(git.cwd, 2, file);
  const theirs = await readStage(git.cwd, 3, file);
  const base = await readStage(git.cwd, 1, file).catch(() => '');
  const merged = fs.readFileSync(abs, 'utf8');
  const chunks = parseConflictChunks(merged);

  const panel = vscode.window.createWebviewPanel(
    'gitsight.conflict',
    `Conflict: ${path.basename(file)}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = renderConflictUi(file, base, ours, theirs, chunks);

  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'save') {
      fs.writeFileSync(abs, msg.content);
      await pexec('git', ['add', '--', file], { cwd: git.cwd });
      vscode.window.showInformationMessage(`Resolved & staged: ${file}`);
      panel.dispose();
    }
  });
}

async function listConflicts(git: Git): Promise<string[]> {
  try {
    const { stdout } = await pexec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: git.cwd });
    return stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}
async function readStage(cwd: string, stage: 1 | 2 | 3, file: string): Promise<string> {
  try {
    const { stdout } = await pexec('git', ['show', `:${stage}:${file}`], { cwd, maxBuffer: 100 * 1024 * 1024 });
    return stdout;
  } catch { return ''; }
}

interface Chunk { kind: 'normal' | 'conflict'; text?: string; ours?: string; theirs?: string; base?: string; }

export function parseConflictChunks(merged: string): Chunk[] {
  const out: Chunk[] = [];
  const lines = merged.split('\n');
  let buf: string[] = [];
  let i = 0;
  const flushNormal = () => { if (buf.length) { out.push({ kind: 'normal', text: buf.join('\n') }); buf = []; } };

  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      flushNormal();
      const ours: string[] = [], theirs: string[] = [], base: string[] = [];
      let mode: 'o' | 'b' | 't' = 'o';
      i++;
      while (i < lines.length && !lines[i].startsWith('>>>>>>>')) {
        if (lines[i].startsWith('|||||||')) { mode = 'b'; i++; continue; }
        if (lines[i].startsWith('=======')) { mode = 't'; i++; continue; }
        (mode === 'o' ? ours : mode === 'b' ? base : theirs).push(lines[i]);
        i++;
      }
      i++; // skip >>>>>>>
      out.push({ kind: 'conflict', ours: ours.join('\n'), theirs: theirs.join('\n'), base: base.join('\n') });
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  flushNormal();
  return out;
}

const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderConflictUi(file: string, base: string, ours: string, theirs: string, chunks: Chunk[]): string {
  const chunkHtml = chunks.map((c, i) => {
    if (c.kind === 'normal') {
      return `<div class="chunk normal" data-i="${i}"><pre>${esc(c.text || '')}</pre></div>`;
    }
    return `<div class="chunk conflict" data-i="${i}">
      <div class="actions">
        <button onclick="accept(${i},'ours')">← Accept Ours</button>
        <button onclick="accept(${i},'theirs')">Accept Theirs →</button>
        <button onclick="accept(${i},'both')">Accept Both</button>
        <button onclick="accept(${i},'edit')">✎ Edit Manually</button>
      </div>
      <div class="cols">
        <div class="col ours"><div class="col-head">OURS (HEAD)</div><pre contenteditable="true" id="c${i}-ours">${esc(c.ours || '')}</pre></div>
        <div class="col theirs"><div class="col-head">THEIRS (incoming)</div><pre contenteditable="true" id="c${i}-theirs">${esc(c.theirs || '')}</pre></div>
      </div>
      ${c.base ? `<details class="base"><summary>Show base (common ancestor)</summary><pre>${esc(c.base)}</pre></details>` : ''}
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font:13px var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
    .header { padding:14px 18px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background); display:flex; justify-content:space-between; align-items:center; }
    .header h1 { margin:0; font-size:14px; }
    .header .meta { color:var(--vscode-descriptionForeground); font-size:11px; margin-top:3px; }
    .save { background:#10b981; color:white; border:none; padding:8px 18px; border-radius:4px; cursor:pointer; font-weight:600; }
    .save:hover { background:#0ea672; }
    .body { padding:16px; max-width:1400px; margin:0 auto; }
    .chunk { margin-bottom:8px; }
    .chunk.normal pre { background:var(--vscode-editorWidget-background); padding:10px 14px; border-radius:4px; margin:0; font-family:var(--vscode-editor-font-family); font-size:12px; white-space:pre; overflow-x:auto; }
    .chunk.conflict { border:2px solid #fbbf24; border-radius:6px; overflow:hidden; margin:14px 0; }
    .actions { background:#fbbf2422; padding:8px 12px; display:flex; gap:8px; }
    .actions button { background:var(--vscode-button-background,#0e639c); color:white; border:none; padding:5px 10px; border-radius:3px; cursor:pointer; font-size:11px; }
    .actions button:hover { opacity:0.9; }
    .cols { display:grid; grid-template-columns:1fr 1fr; }
    .col-head { padding:6px 10px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; }
    .col.ours .col-head { background:#10b98122; color:#4ade80; }
    .col.theirs .col-head { background:#a855f722; color:#c084fc; }
    .col pre { margin:0; padding:10px 14px; font-family:var(--vscode-editor-font-family); font-size:12px; white-space:pre; overflow-x:auto; min-height:40px; outline:none; }
    .col.ours pre { background:#10b98109; border-right:1px solid var(--vscode-panel-border); }
    .col.theirs pre { background:#a855f709; }
    .col pre:focus { background:#0e639c22; }
    details.base summary { cursor:pointer; padding:6px 12px; color:var(--vscode-descriptionForeground); font-size:11px; background:#33333366; }
    details.base pre { margin:0; padding:10px 14px; background:#33333344; font-family:var(--vscode-editor-font-family); font-size:11px; }
  </style></head><body>
    <div class="header">
      <div><h1>🔀 Resolving: ${esc(file)}</h1><div class="meta">${chunks.filter(c=>c.kind==='conflict').length} conflict region(s). Click Accept buttons or edit panes directly. Click Save & Stage when done.</div></div>
      <button class="save" onclick="save()">💾 Save & Stage</button>
    </div>
    <div class="body" id="body">${chunkHtml}</div>
    <script>
      const vscode = acquireVsCodeApi();
      const resolved = {};
      function accept(i, choice) {
        const node = document.querySelector('.chunk[data-i="'+i+'"]');
        const ours = document.getElementById('c'+i+'-ours').innerText;
        const theirs = document.getElementById('c'+i+'-theirs').innerText;
        let result;
        if (choice === 'ours') result = ours;
        else if (choice === 'theirs') result = theirs;
        else if (choice === 'both') result = ours + '\\n' + theirs;
        else { node.querySelector('.cols').style.background = '#fbbf2422'; return; }
        resolved[i] = result;
        node.style.opacity = '0.6';
        node.querySelector('.actions').innerHTML = '<span style="color:#4ade80;font-weight:600">✓ Resolved as ' + choice + '. <a href="#" onclick="undo('+i+');return false">undo</a></span>';
      }
      function undo(i) { delete resolved[i]; location.reload(); }
      function save() {
        const parts = [];
        document.querySelectorAll('.chunk').forEach(node => {
          const i = +node.dataset.i;
          if (node.classList.contains('normal')) parts.push(node.querySelector('pre').innerText);
          else if (i in resolved) parts.push(resolved[i]);
          else {
            const ours = document.getElementById('c'+i+'-ours').innerText;
            const theirs = document.getElementById('c'+i+'-theirs').innerText;
            parts.push('<<<<<<< HEAD\\n' + ours + '\\n=======\\n' + theirs + '\\n>>>>>>> incoming');
          }
        });
        vscode.postMessage({type:'save', content: parts.join('\\n')});
      }
    </script>
  </body></html>`;
}
