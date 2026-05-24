// Headless copy of renderGraph from src/webviews/commitGraph.ts (same algorithm)
function timeAgo(d){const s=Math.floor((Date.now()-d.getTime())/1000);if(s<60)return s+'s ago';const m=Math.floor(s/60);if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';const dd=Math.floor(h/24);if(dd<30)return dd+'d ago';const mo=Math.floor(dd/30);if(mo<12)return mo+'mo ago';return Math.floor(mo/12)+'y ago';}
function colorForAuthor(a){let h=0;for(const c of a)h=(h<<5)-h+c.charCodeAt(0);return`hsl(${Math.abs(h)%360},65%,60%)`;}
function escape(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function renderGraphStandalone(commits){
  const lanes = [];
  const rows = [];
  const palette = ['#f97316','#3b82f6','#10b981','#ec4899','#a855f7','#eab308','#06b6d4','#ef4444','#84cc16','#14b8a6'];
  let colorIdx = 0;
  const byParent = new Map();
  for (const c of commits) {
    let laneIdx = byParent.get(c.sha);
    let color;
    if (laneIdx === undefined) {
      laneIdx = lanes.findIndex(l => l === null);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(null); }
      color = palette[colorIdx++ % palette.length];
    } else color = lanes[laneIdx].color;
    lanes[laneIdx] = { sha: c.sha, color };
    const snapshot = lanes.map(l => l ? { ...l } : null);
    if (c.parents.length === 0) lanes[laneIdx] = null;
    else {
      lanes[laneIdx] = { sha: c.parents[0], color };
      byParent.set(c.parents[0], laneIdx);
      for (let i = 1; i < c.parents.length; i++) {
        let n = lanes.findIndex(l => l === null);
        if (n === -1) { n = lanes.length; lanes.push(null); }
        const pc = palette[colorIdx++ % palette.length];
        lanes[n] = { sha: c.parents[i], color: pc };
        byParent.set(c.parents[i], n);
      }
    }
    rows.push({ commit: c, lane: laneIdx, lanes: snapshot, color });
  }
  const rowH = 28, colW = 16;
  const maxLanes = Math.max(...rows.map(r => r.lanes.length), 1);
  const graphW = maxLanes * colW + 10;
  const svgRows = rows.map((r,i) => {
    const cx = r.lane * colW + colW/2 + 5;
    const nextLanes = rows[i+1]?.lanes ?? [];
    const parts = [];
    r.lanes.forEach((l, idx) => {
      if (!l) return;
      const x = idx * colW + colW/2 + 5;
      parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${rowH/2}" stroke="${l.color}" stroke-width="2"/>`);
      const continues = nextLanes.some((nl,ni) => nl && nl.sha === l.sha && ni === idx);
      if (continues) parts.push(`<line x1="${x}" y1="${rowH/2}" x2="${x}" y2="${rowH}" stroke="${l.color}" stroke-width="2"/>`);
    });
    r.commit.parents.forEach(p => {
      const nIdx = nextLanes.findIndex(nl => nl && nl.sha === p);
      if (nIdx === -1) return;
      const nx = nIdx * colW + colW/2 + 5;
      if (nx === cx) parts.push(`<line x1="${cx}" y1="${rowH/2}" x2="${nx}" y2="${rowH}" stroke="${r.color}" stroke-width="2"/>`);
      else parts.push(`<path d="M${cx},${rowH/2} C${cx},${rowH*0.85} ${nx},${rowH*0.5} ${nx},${rowH}" stroke="${r.color}" stroke-width="2" fill="none"/>`);
    });
    parts.push(`<circle cx="${cx}" cy="${rowH/2}" r="5" fill="${r.color}" stroke="var(--vscode-editor-background)" stroke-width="2"/>`);
    return `<g transform="translate(0,${i*rowH})">${parts.join('')}</g>`;
  }).join('');
  const list = rows.map(r => {
    const refsHtml = r.commit.refs.map(ref => {
      const cls = ref.startsWith('tag:') ? 'tag' : ref === 'HEAD' || ref.includes('HEAD') ? 'head' : ref.includes('/') ? 'remote' : 'branch';
      return `<span class="ref ${cls}">${escape(ref.replace(/^tag: /,''))}</span>`;
    }).join('');
    return `<div class="row" style="height:28px"><span class="refs">${refsHtml}</span><span class="subject">${escape(r.commit.subject)}</span><span class="meta"><span class="author" style="color:${colorForAuthor(r.commit.author)}">${escape(r.commit.author)}</span><span class="ago">${timeAgo(r.commit.date)}</span><span class="sha">${r.commit.shortSha}</span></span></div>`;
  }).join('');
  return `<style>
    body { margin:0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size: 13px; }
    .toolbar { display:flex; padding:8px 12px; gap:8px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editor-background); align-items:center; }
    .toolbar input { flex:1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 3px; }
    .toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 3px; }
    .stats { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .wrap { display: flex; }
    .graph { width: ${graphW}px; min-width: ${graphW}px; background: var(--vscode-editorWidget-background); }
    .list { flex: 1; overflow: hidden; }
    .row { display: flex; align-items: center; padding: 0 12px; gap: 12px; white-space: nowrap; overflow: hidden; box-sizing: border-box; height: 28px; min-height: 28px; max-height: 28px; }
    .row:nth-child(even) { background: #ffffff04; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .subject { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .meta { display: flex; gap: 12px; color: var(--vscode-descriptionForeground); font-size: 11px; align-items: center; }
    .sha { font-family: var(--vscode-editor-font-family); padding: 1px 4px; border-radius: 2px; }
    .refs { display:flex; gap: 4px; }
    .ref { padding: 1px 6px; border-radius: 3px; font-size: 10px; }
    .ref.branch { background: #2563eb22; color: #60a5fa; border:1px solid #60a5fa55; }
    .ref.remote { background: #16a34a22; color: #4ade80; border:1px solid #4ade8055; }
    .ref.tag    { background: #d9770622; color: #fbbf24; border:1px solid #fbbf2455; }
    .ref.head   { background: #dc262622; color: #f87171; border:1px solid #f8717155; font-weight:600; }
  </style>
  <div class="toolbar">
    <input placeholder="Search commits by message…" value=""/>
    <button>Refresh</button>
    <span class="stats">${rows.length} commits</span>
  </div>
  <div class="wrap">
    <svg class="graph" width="${graphW}" height="${rows.length*rowH}" xmlns="http://www.w3.org/2000/svg">${svgRows}</svg>
    <div class="list">${list}</div>
  </div>`;
}
module.exports = { renderGraphStandalone };
