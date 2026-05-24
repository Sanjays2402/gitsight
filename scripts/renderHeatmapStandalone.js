#!/usr/bin/env node
// Render Blame Heatmap mockup with real git blame data
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = process.argv[2] || process.cwd();
const file = process.argv[3] || 'src/extension.ts';
const out = process.argv[4] || 'screenshots/heatmap.html';

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
}

const content = git(['show', `HEAD:${file}`]).split('\n');
const blameOut = git(['blame', '--porcelain', file]);
const lines = blameOut.split('\n');

const commits = new Map();
const blame = [];
let i = 0;
while (i < lines.length) {
  const m = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(lines[i]);
  if (m) {
    const sha = m[1];
    let j = i + 1;
    const meta = {};
    while (j < lines.length && !lines[j].startsWith('\t')) {
      const sp = lines[j].indexOf(' ');
      if (sp === -1) meta[lines[j]] = '';
      else meta[lines[j].slice(0, sp)] = lines[j].slice(sp + 1);
      j++;
    }
    if (!commits.has(sha)) {
      commits.set(sha, {
        author: meta['author'] || 'Unknown',
        date: parseInt(meta['author-time'] || '0', 10) * 1000,
        summary: meta['summary'] || '',
      });
    }
    blame.push({ sha, ...commits.get(sha) });
    i = j + 1;
  } else i++;
}

function colorForAuthor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360},70%,55%)`;
}

function heatmapColor(dateMs, coldDays = 365) {
  const ageDays = (Date.now() - dateMs) / (1000 * 60 * 60 * 24);
  const t = Math.max(0, Math.min(1, 1 - ageDays / coldDays));
  // hot (recent) = orange/red, cold (old) = blue
  const r = Math.round(255 * t + 60 * (1 - t));
  const g = Math.round(120 * t + 100 * (1 - t));
  const b = Math.round(40 * t + 220 * (1 - t));
  return `rgb(${r},${g},${b})`;
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return `${(s | 0)}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  if (s < 86400) return `${(s / 3600) | 0}h ago`;
  if (s < 86400 * 30) return `${(s / 86400) | 0}d ago`;
  if (s < 86400 * 365) return `${(s / (86400 * 30)) | 0}mo ago`;
  return `${(s / (86400 * 365)) | 0}y ago`;
}

const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const maxLines = Math.min(content.length, 60);
const rows = [];
for (let k = 0; k < maxLines; k++) {
  const src = content[k] || '';
  const b = blame[k];
  if (!b) { rows.push(`<div class="row"><span class="ln">${k+1}</span><span class="src">${esc(src)}</span></div>`); continue; }
  const heat = heatmapColor(b.date);
  const author = colorForAuthor(b.author);
  rows.push(`<div class="row" title="${esc(b.author)} • ${timeAgo(b.date)} • ${esc(b.summary)}">
    <span class="heat" style="background:${heat}"></span>
    <span class="dot" style="background:${author}"></span>
    <span class="sha">${b.sha.slice(0, 7)}</span>
    <span class="author">${esc(b.author.slice(0, 18).padEnd(18))}</span>
    <span class="ago">${timeAgo(b.date).padStart(7)}</span>
    <span class="ln">${k + 1}</span>
    <span class="src">${esc(src)}</span>
  </div>`);
}

const byAuthor = new Map();
for (const b of blame) byAuthor.set(b.author, (byAuthor.get(b.author) || 0) + 1);
const total = blame.length;
const top = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const legend = top.map(([a, n]) =>
  `<div class="lg-item"><span class="dot" style="background:${colorForAuthor(a)}"></span>${esc(a)}<span class="lg-n">${n} (${((n/total)*100|0)}%)</span></div>`
).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font-family: 'SF Mono', Menlo, monospace; color:#d4d4d4; background:#1e1e1e; font-size:12px; }
  .toolbar { display:flex; padding:10px 14px; gap:14px; border-bottom:1px solid #333; align-items:center; background:#252526; }
  .toolbar h2 { font-size:13px; margin:0; font-weight:600; color:#e7e7e7; font-family:-apple-system,sans-serif; }
  .toolbar .meta { color:#888; font-size:11px; font-family:-apple-system,sans-serif; }
  .legend { display:flex; gap:6px; flex-wrap:wrap; padding:8px 14px; background:#252526; border-bottom:1px solid #333; font-family:-apple-system,sans-serif; }
  .lg-item { display:inline-flex; align-items:center; gap:5px; font-size:11px; padding:3px 8px; background:#2d2d30; border-radius:10px; }
  .lg-n { color:#888; margin-left:3px; }
  .dot { width:8px; height:8px; border-radius:4px; display:inline-block; }
  .row { display:flex; align-items:center; gap:10px; padding:0 14px; height:22px; white-space:pre; line-height:22px; }
  .row:hover { background:#2a2d2e; }
  .heat { width:5px; height:22px; flex-shrink:0; }
  .sha { color:#fbbf24; width:60px; flex-shrink:0; }
  .author { color:#9d9d9d; width:140px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; }
  .ago { color:#6a9955; width:70px; flex-shrink:0; }
  .ln { color:#555; width:40px; text-align:right; flex-shrink:0; }
  .src { flex:1; color:#d4d4d4; overflow:hidden; text-overflow:ellipsis; }
</style></head><body>
  <div class="toolbar"><h2>🔥 ${path.basename(file)}</h2><span class="meta">${blame.length} lines · ${byAuthor.size} authors · Heatmap colors: 🔴 recent → 🔵 old</span></div>
  <div class="legend">${legend}</div>
  ${rows.join('')}
</body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Wrote', out);
