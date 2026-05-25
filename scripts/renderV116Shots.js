// Screenshots for v1.16 features: Stacked PR Navigator, Worktree Pill, Diff Word-Wrap.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const baseStyle = `
:root{
  --bg:#1e1e1e; --bg2:#252526; --bg3:#2d2d30; --fg:#cccccc; --muted:#9d9d9d;
  --border:#3c3c3c; --green:#4ec9b0; --red:#f48771; --yellow:#dcdcaa;
  --blue:#569cd6; --purple:#c586c0; --orange:#f97316;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);
  font-family:-apple-system,"Segoe UI",system-ui,sans-serif;font-size:13px;}
.vscode{display:flex;flex-direction:column;height:100vh;}
.titlebar{height:30px;background:#3c3c3c;display:flex;align-items:center;
  padding:0 12px;font-size:12px;color:#cccccc;justify-content:center;
  border-bottom:1px solid #1e1e1e;}
.body{display:flex;flex:1;min-height:0;}
.sidebar{width:48px;background:#333;display:flex;flex-direction:column;
  align-items:center;padding-top:8px;gap:14px;}
.sb-icon{width:28px;height:28px;display:flex;align-items:center;justify-content:center;
  color:#858585;font-size:18px;cursor:pointer;border-left:2px solid transparent;}
.sb-icon.active{color:#fff;border-left-color:#fff;}
.content{flex:1;display:flex;background:var(--bg);overflow:hidden;position:relative;}
.statusbar{height:22px;background:#007acc;color:#fff;display:flex;
  align-items:center;padding:0 8px;font-size:12px;gap:0;}
.sb-item{padding:0 8px;display:flex;align-items:center;gap:4px;height:22px;}
.sb-item.warn{background:#cc6633;}
.sb-item.err{background:#bf3a3a;}
.sb-item.ok{background:#1e7c1e;}
.sb-item.highlight{background:#005a9e;}
.panel{flex:1;padding:24px 32px;overflow:auto;}
h1{color:#fff;font-size:22px;font-weight:600;margin:0 0 12px;}
h2{color:#fff;font-size:16px;font-weight:600;margin:24px 0 12px;}
.muted{color:var(--muted);}
.code{font-family:"SF Mono",Menlo,Consolas,monospace;background:#1f1f1f;
  padding:1px 5px;border-radius:3px;font-size:12px;}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;}
.tag.green{background:rgba(78,201,176,0.15);color:var(--green);}
.tag.red{background:rgba(244,135,113,0.15);color:var(--red);}
.tag.yellow{background:rgba(220,220,170,0.15);color:var(--yellow);}
.tag.blue{background:rgba(86,156,214,0.15);color:var(--blue);}
.tag.purple{background:rgba(197,134,192,0.15);color:var(--purple);}
.tag.orange{background:rgba(249,115,22,0.15);color:var(--orange);}
`;

function chrome(html, png, w=1280, h=720){
  const tmp = `/tmp/gs-shot-${Date.now()}-${Math.random().toString(36).slice(2,7)}.html`;
  fs.writeFileSync(tmp, html);
  execFileSync(CHROME, [
    '--headless=new','--disable-gpu','--hide-scrollbars',
    `--window-size=${w},${h}`,
    `--screenshot=${png}`,
    `file://${tmp}`,
  ], {stdio:'ignore'});
  fs.unlinkSync(tmp);
  console.log('  →', path.basename(png));
}

function shell(title, sidebarHTML, contentHTML, statusbarHTML){
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="vscode">
<div class="titlebar">${title} — GitSight</div>
<div class="body">
  <div class="sidebar">${sidebarHTML}</div>
  <div class="content">${contentHTML}</div>
</div>
<div class="statusbar">${statusbarHTML}</div>
</div></body></html>`;
}

const SIDEBAR_DEFAULT = `
  <div class="sb-icon">📄</div>
  <div class="sb-icon">🔍</div>
  <div class="sb-icon active">🔀</div>
  <div class="sb-icon">▶️</div>
  <div class="sb-icon">🧩</div>`;

// ── 1. Stacked PR Navigator ─────────────────────────────────────
// Show the QuickPick floating over an editor, looking like VS Code's command palette.
const stackPick = shell(
  'Stacked PR Navigator',
  SIDEBAR_DEFAULT,
  `<div class="panel" style="opacity:0.35;filter:blur(0.5px);">
    <h1>🧱 Stacked PR Navigator</h1>
    <p class="muted">Graphite/Sapling-style chained branches. Auto-inferred from <span class="code">git merge-base</span>; overrides persisted in <span class="code">branch.&lt;name&gt;.gitsight-parent</span>.</p>
    <p class="muted" style="margin-top:60px;text-align:center;font-style:italic;">— editor dimmed while command palette is open —</p>
  </div>
  <!-- Floating QuickPick -->
  <div style="position:absolute;top:30px;left:50%;transform:translateX(-50%);width:720px;
              background:#252526;border:1px solid #454545;border-radius:6px;
              box-shadow:0 8px 24px rgba(0,0,0,0.6);">
    <div style="padding:10px 14px;border-bottom:1px solid #333;color:var(--muted);font-size:12px;">
      Stack: main → feat/auth-base → feat/auth-api → feat/auth-ui · cursor on feat/auth-ui
    </div>
    <div>
      ${[
        ['&nbsp;&nbsp;◯&nbsp;&nbsp;main', '', '(trunk)'],
        ['&nbsp;&nbsp;┬&nbsp;&nbsp;feat/auth-base', '↑2', 'tracks origin/feat/auth-base'],
        ['&nbsp;&nbsp;│&nbsp;&nbsp;feat/auth-api', '↑5', 'tracks origin/feat/auth-api'],
        ['▶ ┴&nbsp;&nbsp;feat/auth-ui', '↑3', 'current branch', true],
        ['<span style="color:#555">────────────────────────────────────────</span>', '', ''],
        ['↑&nbsp;&nbsp;Move up the stack', '→ feat/auth-api', ''],
        ['⤴&nbsp;&nbsp;Rebase onto parent', 'feat/auth-ui ← feat/auth-api', ''],
        ['🔄 Restack chain', 'Rebase entire stack from trunk up', ''],
        ['☁️ Submit stack', 'Push all 3 branch(es) to origin (atomic)', ''],
        ['＋&nbsp;&nbsp;Stack a new branch on top', 'Create child of feat/auth-ui', ''],
        ['🔗 Set parent of current branch…', 'Override inferred parent', ''],
      ].map(([label, desc, detail, sel]) => `
        <div style="padding:7px 16px;background:${sel?'#04395e':'transparent'};display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13px;border-bottom:1px solid #2a2a2a;">
          <div style="color:${sel?'#fff':'#cccccc'};">${label}</div>
          <div style="display:flex;gap:14px;flex-shrink:0;">
            ${desc?`<div style="color:${sel?'#cce4f5':'#9d9d9d'};font-size:12px;">${desc}</div>`:''}
            ${detail?`<div style="color:${sel?'#cce4f5':'#9d9d9d'};font-size:12px;font-style:italic;">${detail}</div>`:''}
          </div>
        </div>`).join('')}
    </div>
  </div>`,
  `<span class="sb-item">⎇ feat/auth-ui</span>
   <span class="sb-item">↑3 ↓0</span>
   <span class="sb-item highlight">🧱 main → base → api → ui</span>
   <span class="sb-item ok">✓ CI passed</span>
   <span class="sb-item" style="margin-left:auto">commits: 24 last 14d</span>`
);
chrome(stackPick, path.join(OUT,'stacked-pr-navigator.png'));

// ── 2. Worktree Status-Bar Pill ─────────────────────────────────
// Show 3 status bar shots stacked, plus the quick-pick reachable by clicking.
const worktreePill = shell(
  'Worktree Status-Bar Pill',
  SIDEBAR_DEFAULT,
  `<div class="panel">
    <h1>🌲 Worktree-Aware Status-Bar Pill</h1>
    <p class="muted">Current worktree always visible. Click to jump to another in a new window.</p>

    <h2>The pill (status bar, bottom of window)</h2>
    <div style="background:#252526;padding:18px 22px;border-radius:6px;border:1px solid #333;">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">In the gitsight main checkout</div>
      <div style="background:#007acc;color:#fff;padding:4px 10px;border-radius:3px;display:inline-flex;gap:14px;font-size:12px;font-family:-apple-system,monospace;">
        <span>⎇ main</span><span>↑0 ↓0</span>
        <span style="background:#005a9e;padding:0 6px;border-radius:2px;">🔱 gitsight  main</span>
        <span>✓ CI passed</span>
      </div>

      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:18px 0 8px;">After switching to a feature worktree</div>
      <div style="background:#007acc;color:#fff;padding:4px 10px;border-radius:3px;display:inline-flex;gap:14px;font-size:12px;font-family:-apple-system,monospace;">
        <span>⎇ feat/ai-review</span><span>↑5 ↓0</span>
        <span style="background:#005a9e;padding:0 6px;border-radius:2px;">🔱 feat-ai-review  feat/ai-review</span>
        <span>✓ CI passed</span>
      </div>

      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin:18px 0 8px;">In a release-prep worktree on a tag</div>
      <div style="background:#007acc;color:#fff;padding:4px 10px;border-radius:3px;display:inline-flex;gap:14px;font-size:12px;font-family:-apple-system,monospace;">
        <span>⎇ HEAD</span><span>↑0 ↓0</span>
        <span style="background:#005a9e;padding:0 6px;border-radius:2px;">🔱 release-v1.16  (detached)</span>
        <span>⚠ tag mode</span>
      </div>
    </div>

    <h2>Click → worktree switcher</h2>
    <div style="background:#252526;border:1px solid #454545;border-radius:6px;
                box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:680px;">
      <div style="padding:10px 14px;border-bottom:1px solid #333;color:var(--muted);font-size:12px;">
        Switch worktree (open in new window) · Cmd+Shift+W
      </div>
      ${[
        ['🔱 gitsight', '[main]', '/Volumes/Sanjay SSD/Projects/gitsight  ← current'],
        ['🔱 feat-ai-review', '[feat/ai-review]', '/Volumes/Sanjay SSD/Projects/gitsight-wt/ai-review'],
        ['🔱 feat-ci-panel', '[feat/ci-panel]', '/Volumes/Sanjay SSD/Projects/gitsight-wt/ci-panel  🔒 locked'],
        ['🔱 release-v1.16', '(detached)', '/Volumes/Sanjay SSD/Projects/gitsight-wt/release-v1.16'],
      ].map(([l,d,t],i)=>`
        <div style="padding:8px 14px;background:${i===0?'#04395e':'transparent'};">
          <div style="color:${i===0?'#fff':'#cccccc'};font-size:13px;">${l} <span style="color:#9d9d9d;font-size:12px;margin-left:8px;">${d}</span></div>
          <div style="color:#9d9d9d;font-size:11px;margin-top:2px;">${t}</div>
        </div>`).join('')}
      <div style="padding:8px 14px;color:var(--green);font-size:13px;border-top:1px solid #333;">＋ Create new worktree…</div>
      <div style="padding:8px 14px;color:var(--red);font-size:13px;">🗑 Remove a worktree…</div>
    </div>
  </div>`,
  `<span class="sb-item">⎇ main</span>
   <span class="sb-item">↑0 ↓0</span>
   <span class="sb-item highlight">🔱 gitsight  main</span>
   <span class="sb-item ok">✓ CI passed</span>
   <span class="sb-item" style="margin-left:auto">commits: 47 last 14d</span>`
);
chrome(worktreePill, path.join(OUT,'worktree-pill.png'), 1280, 820);

// ── 3. Diff Word-Wrap Toggle ────────────────────────────────────
// Show a side-by-side diff editor with the toolbar button visible and a long line.
const longLine = `      const message = \`Failed to fetch branch protection rules for \${repo.owner}/\${repo.name} on branch \${branch} because the GitHub API returned 403 Forbidden — verify the gh CLI is authenticated with sufficient scopes (repo, admin:repo_hook) and that you are a maintainer of the repo or have admin access via your team membership.\`;`;

const diffShell = `
<style>
.diff-tabs{display:flex;background:#2d2d30;border-bottom:1px solid #252526;height:35px;}
.diff-tab{padding:0 14px;display:flex;align-items:center;gap:6px;background:#1e1e1e;
  color:#fff;border-right:1px solid #252526;font-size:12px;border-top:2px solid #007acc;}
.toolbar{margin-left:auto;display:flex;gap:6px;padding:0 8px;align-items:center;}
.toolbtn{padding:4px 8px;color:#cccccc;cursor:pointer;border-radius:3px;font-size:14px;}
.toolbtn:hover{background:#383b3d;}
.toolbtn.active{background:#005a9e;color:#fff;}
.diff-body{display:grid;grid-template-columns:1fr 1fr;height:calc(100% - 35px);font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;line-height:1.5;}
.side{overflow:auto;padding:0;border-right:1px solid #252526;}
.row{display:flex;}
.gut{color:#858585;padding:0 8px;text-align:right;min-width:48px;border-right:1px solid #2b2b2b;user-select:none;flex-shrink:0;}
.txt{padding:0 12px;flex:1;}
.add{background:rgba(78,201,176,0.15);}
.rem{background:rgba(244,135,113,0.15);}
.nowrap .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.wrap .txt{white-space:pre-wrap;word-break:break-word;}
`;

function row(num, text, cls=''){
  return `<div class="row ${cls}"><div class="gut">${num}</div><div class="txt">${text}</div></div>`;
}

function diffPane(wrapMode){
  const cls = wrapMode ? 'wrap' : 'nowrap';
  return `
  <div class="side ${cls}">
    ${row(98,  'export async function branchProtection(repo: Repo, branch: string) {')}
    ${row(99,  '  try {')}
    ${row(100, '    const json = await ghApi(`repos/${repo.owner}/${repo.name}/branches/${branch}/protection`);')}
    ${row(101, '    return parseRules(json);')}
    ${row(102, '  } catch (e: any) {', 'rem')}
    ${row(103, '    throw new Error(e.message);', 'rem')}
    ${row(104, '  } catch (e: any) {', 'add')}
    ${row(105, longLine, 'add')}
    ${row(106, '    throw new Error(message, { cause: e });', 'add')}
    ${row(107, '  }')}
    ${row(108, '}')}
  </div>`;
}

const diffShot = shell(
  'src/views/branchProtection.ts (Working Tree) — Diff',
  SIDEBAR_DEFAULT,
  `<style>${diffShell}
   .pane-label{position:absolute;top:6px;background:#2d2d30;color:#cccccc;
     padding:3px 10px;border-radius:3px;font-size:11px;border:1px solid #454545;
     font-weight:600;letter-spacing:0.3px;z-index:5;}
   .pane-label.before{left:74px;color:var(--yellow);}
   .pane-label.after{left:calc(50% + 12px);color:var(--green);}
  </style>
  <div style="flex:1;display:flex;flex-direction:column;">
    <div class="diff-tabs">
      <div class="diff-tab">⇆ branchProtection.ts (Diff)</div>
      <div class="toolbar">
        <div class="toolbtn" title="History">🕒</div>
        <div class="toolbtn" title="Open File">📄</div>
        <div class="toolbtn active" title="GitSight: Toggle Word Wrap (Diff) — new in v1.16">↩</div>
        <div class="toolbtn" title="More…">⋯</div>
      </div>
    </div>
    <div class="diff-body" style="position:relative;padding-top:38px;">
      <div class="pane-label before">BEFORE — long line truncated ✂</div>
      <div class="pane-label after">AFTER ↩ — wrap on, line breaks naturally</div>
      ${diffPane(false)}
      ${diffPane(true)}
    </div>
  </div>`,
  `<span class="sb-item">⎇ main</span>
   <span class="sb-item">↑0 ↓0</span>
   <span class="sb-item highlight">↩ Word wrap toggled (Diff)</span>
   <span class="sb-item ok">✓ CI passed</span>
   <span class="sb-item" style="margin-left:auto">UTF-8  TypeScript</span>`
);
chrome(diffShot, path.join(OUT,'diff-word-wrap.png'), 1280, 760);

console.log('\n✨ Done. 3 PNGs in screenshots/');
