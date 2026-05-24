import * as vscode from 'vscode';
import { Git, Commit } from '../git/git';

/**
 * GitHub-style year-long contribution heatmap of commits in the current repo.
 * Pure local git log — no API calls, no authentication. Tooltips show the
 * commits made each day. Filter by author dropdown.
 */
export async function showActivityHeatmap(git: Git, ctx: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'gitsight.activity',
    'GitSight: Contribution Activity',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const commits = await git.log({ max: 5000 });
  const authors = [...new Set(commits.map(c => c.author))].sort();
  const html = renderActivity(commits, authors, 'All');
  panel.webview.html = html;

  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'filter') {
      panel.webview.html = renderActivity(commits, authors, msg.author);
    }
  });
}

const DAY_MS = 86400 * 1000;

function renderActivity(commits: Commit[], authors: string[], filter: string): string {
  const filtered = filter === 'All' ? commits : commits.filter(c => c.author === filter);

  // Build day buckets for the last 53 weeks (GitHub-style: 53 cols x 7 rows = ~371 days)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay();
  const cellsByDay = new Map<string, Commit[]>();
  for (const c of filtered) {
    const d = new Date(c.date);
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    (cellsByDay.get(key) ?? cellsByDay.set(key, []).get(key)!).push(c);
  }

  const weeks = 53;
  const cellSize = 13;
  const gap = 3;
  const w = weeks * (cellSize + gap);
  const h = 7 * (cellSize + gap) + 30;

  const cells: string[] = [];
  let maxCount = 1;
  // Find max commits in any single day for color scaling
  for (const list of cellsByDay.values()) if (list.length > maxCount) maxCount = list.length;

  // Build month labels
  const monthLabels: string[] = [];
  let lastMonth = -1;
  // Iterate week columns (newest right)
  for (let col = 0; col < weeks; col++) {
    const colDate = new Date(today);
    colDate.setDate(today.getDate() - dayOfWeek - (weeks - 1 - col) * 7);
    for (let row = 0; row < 7; row++) {
      const d = new Date(colDate);
      d.setDate(colDate.getDate() + row);
      if (d > today) continue;
      const key = d.toISOString().slice(0, 10);
      const list = cellsByDay.get(key) ?? [];
      const count = list.length;
      const intensity = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCount) * 4));
      const color = ['#22272d', '#0e4429', '#006d32', '#26a641', '#39d353'][intensity];
      const x = col * (cellSize + gap);
      const y = 20 + row * (cellSize + gap);
      const tip = count
        ? `${count} commit${count > 1 ? 's' : ''} on ${key}${list[0] ? '\n• ' + list.slice(0, 3).map(c => c.subject.slice(0, 60)).join('\n• ') : ''}`
        : `No commits on ${key}`;
      cells.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${color}"><title>${escAttr(tip)}</title></rect>`);
    }
    // Month label
    const labelDate = new Date(today);
    labelDate.setDate(today.getDate() - dayOfWeek - (weeks - 1 - col) * 7);
    if (labelDate.getMonth() !== lastMonth) {
      lastMonth = labelDate.getMonth();
      const x = col * (cellSize + gap);
      const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][lastMonth];
      monthLabels.push(`<text x="${x}" y="14" fill="#888" font-size="10" font-family="-apple-system,sans-serif">${month}</text>`);
    }
  }

  // Stats
  const total = filtered.length;
  const days = cellsByDay.size;
  const streak = computeStreak(cellsByDay, today);
  const longestStreak = computeLongestStreak(cellsByDay);

  const opts = ['All', ...authors].map(a =>
    `<option value="${escAttr(a)}"${a === filter ? ' selected' : ''}>${esc(a)}</option>`
  ).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin:0; padding:32px; font:13px -apple-system,system-ui,sans-serif; color:var(--vscode-foreground); background:var(--vscode-editor-background); }
    .header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:24px; }
    h1 { margin:0 0 4px; font-size:22px; font-weight:600; }
    .sub { color:var(--vscode-descriptionForeground); font-size:13px; }
    select { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:6px 10px; border-radius:4px; font:inherit; }
    .stats { display:flex; gap:24px; margin-bottom:24px; }
    .stat { background:var(--vscode-editorWidget-background); padding:14px 22px; border-radius:8px; min-width:120px; }
    .stat .n { font-size:24px; font-weight:600; }
    .stat .l { color:var(--vscode-descriptionForeground); font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-top:4px; }
    .grid-wrap { background:var(--vscode-editorWidget-background); padding:24px; border-radius:8px; overflow-x:auto; }
    .legend { display:flex; justify-content:flex-end; align-items:center; gap:6px; margin-top:14px; font-size:11px; color:var(--vscode-descriptionForeground); }
    .legend rect { width:12px; height:12px; rx:2; }
  </style></head><body>
    <div class="header">
      <div>
        <h1>Contribution Activity</h1>
        <div class="sub">${filtered.length} contributions in the last year</div>
      </div>
      <div>
        <label style="font-size:11px;color:var(--vscode-descriptionForeground);margin-right:6px">Author:</label>
        <select onchange="filterAuthor(this.value)">${opts}</select>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="n">${total}</div><div class="l">Commits</div></div>
      <div class="stat"><div class="n">${days}</div><div class="l">Active Days</div></div>
      <div class="stat"><div class="n">${streak}</div><div class="l">Current Streak 🔥</div></div>
      <div class="stat"><div class="n">${longestStreak}</div><div class="l">Longest Streak</div></div>
    </div>
    <div class="grid-wrap">
      <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        ${monthLabels.join('')}
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
    <script>
      const vscode = acquireVsCodeApi();
      function filterAuthor(a) { vscode.postMessage({type:'filter', author:a}); }
    </script>
  </body></html>`;
}

function computeStreak(byDay: Map<string, Commit[]>, today: Date): number {
  let n = 0; const d = new Date(today);
  while (true) {
    const k = d.toISOString().slice(0, 10);
    if (byDay.has(k)) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}
function computeLongestStreak(byDay: Map<string, Commit[]>): number {
  if (!byDay.size) return 0;
  const keys = [...byDay.keys()].sort();
  let longest = 1, cur = 1;
  for (let i = 1; i < keys.length; i++) {
    const prev = new Date(keys[i - 1]);
    const next = new Date(keys[i]);
    if ((next.getTime() - prev.getTime()) === DAY_MS) cur++;
    else cur = 1;
    if (cur > longest) longest = cur;
  }
  return longest;
}

const esc = (s: string) => (s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
