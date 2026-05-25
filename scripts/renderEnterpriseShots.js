// Generate HTML mockups + PNGs for the 5 enterprise features (1.11–1.15).
// Uses headless Chrome (already installed on macOS).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

function sparkSVG(heights, color){
  // heights: array of 0..1 floats; produces 14px tall x len*5 px wide bars
  const w=5, h=14, gap=1;
  const bars = heights.map((v,i)=>{
    const bh = Math.max(2, Math.round(v*h));
    return `<rect x="${i*w}" y="${h-bh}" width="${w-gap}" height="${bh}" fill="${color||'#fff'}" opacity="0.9"/>`;
  }).join('');
  return `<svg width="${heights.length*w}" height="${h}" style="vertical-align:middle;margin:0 4px;">${bars}</svg>`;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const baseStyle = `
:root{
  --bg:#1e1e1e; --bg2:#252526; --bg3:#2d2d30; --fg:#cccccc; --muted:#9d9d9d;
  --accent:#0e639c; --accentH:#1177bb; --border:#3c3c3c; --green:#4ec9b0;
  --red:#f48771; --yellow:#dcdcaa; --blue:#569cd6; --purple:#c586c0;
  --pill:#37373d;
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
.content{flex:1;display:flex;background:var(--bg);overflow:hidden;}
.statusbar{height:22px;background:#007acc;color:#fff;display:flex;
  align-items:center;padding:0 8px;font-size:12px;gap:10px;}
.sb-item{padding:0 8px;display:flex;align-items:center;gap:4px;height:22px;}
.sb-item.warn{background:#cc6633;}
.sb-item.err{background:#bf3a3a;}
.sb-item.ok{background:#1e7c1e;}
.panel{flex:1;padding:24px 32px;overflow:auto;}
h1,h2,h3{color:#fff;font-weight:600;margin:0 0 12px;}
h1{font-size:22px;} h2{font-size:16px;margin-top:24px;} h3{font-size:14px;}
table{border-collapse:collapse;width:100%;margin:8px 0;}
th,td{padding:8px 12px;border-bottom:1px solid var(--border);text-align:left;}
th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;}
.tag.green{background:rgba(78,201,176,0.15);color:var(--green);}
.tag.red{background:rgba(244,135,113,0.15);color:var(--red);}
.tag.yellow{background:rgba(220,220,170,0.15);color:var(--yellow);}
.tag.blue{background:rgba(86,156,214,0.15);color:var(--blue);}
.tag.purple{background:rgba(197,134,192,0.15);color:var(--purple);}
.muted{color:var(--muted);}
.code{font-family:"SF Mono",Menlo,Consolas,monospace;background:#1f1f1f;
  padding:1px 5px;border-radius:3px;font-size:12px;}
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

function shell(title, statusbarHTML, body){
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}</style></head>
<body><div class="vscode">
<div class="titlebar">${title} — GitSight</div>
<div class="body">
  <div class="sidebar">
    <div class="sb-icon">📄</div>
    <div class="sb-icon">🔍</div>
    <div class="sb-icon active">🔀</div>
    <div class="sb-icon">▶️</div>
    <div class="sb-icon">🧩</div>
  </div>
  <div class="content">${body}</div>
</div>
<div class="statusbar">${statusbarHTML}</div>
</div></body></html>`;
}

// ── 1.11 Branch Protection ─────────────────────────────────────
const protection = shell(
  'Branch Protection — main',
  `<span class="sb-item">⎇ main</span>
   <span class="sb-item">↑0 ↓0</span>
   <span class="sb-item ok">✓ CI build #842 passed</span>
   <span class="sb-item">🛡 main protected</span>
   <span class="sb-item" style="margin-left:auto">${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4])} 47</span>`,
  `<div class="panel">
    <h1>🛡 Branch protection — <span class="code">main</span></h1>
    <p class="muted">Source: <span class="code">gh api repos/Sanjays2402/gitsight/branches/main/protection</span></p>
    <table>
      <thead><tr><th>Setting</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>Requires pull request reviews</td><td>✅ <span class="muted">(≥ 2 approvers)</span></td></tr>
        <tr><td>Requires status checks</td><td>✅</td></tr>
        <tr><td>Required checks</td><td>
          <span class="tag blue">build</span>
          <span class="tag blue">test</span>
          <span class="tag blue">lint</span>
          <span class="tag blue">type-check</span>
        </td></tr>
        <tr><td>Requires linear history</td><td>✅</td></tr>
        <tr><td>Requires signed commits</td><td>✅</td></tr>
        <tr><td>Enforce on admins</td><td>✅</td></tr>
        <tr><td>Restricts who can push</td><td>✅ <span class="muted">(maintainers only)</span></td></tr>
        <tr><td>Allows force push</td><td>⬜</td></tr>
        <tr><td>Allows branch deletion</td><td>⬜</td></tr>
      </tbody>
    </table>
    <h2>Bypass actors</h2>
    <p><span class="tag purple">@release-bot</span> <span class="tag purple">@platform-admins</span></p>
  </div>`
);
chrome(protection, path.join(OUT,'branch-protection.png'));

