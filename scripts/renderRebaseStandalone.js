#!/usr/bin/env node
// Render Interactive Rebase mockup with real git log data
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = process.argv[2] || process.cwd();
const out = process.argv[3] || 'screenshots/rebase.html';
const onto = 'HEAD~8';

const sep = '\x1f', recSep = '\x1e';
const fmt = ['%H', '%h', '%an', '%ae', '%aI', '%s'].join(sep) + recSep;
const raw = execFileSync('git', ['log', `--pretty=format:${fmt}`, '--max-count=8'], { cwd: repo, encoding: 'utf8' });
const commits = raw.split(recSep).map(s => s.trim()).filter(Boolean).map(rec => {
  const [sha, shortSha, author, email, date, subject] = rec.split(sep);
  return { sha, shortSha, author, date: new Date(date), subject };
}).reverse();

function colorForAuthor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360},70%,60%)`;
}
function timeAgo(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${(s/60)|0}m ago`;
  if (s < 86400) return `${(s/3600)|0}h ago`;
  if (s < 86400*30) return `${(s/86400)|0}d ago`;
  return `${(s/(86400*30))|0}mo ago`;
}
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const actions = ['pick', 'pick', 'reword', 'pick', 'squash', 'fixup', 'edit', 'drop'];
const rows = commits.map((c, i) => {
  const action = actions[i] || 'pick';
  return `<div class="row ${action}" data-sha="${c.sha}">
    <span class="grip">⋮⋮</span>
    <select class="action">
      <option ${action==='pick'?'selected':''}>pick — use commit</option>
      <option ${action==='reword'?'selected':''}>reword — edit message</option>
      <option ${action==='edit'?'selected':''}>edit — pause for amend</option>
      <option ${action==='squash'?'selected':''}>squash — merge into previous</option>
      <option ${action==='fixup'?'selected':''}>fixup — squash, discard msg</option>
      <option ${action==='drop'?'selected':''}>drop — remove commit</option>
    </select>
    <span class="sha">${c.shortSha}</span>
    <span class="author" style="color:${colorForAuthor(c.author)}">${esc(c.author)}</span>
    <span class="ago">${timeAgo(c.date)}</span>
    <input class="msg" value="${esc(c.subject)}"/>
  </div>`;
}).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font: 13px -apple-system, 'SF Pro Text', system-ui, sans-serif; color:#d4d4d4; background:#1e1e1e; }
  .header { padding:14px 18px; border-bottom:1px solid #333; display:flex; justify-content:space-between; align-items:center; background:#252526; }
  .header h1 { margin:0; font-size:15px; font-weight:600; color:#e7e7e7; }
  .header .meta { color:#888; font-size:11px; margin-top:3px; }
  .actions { display:flex; gap:10px; }
  button { background:#0e639c; color:#fff; border:none; padding:7px 16px; border-radius:4px; cursor:pointer; font-weight:500; font-size:12px; }
  button.secondary { background:#3a3d41; }
  .list { padding:14px; }
  .row { display:flex; align-items:center; gap:12px; padding:9px 12px; background:#252526; border-radius:5px; margin-bottom:5px; border:1px solid #333; cursor:move; transition:.15s; }
  .row:hover { border-color:#0e639c80; }
  .row.drop { opacity:0.5; background:#3d1a1a; }
  .row.drop .msg { text-decoration:line-through; color:#888; }
  .row.squash, .row.fixup { background:#0e639c22; border-left:3px solid #0e639c; padding-left:9px; }
  .row.reword { border-left:3px solid #fbbf24; padding-left:9px; }
  .row.edit { border-left:3px solid #a855f7; padding-left:9px; }
  .grip { color:#555; cursor:grab; user-select:none; font-size:14px; }
  select.action { background:#1e1e1e; color:#d4d4d4; border:1px solid #444; padding:4px 8px; border-radius:3px; min-width:200px; font-size:11px; font-family:inherit; }
  .sha { font-family:'SF Mono',Menlo,monospace; color:#fbbf24; min-width:60px; font-size:12px; }
  .author { min-width:140px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
  .ago { color:#888; font-size:11px; min-width:65px; }
  .msg { flex:1; background:transparent; color:#d4d4d4; border:none; border-bottom:1px dashed transparent; padding:4px 6px; font:inherit; }
  .msg:focus { outline:none; border-bottom-color:#0e639c; }
  .help { padding:11px 18px; color:#888; font-size:11px; background:#252526; border-top:1px solid #333; }
</style></head><body>
  <div class="header">
    <div><h1>Interactive Rebase</h1><div class="meta">Rebasing ${commits.length} commits onto <code style="color:#fbbf24">${onto}</code></div></div>
    <div class="actions">
      <button class="secondary">Cancel</button>
      <button>Apply Rebase →</button>
    </div>
  </div>
  <div class="list">${rows}</div>
  <div class="help">💡 Drag commits to reorder. Squash/fixup merge into the commit <em>above</em>. Color stripe shows the action.</div>
</body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Wrote', out);
