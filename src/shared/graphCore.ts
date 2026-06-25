/**
 * GitSight shared commit-graph core (W1).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. Pure functions
 * that turn a list of commits (sha + parents) into:
 *   1. lane assignments (the "railroad" layout)
 *   2. an SVG `<g>` fragment per row (lanes, edges, nodes)
 *
 * BOTH surfaces import this module so the visualisation never forks:
 *   - the VS Code webview  (src/webviews/commitGraph.ts)
 *   - the standalone web app (web/src/...)
 *   - the SVG/PNG/PDF export (src/git/commitGraphExport.ts consumes the
 *     `rowsSvg` produced here, unchanged)
 *
 * The chrome around the graph (HTML rows, theming, toolbar) is built by
 * each surface in its own design language; only the geometry is shared.
 *
 * Tests: test/git/graphCore.test.ts
 */

/** Minimal commit shape the lane algorithm needs. */
export interface GraphInputCommit {
  sha: string;
  parents: string[];
}

/** A lane occupant: which commit a lane is currently "carrying" + its colour. */
export interface Lane {
  sha: string;
  color: string;
}

/** One laid-out row: the commit, the lane it sits on, the lane snapshot at
 *  that row, and the row's colour. */
export interface LaneRow<C extends GraphInputCommit = GraphInputCommit> {
  commit: C;
  lane: number;
  lanes: (Lane | null)[];
  color: string;
}

/**
 * Assign each commit to a lane using a forward-scan railroad algorithm.
 *
 * Identical behaviour to the original CommitGraphPanel.renderGraph inline
 * logic (F1) — extracted verbatim so the extension render is unchanged.
 *
 * `commits` must be in `git log` order (newest first). `palette` colours
 * are cycled as new lanes open.
 */
export function assignLanes<C extends GraphInputCommit>(
  commits: C[],
  palette: string[],
): LaneRow<C>[] {
  const colors = palette.length ? palette : ['#888888'];
  const lanes: (Lane | null)[] = [];
  const rows: LaneRow<C>[] = [];
  let colorIdx = 0;
  const byParent = new Map<string, number>();

  for (const c of commits) {
    let laneIdx = byParent.get(c.sha);
    let color: string;
    if (laneIdx === undefined) {
      laneIdx = lanes.findIndex(l => l === null);
      if (laneIdx === -1) { laneIdx = lanes.length; lanes.push(null); }
      color = colors[colorIdx++ % colors.length];
    } else {
      color = lanes[laneIdx]!.color;
    }
    lanes[laneIdx] = { sha: c.sha, color };
    const snapshot = lanes.map(l => (l ? { ...l } : null));

    if (c.parents.length === 0) {
      lanes[laneIdx] = null;
    } else {
      lanes[laneIdx] = { sha: c.parents[0], color };
      byParent.set(c.parents[0], laneIdx);
      for (let i = 1; i < c.parents.length; i++) {
        let n = lanes.findIndex(l => l === null);
        if (n === -1) { n = lanes.length; lanes.push(null); }
        const pc = colors[colorIdx++ % colors.length];
        lanes[n] = { sha: c.parents[i], color: pc };
        byParent.set(c.parents[i], n);
      }
    }
    rows.push({ commit: c, lane: laneIdx, lanes: snapshot, color });
  }
  return rows;
}

export interface LaneSvgOptions {
  /** Height of one row in px. Default 28. */
  rowHeight?: number;
  /** Width of one lane column in px. Default 16. */
  colWidth?: number;
  /** Stroke painted around each commit node. The webview passes a VS Code
   *  theme var; the web app passes its surface background token; export
   *  passes a concrete colour. Default 'none'. */
  nodeStroke?: string;
}

export interface LaneSvgResult {
  /** The concatenated `<g transform=...>` fragments, one per row. */
  rowsSvg: string;
  /** Total graph column width in px (lanes * colWidth + gutter). */
  graphWidth: number;
  /** Resolved row height in px. */
  rowHeight: number;
  /** Number of rows rendered. */
  rowCount: number;
}

/**
 * Build the SVG `<g>` fragment for every laid-out row: vertical lane
 * segments, parent-edge curves, and the commit node circle.
 *
 * Extracted verbatim from the original inline renderer so the geometry
 * is pixel-identical. The only parameterised value is `nodeStroke`
 * (was a hard-coded `var(--vscode-editor-background)`), because the
 * standalone web app and the export path each need a different stroke.
 */
export function buildLaneSvg(
  rows: LaneRow[],
  options: LaneSvgOptions = {},
): LaneSvgResult {
  const rowH = Math.max(8, Math.floor(options.rowHeight ?? 28));
  const colW = Math.max(6, Math.floor(options.colWidth ?? 16));
  const nodeStroke = options.nodeStroke ?? 'none';
  const maxLanes = Math.max(...rows.map(r => r.lanes.length), 1);
  const graphW = maxLanes * colW + 10;

  const rowsSvg = rows.map((r, i) => {
    const cx = r.lane * colW + colW / 2 + 5;
    const nextLanes = rows[i + 1]?.lanes ?? [];
    const parts: string[] = [];
    r.lanes.forEach((l, idx) => {
      if (!l) return;
      const x = idx * colW + colW / 2 + 5;
      parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${rowH / 2}" stroke="${l.color}" stroke-width="2"/>`);
      const continues = nextLanes.some((nl, ni) => nl && nl.sha === l.sha && ni === idx);
      if (continues) parts.push(`<line x1="${x}" y1="${rowH / 2}" x2="${x}" y2="${rowH}" stroke="${l.color}" stroke-width="2"/>`);
    });
    r.commit.parents.forEach(p => {
      const nIdx = nextLanes.findIndex(nl => nl && nl.sha === p);
      if (nIdx === -1) return;
      const nx = nIdx * colW + colW / 2 + 5;
      if (nx === cx) parts.push(`<line x1="${cx}" y1="${rowH / 2}" x2="${nx}" y2="${rowH}" stroke="${r.color}" stroke-width="2"/>`);
      else parts.push(`<path d="M${cx},${rowH / 2} C${cx},${rowH * 0.85} ${nx},${rowH * 0.5} ${nx},${rowH}" stroke="${r.color}" stroke-width="2" fill="none"/>`);
    });
    parts.push(`<circle cx="${cx}" cy="${rowH / 2}" r="5" fill="${r.color}" stroke="${nodeStroke}" stroke-width="2"/>`);
    return `<g transform="translate(0,${i * rowH})">${parts.join('')}</g>`;
  }).join('');

  return { rowsSvg, graphWidth: graphW, rowHeight: rowH, rowCount: rows.length };
}

/**
 * HTML-escape a string for safe interpolation into element text or
 * attribute values. Shared so the webview and the web app escape commit
 * author/subject identically. Mirrors the webview's original `escape()`.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Classify a single ref string into its visual category so both surfaces
 * style branch / remote / tag / HEAD chips the same way. Mirrors the
 * inline ternary the webview used.
 */
export type RefKind = 'tag' | 'head' | 'remote' | 'branch';

export function classifyRef(ref: string): RefKind {
  if (ref.startsWith('tag:')) return 'tag';
  if (ref === 'HEAD' || ref.includes('HEAD')) return 'head';
  if (ref.includes('/')) return 'remote';
  return 'branch';
}

/** Strip the `tag: ` prefix git emits in `%D` decoration output. */
export function refLabel(ref: string): string {
  return ref.replace(/^tag: /, '');
}
