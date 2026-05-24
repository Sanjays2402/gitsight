#!/usr/bin/env node
// Standalone renderer for the Contribution Activity Heatmap screenshot.
const fs = require('fs');
const out = process.argv[2] || 'screenshots/activity-heatmap.html';

// Generate fake-but-realistic commit pattern: weekday-heavy, occasional weekend bursts
const today = new Date();
today.setHours(0,0,0,0);
const weeks = 53;
const cells = [];
const cellSize = 13, gap = 3;
const counts = {};
const dayOfWeek = today.getDay();
let totalCommits = 0, activeDays = 0;

function seedRand(s){let a=s;return ()=>{a=(a*9301+49297)%233280;return a/233280;}}
const rand = seedRand(42);

for (let col = 0; col < weeks; col++) {
  for (let row = 0; row < 7; row++) {
    const d = new Date(today);
    d.setDate(today.getDate() - dayOfWeek - (weeks - 1 - col) * 7 + row);
    if (d > today) continue;
    const isWeekend = row === 0 || row === 6;
    const r = rand();
    let n = 0;
    if (isWeekend) n = r < 0.65 ? 0 : (r < 0.85 ? 1 : (r < 0.95 ? 2 + ((r*10)|0)%4 : 8));
    else n = r < 0.25 ? 0 : (r < 0.5 ? 1 + ((r*10)|0)%2 : (r < 0.85 ? 3 + ((r*10)|0)%5 : 9 + ((r*10)|0)%6));
    // Hot streak last 30 days
    const ageDays = (today.getTime() - d.getTime()) / 86400000;
    if (ageDays < 30 && n === 0 && r > 0.3) n = 2;
    counts[d.toISOString().slice(0,10)] = n;
    if (n > 0) { totalCommits += n; activeDays++; }
  }
}

const maxC = Math.max(...Object.values(counts));
const colorFor = n => n === 0 ? '#22272d' : ['#0e4429','#006d32','#26a641','#39d353'][Math.min(3, Math.ceil((n / maxC) * 4) - 1)];

let lastMonth = -1;
const months = [];
for (let col = 0; col < weeks; col++) {
  const cd = new Date(today);
  cd.setDate(today.getDate() - dayOfWeek - (weeks - 1 - col) * 7);
  for (let row = 0; row < 7; row++) {
    const d = new Date(cd);
    d.setDate(cd.getDate() + row);
    if (d > today) continue;
    const k = d.toISOString().slice(0,10);
    const n = counts[k] || 0;
    const x = col * (cellSize + gap);
    const y = 24 + row * (cellSize + gap);
    cells.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${colorFor(n)}"/>`);
  }
  if (cd.getMonth() !== lastMonth) {
    lastMonth = cd.getMonth();
    const x = col * (cellSize + gap);
    months.push(`<text x="${x}" y="16" fill="#9d9d9d" font-size="11" font-family="-apple-system,sans-serif">${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][lastMonth]}</text>`);
  }
}

// Compute streaks
const sortedKeys = Object.keys(counts).sort();
let curStreak = 0; const dd = new Date(today);
while (true) {
  const k = dd.toISOString().slice(0,10);
  if (counts[k] > 0) { curStreak++; dd.setDate(dd.getDate()-1); } else break;
}
let longest = 1, cur = 1;
for (let i = 1; i < sortedKeys.length; i++) {
  const a = new Date(sortedKeys[i-1]), b = new Date(sortedKeys[i]);
  if (counts[sortedKeys[i-1]] > 0 && counts[sortedKeys[i]] > 0 && (b - a) === 86400000) cur++;
  else cur = 1;
  if (cur > longest) longest = cur;
}

const w = weeks * (cellSize + gap);
const h = 7 * (cellSize + gap) + 30;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; padding:40px; font:13px -apple-system,system-ui,sans-serif; color:#cccccc; background:#1e1e1e; }
  .header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:24px; }
  h1 { margin:0 0 6px; font-size:24px; font-weight:600; color:#fff; }
  .sub { color:#9d9d9d; font-size:13px; }
  select { background:#3c3c3c; color:#cccccc; border:1px solid #4d4d4d; padding:7px 12px; border-radius:4px; font:inherit; }
  .stats { display:flex; gap:16px; margin-bottom:28px; }
  .stat { background:#252526; padding:18px 26px; border-radius:8px; min-width:140px; border:1px solid #2b2b2b; }
  .stat .n { font-size:28px; font-weight:600; color:#fff; }
  .stat .l { color:#9d9d9d; font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-top:4px; }
  .grid-wrap { background:#252526; padding:28px; border-radius:8px; border:1px solid #2b2b2b; }
  .legend { display:flex; justify-content:flex-end; align-items:center; gap:6px; margin-top:16px; font-size:11px; color:#9d9d9d; }
</style></head><body>
  <div class="header">
    <div>
      <h1>Contribution Activity</h1>
      <div class="sub">${totalCommits} contributions in the last year · all branches</div>
    </div>
    <div>
      <label style="font-size:11px;color:#9d9d9d;margin-right:8px">Author:</label>
      <select><option>All</option><option>Sanjay Santhanam</option><option>Anjali Krishnan</option><option>David Chen</option></select>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><div class="n">${totalCommits}</div><div class="l">Commits</div></div>
    <div class="stat"><div class="n">${activeDays}</div><div class="l">Active Days</div></div>
    <div class="stat"><div class="n">${curStreak}</div><div class="l">Current Streak 🔥</div></div>
    <div class="stat"><div class="n">${longest}</div><div class="l">Longest Streak</div></div>
  </div>
  <div class="grid-wrap">
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      ${months.join('')}
      ${cells.join('')}
    </svg>
    <div class="legend">
      Less
      <svg width="14" height="14"><rect width="12" height="12" rx="2" fill="#22272d"/></svg>
      <svg width="14" height="14"><rect width="12" height="12" rx="2" fill="#0e4429"/></svg>
      <svg width="14" height="14"><rect width="12" height="12" rx="2" fill="#006d32"/></svg>
      <svg width="14" height="14"><rect width="12" height="12" rx="2" fill="#26a641"/></svg>
      <svg width="14" height="14"><rect width="12" height="12" rx="2" fill="#39d353"/></svg>
      More
    </div>
  </div>
</body></html>`;
fs.writeFileSync(out, html);
console.log(out);
