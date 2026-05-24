#!/usr/bin/env node
// Standalone renderer for the GitHub Issues sidebar screenshot.
const fs = require('fs');
const out = process.argv[2] || 'screenshots/issues.html';
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ago(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${(s/60)|0}m`;
  if (s < 86400) return `${(s/3600)|0}h`;
  if (s < 86400*30) return `${(s/86400)|0}d`;
  return `${(s/(86400*30))|0}mo`;
}

const issues = [
  { num: 2847, title: 'OAuth refresh tokens not rotating on /api/v2 endpoints', state: 'OPEN', author: 'kchen-stripe', updated: new Date(Date.now()-3600e3*2), labels:[{n:'bug',c:'#d73a4a'},{n:'priority:p0',c:'#b60205'},{n:'auth',c:'#fbca04'}], assignees:['sanjays2402'], comments: 14 },
  { num: 2845, title: 'Add Prometheus metrics exporter to subscription service', state: 'OPEN', author: 'mgonzalez', updated: new Date(Date.now()-3600e3*5), labels:[{n:'enhancement',c:'#a2eeef'},{n:'observability',c:'#0075ca'}], assignees:['sanjays2402','dchen'], comments: 8 },
  { num: 2842, title: 'Documentation: clarify rate-limit headers for webhook endpoints', state: 'OPEN', author: 'priyaram', updated: new Date(Date.now()-86400e3*1), labels:[{n:'docs',c:'#0075ca'},{n:'good-first-issue',c:'#7057ff'}], assignees:[], comments: 3 },
  { num: 2839, title: 'Flaky test: tests/payments.test.ts > "retries on 5xx" intermittent', state: 'OPEN', author: 'kenji-t', updated: new Date(Date.now()-86400e3*2), labels:[{n:'test',c:'#bfdadc'},{n:'flaky',c:'#fef2c0'}], assignees:[], comments: 6 },
  { num: 2836, title: 'Memory leak in WebSocket connection pool under high churn', state: 'OPEN', author: 'mwebb', updated: new Date(Date.now()-86400e3*3), labels:[{n:'bug',c:'#d73a4a'},{n:'performance',c:'#fbca04'}], assignees:['anjali-k'], comments: 22 },
  { num: 2831, title: 'feat: add support for ProtonMail SMTP server', state: 'OPEN', author: 'community-bot', updated: new Date(Date.now()-86400e3*5), labels:[{n:'enhancement',c:'#a2eeef'},{n:'help-wanted',c:'#008672'}], assignees:[], comments: 11 },
  { num: 2828, title: 'CVE-2026-3847: axios prototype pollution (CVSS 7.5)', state: 'CLOSED', author: 'dependabot', updated: new Date(Date.now()-86400e3*7), labels:[{n:'security',c:'#b60205'},{n:'dependencies',c:'#0366d6'}], assignees:['sanjays2402'], comments: 4 },
  { num: 2824, title: 'Dashboard breaks when user has > 1000 subscriptions', state: 'CLOSED', author: 'rachel-pm', updated: new Date(Date.now()-86400e3*10), labels:[{n:'bug',c:'#d73a4a'},{n:'frontend',c:'#c2e0c6'}], assignees:['mgonzalez'], comments: 9 },
  { num: 2819, title: 'Improve onboarding wizard copy', state: 'CLOSED', author: 'priyaram', updated: new Date(Date.now()-86400e3*14), labels:[{n:'docs',c:'#0075ca'}], assignees:['priyaram'], comments: 2 },
];

const open = issues.filter(i => i.state === 'OPEN');
const closed = issues.filter(i => i.state === 'CLOSED');

function iconFor(state) {
  if (state === 'OPEN') return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#4ade80"><circle cx="8" cy="8" r="7" stroke="#4ade80" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="2"/></svg>`;
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="#c084fc"><circle cx="8" cy="8" r="7" stroke="#c084fc" stroke-width="1.5" fill="none"/><path d="M5 8l2 2 4-4" stroke="#c084fc" stroke-width="1.8" fill="none"/></svg>`;
}

function row(i) {
  return `<div class="row">
    <div class="row-icon">${iconFor(i.state)}</div>
    <div class="row-body">
      <div class="row-title">#${i.num} ${esc(i.title)}</div>
      <div class="row-meta">
        ${i.labels.map(l=>`<span class="lbl" style="background:${l.c}; color:${getContrast(l.c)};">${esc(l.n)}</span>`).join('')}
        <span class="dim">${i.assignees.length?'@'+esc(i.assignees[0])+(i.assignees.length>1?' +'+(i.assignees.length-1):'')+' · ':''}${i.comments?'💬 '+i.comments+' · ':''}${ago(i.updated)} ago</span>
      </div>
    </div>
  </div>`;
}

function getContrast(hex) {
  const r=parseInt(hex.substr(1,2),16), g=parseInt(hex.substr(3,2),16), b=parseInt(hex.substr(5,2),16);
  return (r*299+g*587+b*114)/1000 > 128 ? '#000' : '#fff';
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font:13px -apple-system,system-ui,sans-serif; color:#cccccc; background:#1e1e1e; }
  .wrap { width:480px; background:#181818; border-right:1px solid #2b2b2b; min-height:100vh; }
  .vh { padding:10px 14px; background:#252526; border-bottom:1px solid #2b2b2b; display:flex; justify-content:space-between; align-items:center; }
  .vh .title { font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#cccccc; }
  .vh .actions { display:flex; gap:6px; color:#888; }
  .filter-bar { padding:8px 14px; background:#1f1f1f; border-bottom:1px solid #2b2b2b; display:flex; gap:6px; }
  .filter-bar .chip { padding:3px 10px; border-radius:11px; font-size:11px; background:#33333366; color:#9d9d9d; cursor:pointer; }
  .filter-bar .chip.active { background:#0e639c; color:#fff; }
  .group { padding:6px 14px; background:#1a1a1a; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:#9d9d9d; border-bottom:1px solid #2b2b2b; }
  .group .count { float:right; background:#33333366; padding:1px 8px; border-radius:10px; font-size:10px; }
  .row { padding:10px 14px; display:flex; gap:10px; border-bottom:1px solid #232323; cursor:pointer; }
  .row:hover { background:#2a2d2e; }
  .row-icon { padding-top:2px; flex-shrink:0; }
  .row-body { flex:1; min-width:0; }
  .row-title { font-size:13px; color:#cccccc; line-height:1.4; }
  .row-meta { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
  .lbl { padding:1px 7px; border-radius:10px; font-size:10px; font-weight:600; }
  .dim { color:#888; font-size:11px; }
</style></head><body>
  <div class="wrap">
    <div class="vh">
      <span class="title">Issues</span>
      <span class="actions">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="#888"><path d="M8 1v10M3 6l5-5 5 5M2 14h12" stroke="#888" stroke-width="1.5" fill="none"/></svg>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="#888"><path d="M8 3v10M3 8l5 5 5-5" stroke="#888" stroke-width="1.5" fill="none"/></svg>
      </span>
    </div>
    <div class="filter-bar">
      <span class="chip active">All</span>
      <span class="chip">Assigned to me</span>
      <span class="chip">Created by me</span>
    </div>
    <div class="group">Open <span class="count">${open.length}</span></div>
    ${open.map(row).join('')}
    <div class="group">Closed <span class="count">${closed.length}</span></div>
    ${closed.map(row).join('')}
  </div>
</body></html>`;
fs.writeFileSync(out, html);
console.log(out);