// ── 1.12 CODEOWNERS Overlay ────────────────────────────────────
const codeowners = shell(
  'CODEOWNERS — src/auth/oauth.ts',
  `<span class="sb-item">⎇ feature/auth-refactor</span>
   <span class="sb-item">↑3 ↓0</span>
   <span class="sb-item warn">👤 @security-team +1</span>
   <span class="sb-item ok">✓ Actions passed</span>
   <span class="sb-item" style="margin-left:auto">${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4])} 23</span>`,
  `<div class="panel">
    <h1>👥 CODEOWNERS — <span class="code">src/auth/oauth.ts</span></h1>
    <p>Owners: <span class="tag purple">@security-team</span> <span class="tag purple">@auth-leads</span></p>
    <h2>Staged-files ownership check</h2>
    <p class="muted">3 of 5 staged files need review from owners you're not part of:</p>
    <table>
      <thead><tr><th>File</th><th>Required owners</th><th>You own?</th></tr></thead>
      <tbody>
        <tr><td><span class="code">src/auth/oauth.ts</span></td><td>@security-team, @auth-leads</td><td><span class="tag red">No</span></td></tr>
        <tr><td><span class="code">src/auth/jwt.ts</span></td><td>@security-team</td><td><span class="tag red">No</span></td></tr>
        <tr><td><span class="code">infra/secrets.yaml</span></td><td>@platform-admins</td><td><span class="tag red">No</span></td></tr>
        <tr><td><span class="code">src/ui/login.tsx</span></td><td>@ui-team, @sanjays2402</td><td><span class="tag green">Yes</span></td></tr>
        <tr><td><span class="code">README.md</span></td><td>@sanjays2402</td><td><span class="tag green">Yes</span></td></tr>
      </tbody>
    </table>
    <h2>All rules</h2>
    <ul style="line-height:1.8;padding-left:20px;">
      <li><span class="code">*</span> → @sanjays2402</li>
      <li><span class="code">/src/auth/**</span> → @security-team @auth-leads</li>
      <li><span class="code">/src/ui/**</span> → @ui-team</li>
      <li><span class="code">/infra/**</span> → @platform-admins</li>
      <li><span class="code">/docs/**</span> → @docs-team</li>
    </ul>
  </div>`
);
chrome(codeowners, path.join(OUT,'codeowners-overlay.png'));

