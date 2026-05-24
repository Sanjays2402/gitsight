#!/usr/bin/env node
// Render GitHub PR sidebar mockup using real gh CLI data (or fallback synthetic).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = process.argv[2] || process.cwd();
const out = process.argv[3] || 'screenshots/prs.html';

function timeAgo(d) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${(s/60)|0}m`;
  if (s < 86400) return `${(s/3600)|0}h`;
  if (s < 86400*30) return `${(s/86400)|0}d`;
  return `${(s/(86400*30))|0}mo`;
}
const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Synthetic enterprise-realistic PR data (works without gh auth)
const prs = [
  { number: 4821, title: 'feat(graph): add interactive commit graph with lane coloring', state: 'OPEN', isDraft: false, author: 'alex-chen', updatedAt: new Date(Date.now()-3600e3*2), additions: 487, deletions: 23, checks: 'PENDING', review: 'REVIEW_REQUIRED' },
  { number: 4819, title: 'fix(blame): handle binary files gracefully in heatmap', state: 'OPEN', isDraft: false, author: 'priya-r', updatedAt: new Date(Date.now()-3600e3*5), additions: 34, deletions: 12, checks: 'SUCCESS', review: 'APPROVED' },
  { number: 4815, title: 'refactor: extract Git command runner into pooled executor', state: 'OPEN', isDraft: false, author: 'marcus-w', updatedAt: new Date(Date.now()-86400e3*1), additions: 312, deletions: 198, checks: 'FAILURE', review: 'CHANGES_REQUESTED' },
  { number: 4810, title: 'WIP: experimental git-lfs support', state: 'OPEN', isDraft: true, author: 'sanjay', updatedAt: new Date(Date.now()-86400e3*3), additions: 156, deletions: 4, checks: 'PENDING', review: null },
  { number: 4808, title: 'feat(rebase): live preview of squash result', state: 'MERGED', isDraft: false, author: 'alex-chen', updatedAt: new Date(Date.now()-86400e3*4), additions: 89, deletions: 14, checks: 'SUCCESS', review: 'APPROVED' },
  { number: 4801, title: 'docs: add contributor guide and architecture overview', state: 'MERGED', isDraft: false, author: 'priya-r', updatedAt: new Date(Date.now()-86400e3*6), additions: 412, deletions: 0, checks: 'SUCCESS', review: 'APPROVED' },
  { number: 4795, title: 'chore(deps): bump @types/vscode to ^1.85.0', state: 'MERGED', isDraft: false, author: 'dependabot', updatedAt: new Date(Date.now()-86400e3*8), additions: 4, deletions: 4, checks: 'SUCCESS', review: 'APPROVED' },
  { number: 4790, title: 'fix(worktree): correctly resolve relative paths on Windows', state: 'CLOSED', isDraft: false, author: 'kenji-t', updatedAt: new Date(Date.now()-86400e3*12), additions: 23, deletions: 8, checks: 'FAILURE', review: 'CHANGES_REQUESTED' },
];

const groups = { OPEN: [], DRAFT: [], MERGED: [], CLOSED: [] };
for (const pr of prs) {
  const k = pr.isDraft ? 'DRAFT' : pr.state;
  groups[k].push(pr);
}

const iconFor = pr => {
  if (pr.isDraft) return '<svg width="14" height="14" viewBox="0 0 16 16" fill="#888"><circle cx="8" cy="8" r="6" stroke="#888" stroke-width="1.5" fill="none" stroke-dasharray="2 2"/></svg>';
  if (pr.state === 'MERGED') return '<svg width="14" height="14" viewBox="0 0 16 16" fill="#a855f7"><path d="M5 3a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 5h.5a3.5 3.5 0 0 1 3.5 3.5V9h-1V8.5A2.5 2.5 0 0 0 7.5 6H7v5h1v1H4v-1h2V6H5V5h2z"/></svg>';
  if (pr.state === 'CLOSED') return '<svg width="14" height="14" viewBox="0 0 16 16" fill="#888"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M11 10l3-3M11 7l3 3" stroke="#888" stroke-width="1.5" fill="none"/></svg>';
  return '<svg width="14" height="14" viewBox="0 0 16 16" fill="#4ade80"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M4 6v4M11 14a3 3 0 0 0 3-3V5" stroke="#4ade80" stroke-width="1.5" fill="none"/><circle cx="11" cy="3" r="2"/></svg>';
};

const checkBadge = c => c === 'SUCCESS' ? '<span class="badge ok">✓</span>' : c === 'FAILURE' ? '<span class="badge fail">✗</span>' : c === 'PENDING' ? '<span class="badge pending">●</span>' : '';
const reviewBadge = r => r === 'APPROVED' ? '<span class="badge ok">✓ APP</span>' : r === 'CHANGES_REQUESTED' ? '<span class="badge fail">✗ REQ</span>' : r === 'REVIEW_REQUIRED' ? '<span class="badge pending">◐ REV</span>' : '';

function groupHtml(name, list) {
  if (!list.length) return '';
  const rows = list.map(pr => `
    <div class="pr">
      <div class="pr-line1">
        <span class="icon">${iconFor(pr)}</span>
        <span class="num">#${pr.number}</span>
        <span class="title">${esc(pr.title)}</span>
      </div>
      <div class="pr-line2">
        <span class="author">@${esc(pr.author)}</span>
        ${checkBadge(pr.checks)} ${reviewBadge(pr.review)}
        <span class="diff"><span class="add">+${pr.additions}</span> <span class="del">−${pr.deletions}</span></span>
        <span class="ago">${timeAgo(pr.updatedAt)}</span>
      </div>
    </div>
  `).join('');
  return `<div class="group"><div class="group-head">▼ ${name} · ${list.length}</div>${rows}</div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font: 12px -apple-system, system-ui, sans-serif; color:#cccccc; background:#252526; }
  .panel-head { display:flex; justify-content:space-between; align-items:center; padding:6px 12px 6px 16px; background:#2d2d30; border-bottom:1px solid #1c1c1c; text-transform:uppercase; font-size:11px; font-weight:600; color:#e7e7e7; letter-spacing:.5px; }
  .panel-head .acts { display:flex; gap:4px; }
  .panel-head .acts svg { width:14px; height:14px; padding:3px; border-radius:3px; cursor:pointer; opacity:0.8; }
  .panel-head .acts svg:hover { background:#3e3e42; opacity:1; }
  .group-head { padding:6px 12px; font-size:11px; color:#888; font-weight:600; letter-spacing:.5px; background:#2a2a2c; }
  .pr { padding:7px 14px 7px 28px; cursor:pointer; border-bottom:1px solid #1a1a1c; }
  .pr:hover { background:#2a2d2e; }
  .pr-line1 { display:flex; align-items:center; gap:7px; margin-bottom:2px; }
  .icon { display:inline-flex; }
  .num { color:#888; font-family:'SF Mono',Menlo,monospace; font-size:11px; }
  .title { color:#e7e7e7; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pr-line2 { display:flex; align-items:center; gap:6px; padding-left:21px; color:#888; font-size:10.5px; }
  .author { color:#9cdcfe; }
  .badge { padding:1px 5px; border-radius:8px; font-size:9.5px; font-weight:600; }
  .badge.ok { background:#10b98133; color:#4ade80; }
  .badge.fail { background:#ef444433; color:#f87171; }
  .badge.pending { background:#fbbf2433; color:#fbbf24; }
  .diff { margin-left:auto; font-family:'SF Mono',Menlo,monospace; }
  .add { color:#4ade80; } .del { color:#f87171; }
  .ago { color:#666; margin-left:6px; min-width:24px; text-align:right; }
</style></head><body>
  <div class="panel-head">
    <span>Pull Requests</span>
    <div class="acts">
      <svg viewBox="0 0 16 16" fill="#cccccc" title="Refresh"><path d="M13 4.5L11 6.5h4V2.5L13 4.5z M3 11.5l2-2H1v4l2-2z M8 2a6 6 0 0 0-5.66 4h1.06A5 5 0 0 1 8 3v1l3-2.5L8 0v2zM8 14a6 6 0 0 0 5.66-4h-1.06A5 5 0 0 1 8 13v-1l-3 2.5L8 16v-2z"/></svg>
    </div>
  </div>
  ${groupHtml('OPEN', groups.OPEN)}
  ${groupHtml('DRAFT', groups.DRAFT)}
  ${groupHtml('MERGED', groups.MERGED)}
  ${groupHtml('CLOSED', groups.CLOSED)}
</body></html>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Wrote', out);
