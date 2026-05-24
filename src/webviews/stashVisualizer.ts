import * as vscode from 'vscode';
import { Git } from '../git/git';

/**
 * Stash visualizer — webview showing every stash with diff preview,
 * file-level changes, and partial-apply (cherry-pick specific files).
 */
export async function showStashVisualizer(git: Git) {
  const stashes = await git.stashes();
  if (!stashes.length) return vscode.window.showInformationMessage('No stashes. Create one with "GitSight: Stash Working Changes".');

  const panel = vscode.window.createWebviewPanel(
    'gitsight.stashVisualizer',
    'GitSight — Stashes',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const data = await Promise.all(stashes.map(async s => {
    const files = await git.raw(['stash', 'show', '--name-status', s.ref]).catch(() => '');
    const stat = await git.raw(['stash', 'show', '--stat', s.ref]).catch(() => '');
    return {
      ...s,
      date: s.date.toISOString(),
      files: files.split('\n').filter(Boolean).map(l => {
        const [status, ...rest] = l.split('\t');
        return { status: status?.trim() ?? '?', path: rest.join('\t').trim() };
      }),
      stat: stat.trim(),
    };
  }));

  panel.webview.html = render(data);

  panel.webview.onDidReceiveMessage(async msg => {
    const git2 = git;
    try {
      if (msg.cmd === 'apply') {
        await git2.stashApply(msg.ref);
        vscode.window.showInformationMessage(`Applied ${msg.ref}.`);
      } else if (msg.cmd === 'pop') {
        await git2.stashPop(msg.ref);
        vscode.window.showInformationMessage(`Popped ${msg.ref}.`);
        panel.dispose();
      } else if (msg.cmd === 'drop') {
        const ok = await vscode.window.showWarningMessage(`Drop ${msg.ref}?`, { modal: true }, 'Drop');
        if (ok !== 'Drop') return;
        await git2.stashDrop(msg.ref);
        vscode.window.showInformationMessage(`Dropped ${msg.ref}.`);
        panel.dispose();
      } else if (msg.cmd === 'applyFiles') {
        // partial apply: checkout specific files from stash tree
        for (const f of msg.files as string[]) {
          await git2.raw(['checkout', `${msg.ref}^{tree}`, '--', f]);
        }
        vscode.window.showInformationMessage(`Restored ${msg.files.length} file(s) from ${msg.ref}.`);
      } else if (msg.cmd === 'diff') {
        const out = await git2.raw(['stash', 'show', '-p', msg.ref]);
        const doc = await vscode.workspace.openTextDocument({ content: out, language: 'diff' });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Stash op failed: ${e?.message ?? e}`);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function render(stashes: any[]): string {
  const cards = stashes.map(s => {
    const files = s.files.map((f: any) => `
      <li class="file">
        <label>
          <input type="checkbox" data-ref="${s.ref}" data-file="${escapeHtml(f.path)}">
          <span class="st st-${f.status}">${f.status}</span>
          <span class="path">${escapeHtml(f.path)}</span>
        </label>
      </li>`).join('');
    return `
    <div class="stash">
      <header>
        <div class="title">
          <code>${s.ref}</code>
          <span class="branch">${escapeHtml(s.branch || '')}</span>
          <span class="date">${new Date(s.date).toLocaleString()}</span>
        </div>
        <div class="subject">${escapeHtml(s.subject)}</div>
      </header>
      <pre class="stat">${escapeHtml(s.stat)}</pre>
      <ul class="files">${files}</ul>
      <div class="actions">
        <button data-cmd="diff" data-ref="${s.ref}">View diff</button>
        <button data-cmd="applyFiles" data-ref="${s.ref}" class="primary">Apply selected files</button>
        <button data-cmd="apply" data-ref="${s.ref}">Apply all</button>
        <button data-cmd="pop" data-ref="${s.ref}">Pop</button>
        <button data-cmd="drop" data-ref="${s.ref}" class="danger">Drop</button>
      </div>
    </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme: dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--vscode-editor-background); color: var(--vscode-foreground); margin: 0; padding: 16px; }
    h1 { font-size: 18px; margin: 0 0 16px; }
    .stash { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
    header .title { display: flex; gap: 10px; align-items: baseline; }
    .title code { background: var(--vscode-textBlockQuote-background); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
    .title .branch { color: var(--vscode-charts-blue); font-size: 12px; }
    .title .date { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; }
    .subject { margin-top: 4px; font-weight: 500; }
    .stat { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; font-size: 11px; margin: 8px 0; overflow-x: auto; }
    .files { list-style: none; padding: 0; margin: 8px 0; max-height: 200px; overflow-y: auto; }
    .file { padding: 2px 0; font-size: 12px; }
    .file label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .st { width: 14px; text-align: center; font-weight: bold; font-family: monospace; }
    .st-M { color: #fbbf24; } .st-A { color: #34d399; } .st-D { color: #ef4444; } .st-R { color: #a78bfa; }
    .path { font-family: var(--vscode-editor-font-family); }
    .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.danger { background: #b91c1c; color: white; }
  </style></head><body>
    <h1>Stashes (${stashes.length})</h1>
    ${cards}
    <script>
      const vscode = acquireVsCodeApi();
      document.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        const cmd = b.dataset.cmd, ref = b.dataset.ref;
        if (cmd === 'applyFiles') {
          const files = [...document.querySelectorAll('input[type=checkbox][data-ref="'+ref+'"]:checked')].map(c => c.dataset.file);
          if (!files.length) { alert('Select at least one file to apply.'); return; }
          vscode.postMessage({ cmd, ref, files });
        } else {
          vscode.postMessage({ cmd, ref });
        }
      }));
    </script>
  </body></html>`;
}