// ── 1.13 CI Status Panel ───────────────────────────────────────
const ci = shell(
  'CI Runs — GitHub Actions',
  `<span class="sb-item">⎇ main</span>
   <span class="sb-item">↑0 ↓0</span>
   <span class="sb-item ok">🚀 CI build #842</span>
   <span class="sb-item">👤 @sanjays2402</span>
   <span class="sb-item" style="margin-left:auto">${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4])} 47</span>`,
  `<div class="panel">
    <h1>🚀 CI runs <span class="muted" style="font-size:14px">— GitHub Actions, newest first</span></h1>
    <table>
      <thead><tr><th>Status</th><th>Workflow</th><th>Branch</th><th>Duration</th><th>When</th></tr></thead>
      <tbody>
        <tr><td>✅ <span class="tag green">success</span></td><td>CI / build & test</td><td><span class="code">main</span></td><td>2m 41s</td><td>3 min ago</td></tr>
        <tr><td>✅ <span class="tag green">success</span></td><td>CI / lint</td><td><span class="code">main</span></td><td>0m 38s</td><td>3 min ago</td></tr>
        <tr><td>🔄 <span class="tag yellow">in_progress</span></td><td>Nightly e2e</td><td><span class="code">main</span></td><td>4m 12s</td><td>4 min ago</td></tr>
        <tr><td>❌ <span class="tag red">failure</span></td><td>CI / build & test</td><td><span class="code">feature/ai-review</span></td><td>1m 53s</td><td>22 min ago</td></tr>
        <tr><td>✅ <span class="tag green">success</span></td><td>Release / publish-vsix</td><td><span class="code">v1.14.0</span></td><td>1m 09s</td><td>1 hour ago</td></tr>
        <tr><td>✅ <span class="tag green">success</span></td><td>CodeQL</td><td><span class="code">main</span></td><td>5m 47s</td><td>1 hour ago</td></tr>
        <tr><td>⏹ <span class="tag" style="background:#3c3c3c;color:#aaa">cancelled</span></td><td>CI / build & test</td><td><span class="code">feature/sparkline</span></td><td>0m 12s</td><td>2 hours ago</td></tr>
        <tr><td>✅ <span class="tag green">success</span></td><td>CI / build & test</td><td><span class="code">feature/ci-panel</span></td><td>2m 33s</td><td>3 hours ago</td></tr>
      </tbody>
    </table>
    <p class="muted">Click any row to open in browser. Auto-refreshes every 60s. Works identically with Azure Pipelines via <span class="code">az pipelines runs list</span>.</p>
  </div>`
);
chrome(ci, path.join(OUT,'ci-status-panel.png'));

// ── 1.14 Sparkline ─────────────────────────────────────────────
const sparkline = shell(
  'Commit Sparkline — last 14 days',
  `<span class="sb-item">⎇ main</span>
   <span class="sb-item">↑0 ↓0</span>
   <span class="sb-item ok">✓ CI passed</span>
   <span class="sb-item" style="background:#005a9e">📈 ${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4],'#4ec9b0')} 47</span>
   <span class="sb-item" style="margin-left:auto">👤 @sanjays2402</span>`,
  `<div class="panel">
    <h1>📈 Commit sparkline</h1>
    <p class="muted">Status-bar pill at a glance — <span class="code" style="background:#1f1f1f;padding:2px 6px;">${sparkSVG([0.2,0.4,0.6,0.8,1.0,0.7,0.5],'#dcdcaa')}</span> bars + total count over the configured window.</p>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:24px;">
      <div style="background:#252526;padding:18px 22px;border-radius:6px;border:1px solid #333;min-width:260px;">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Last 7 days · me</div>
        <div style="font-family:monospace;font-size:32px;margin:8px 0;color:#4ec9b0;">${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4])} 18</div>
        <div class="muted">3 commits/day avg · current streak: 7 days 🔥</div>
      </div>
      <div style="background:#252526;padding:18px 22px;border-radius:6px;border:1px solid #333;min-width:260px;">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Last 14 days · all contributors</div>
        <div style="font-family:monospace;font-size:32px;margin:8px 0;color:#569cd6;">${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4])} 47</div>
        <div class="muted">3.4 commits/day · 5 contributors</div>
      </div>
      <div style="background:#252526;padding:18px 22px;border-radius:6px;border:1px solid #333;min-width:260px;">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Last 30 days · me</div>
        <div style="font-family:monospace;font-size:32px;margin:8px 0;color:#c586c0;">${sparkSVG([0.1,0.2,0.3,0.4,0.5,0.6,0.7,1.0,0.7,0.5,0.4,0.3,0.2,0.4])} 89</div>
        <div class="muted">2.97 commits/day · longest streak: 14 days</div>
      </div>
    </div>
    <h2 style="margin-top:32px;">Configuration</h2>
    <table>
      <thead><tr><th>Setting</th><th>Value</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><span class="code">gitsight.sparkline.days</span></td><td>14</td><td>Window in days (1–90)</td></tr>
        <tr><td><span class="code">gitsight.sparkline.author</span></td><td><span class="tag blue">me</span></td><td>Either <span class="code">all</span> or <span class="code">me</span></td></tr>
      </tbody>
    </table>
    <p class="muted">Click the status-bar item to jump to the full contribution heatmap. Auto-refreshes every 5 minutes.</p>
  </div>`
);
chrome(sparkline, path.join(OUT,'commit-sparkline.png'));

