import * as vscode from 'vscode';
import { Git, Commit } from '../git/git';
import { timeAgo, colorForAuthor } from '../git/format';

type Action = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

let panel: vscode.WebviewPanel | undefined;

export async function showInteractiveRebase(git: Git) {
  const onto = await vscode.window.showInputBox({
    prompt: 'Rebase onto (branch/sha) or count of commits (e.g. HEAD~5)',
    value: 'HEAD~10',
  });
  if (!onto) return;
  const commits = await git.log({ max: 50, branch: `${onto}..HEAD` }).catch(async () =>
    await git.log({ max: 10 })
  );
  if (!commits.length) {
    vscode.window.showInformationMessage('No commits to rebase.');
    return;
  }

  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'gitsight.rebase',
      'GitSight: Interactive Rebase',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => (panel = undefined));
  } else panel.reveal();

  panel.title = `Rebase → ${onto}`;
  panel.webview.html = renderRebase(commits.reverse(), onto);

  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'apply') {
      try {
        await applyRebasePlan(git, msg.plan, onto);
        vscode.window.showInformationMessage('Rebase applied successfully.');
        panel?.dispose();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Rebase failed: ${e.message}. You may need to resolve conflicts.`);
      }
    } else if (msg.type === 'cancel') {
      panel?.dispose();
    }
  });
}

async function applyRebasePlan(
  git: Git,
  plan: { sha: string; action: Action; message?: string }[],
  onto: string
) {
  // Build a sequencer-style script via GIT_SEQUENCE_EDITOR
  const lines = plan
    .filter(p => p.action !== 'drop')
    .map(p => `${p.action} ${p.sha.slice(0, 7)} ${p.message ?? ''}`)
    .join('\n');
  const tmp = `/tmp/gitsight-rebase-${Date.now()}.txt`;
  require('fs').writeFileSync(tmp, lines + '\n');
  const editor = `cp '${tmp}' "$1"`;
  await require('util').promisify(require('child_process').execFile)(
    'git',
    ['rebase', '-i', onto],
    {
      cwd: git.cwd,
      env: { ...process.env, GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' },
    }
  );
}

function renderRebase(commits: Commit[], onto: string): string {
  const rows = commits.map(c => `
    <div class="row" draggable="true" data-sha="${c.sha}">
      <span class="grip">⋮⋮</span>
      <select class="action">
        <option value="pick">pick — use commit</option>
        <option value="reword">reword — edit message</option>
        <option value="edit">edit — pause for amend</option>
        <option value="squash">squash — merge into previous</option>
        <option value="fixup">fixup — squash, discard msg</option>
        <option value="drop">drop — remove commit</option>
      </select>
      <span class="sha">${c.shortSha}</span>
      <span class="author" style="color:${colorForAuthor(c.author)}">${esc(c.author)}</span>
      <span class="ago">${timeAgo(c.date)}</span>
      <input class="msg" value="${esc(c.subject)}"/>
    </div>
  `).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; font: 13px var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); }
    .header { padding:12px 16px; border-bottom:1px solid var(--vscode-panel-border); display:flex; justify-content:space-between; align-items:center; background:var(--vscode-editorWidget-background); }
    .header h1 { margin:0; font-size:14px; font-weight:600; }
    .header .meta { color: var(--vscode-descriptionForeground); font-size:11px; }
    .actions { display:flex; gap:8px; }
    button { background:var(--vscode-button-background, #0e639c); color:var(--vscode-button-foreground, #fff); border:none; padding:6px 14px; border-radius:3px; cursor:pointer; font-weight:500; }
    button.secondary { background:var(--vscode-button-secondaryBackground, #3a3d41); color:var(--vscode-button-secondaryForeground, #fff); }
    button:hover { opacity:0.9; }
    .list { padding:12px; }
    .row { display:flex; align-items:center; gap:10px; padding:8px 10px; background:var(--vscode-editorWidget-background); border-radius:4px; margin-bottom:4px; border:1px solid transparent; cursor:move; }
    .row:hover { border-color:#3a3a3a; }
    .row.dragging { opacity:0.4; }
    .row.over { border-color:#0e639c; }
    .grip { color:#555; cursor:grab; user-select:none; font-size:14px; }
    .row.drop, .row.squash, .row.fixup { opacity:0.6; }
    .row.drop .msg { text-decoration:line-through; color:#888; }
    .row.squash, .row.fixup { background:#0e639c22; }
    select.action { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:3px 6px; border-radius:3px; min-width:200px; font-size:11px; }
    .sha { font-family: var(--vscode-editor-font-family); color:#fbbf24; min-width:60px; }
    .author { min-width:120px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ago { color:var(--vscode-descriptionForeground); font-size:11px; min-width:60px; }
    .msg { flex:1; background:transparent; color:var(--vscode-foreground); border:none; border-bottom:1px dashed transparent; padding:3px 4px; font:inherit; }
    .msg:focus { outline:none; border-bottom-color: #0e639c; }
    .help { padding:10px 16px; color:var(--vscode-descriptionForeground); font-size:11px; background:var(--vscode-editorWidget-background); border-top:1px solid var(--vscode-panel-border); }
  </style></head><body>
    <div class="header">
      <div><h1>Interactive Rebase</h1><div class="meta">Rebasing ${commits.length} commits onto <code>${esc(onto)}</code></div></div>
      <div class="actions">
        <button class="secondary" id="cancel">Cancel</button>
        <button id="apply">Apply Rebase →</button>
      </div>
    </div>
    <div class="list" id="list">${rows}</div>
    <div class="help">Drag commits to reorder. Older commits at top, newer at bottom. Squash/fixup merge into the commit <em>above</em>.</div>
    <script>
      const vscode = acquireVsCodeApi();
      const list = document.getElementById('list');
      // Action highlighting
      list.addEventListener('change', e => {
        if (e.target.classList.contains('action')) {
          const row = e.target.closest('.row');
          row.classList.remove('pick','reword','edit','squash','fixup','drop');
          row.classList.add(e.target.value);
        }
      });
      // Drag reorder
      let dragEl = null;
      list.addEventListener('dragstart', e => {
        dragEl = e.target.closest('.row');
        dragEl.classList.add('dragging');
      });
      list.addEventListener('dragend', e => {
        dragEl?.classList.remove('dragging');
        document.querySelectorAll('.over').forEach(el => el.classList.remove('over'));
        dragEl = null;
      });
      list.addEventListener('dragover', e => {
        e.preventDefault();
        const target = e.target.closest('.row');
        if (target && target !== dragEl) {
          document.querySelectorAll('.over').forEach(el => el.classList.remove('over'));
          target.classList.add('over');
        }
      });
      list.addEventListener('drop', e => {
        e.preventDefault();
        const target = e.target.closest('.row');
        if (target && dragEl && target !== dragEl) {
          const rect = target.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          target.parentNode.insertBefore(dragEl, after ? target.nextSibling : target);
        }
      });
      document.getElementById('cancel').onclick = () => vscode.postMessage({type:'cancel'});
      document.getElementById('apply').onclick = () => {
        const plan = [...list.querySelectorAll('.row')].map(r => ({
          sha: r.dataset.sha,
          action: r.querySelector('.action').value,
          message: r.querySelector('.msg').value,
        }));
        vscode.postMessage({type:'apply', plan});
      };
    </script>
  </body></html>`;
}

function esc(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