// ── 1.15 Graph Themes ──────────────────────────────────────────
const THEMES = {
  'Default':         ['#f97316','#3b82f6','#10b981','#ec4899','#a855f7','#eab308','#06b6d4','#ef4444'],
  'Catppuccin Mocha':['#f5a97f','#8aadf4','#a6da95','#f5bde6','#c6a0f6','#eed49f','#7dc4e4','#ed8796'],
  'Tokyo Night':     ['#ff9e64','#7aa2f7','#9ece6a','#bb9af7','#c0caf5','#e0af68','#7dcfff','#f7768e'],
  'Dracula':         ['#ffb86c','#8be9fd','#50fa7b','#ff79c6','#bd93f9','#f1fa8c','#6272a4','#ff5555'],
  'Nord':            ['#d08770','#5e81ac','#a3be8c','#b48ead','#88c0d0','#ebcb8b','#81a1c1','#bf616a'],
  'Gruvbox':         ['#fe8019','#83a598','#b8bb26','#d3869b','#d65d0e','#fabd2f','#8ec07c','#fb4934'],
  'Solarized':       ['#cb4b16','#268bd2','#859900','#d33682','#6c71c4','#b58900','#2aa198','#dc322f'],
  'Monochrome':      ['#e5e7eb','#9ca3af','#6b7280','#d1d5db','#9ca3af','#a3a3a3','#737373','#525252'],
};

function graphSVG(palette){
  // 6 lanes, 8 rows, looks like a real commit graph
  const rowH = 28, w = 180;
  const lanes = [0,1,2,3,4,5];
  let svg = `<svg width="${w}" height="${rowH*8}" xmlns="http://www.w3.org/2000/svg">`;
  // vertical lines
  for (let r=0;r<8;r++){
    for (const l of lanes){
      const x = 16 + l*20;
      const y = r*rowH;
      const color = palette[l % palette.length];
      // skip some to make it look organic
      if (r===2 && l===5) continue;
      if (r===5 && l===4) continue;
      if (r===7 && l>=3) continue;
      svg += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y+rowH}" stroke="${color}" stroke-width="2"/>`;
    }
  }
  // merge curves
  svg += `<path d="M${16+5*20},${rowH*2} C${16+5*20},${rowH*2.4} ${16+2*20},${rowH*2.6} ${16+2*20},${rowH*3}" stroke="${palette[5%palette.length]}" stroke-width="2" fill="none"/>`;
  svg += `<path d="M${16+4*20},${rowH*5} C${16+4*20},${rowH*5.4} ${16+1*20},${rowH*5.6} ${16+1*20},${rowH*6}" stroke="${palette[4%palette.length]}" stroke-width="2" fill="none"/>`;
  // commit dots
  const dots = [[0,0],[1,1],[2,2],[3,3],[2,4],[0,5],[1,6],[0,7]];
  for (const [l,r] of dots){
    const x = 16 + l*20, y = r*rowH + rowH/2;
    svg += `<circle cx="${x}" cy="${y}" r="5" fill="${palette[l%palette.length]}" stroke="#1e1e1e" stroke-width="2"/>`;
  }
  svg += `</svg>`;
  return svg;
}

const themesGrid = Object.entries(THEMES).map(([name,p]) => `
  <div style="background:#252526;border:1px solid #333;border-radius:6px;padding:14px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong style="color:#fff;">${name}</strong>
      <div style="display:flex;gap:3px;">${p.slice(0,8).map(c=>`<span style="width:10px;height:10px;border-radius:50%;background:${c};display:inline-block;"></span>`).join('')}</div>
    </div>
    ${graphSVG(p)}
  </div>`).join('');

const themesPage = shell(
  'Commit Graph — Themes',
  `<span class="sb-item">⎇ main</span>
   <span class="sb-item">↑0 ↓0</span>
   <span class="sb-item ok">✓ CI passed</span>
   <span class="sb-item" style="margin-left:auto">🎨 graph.theme: tokyo-night</span>`,
  `<div class="panel">
    <h1>🎨 Commit Graph — 8 themes</h1>
    <p class="muted">Pick via <span class="code">GitSight: Pick Commit Graph Theme…</span> or set <span class="code">gitsight.graph.theme</span> in settings. All themes use carefully matched accent palettes — no harsh defaults.</p>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px;">
      ${themesGrid}
    </div>
  </div>`
);
chrome(themesPage, path.join(OUT,'graph-themes.png'), 1280, 760);

console.log('\n✨ Done. 5 PNGs in screenshots/');
