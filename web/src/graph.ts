/**
 * GitSight web — commit graph renderer (W2).
 *
 * This is the proof of the whole mission: it REUSES the extension's
 * stack-agnostic renderer (`@shared/graphCore`) to lay out lanes and
 * build the SVG, then paints the commit rows in the web app's own design
 * language. Zero forked geometry.
 */

import {
  assignLanes,
  buildLaneSvg,
  classifyRef,
  refLabel,
  escapeHtml,
} from '@shared/graphCore';
import { paletteFor, authorColor } from '@shared/graphPalette';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';
import { parseQuery, commitMatchesQuery } from '@shared/commitQuery';
import { timeAgo, absoluteTime, el } from './format';

const ROW_H = 30;
const COL_W = 16;

export interface GraphRenderOptions {
  /** Theme key for the lane palette (see @shared/graphPalette). */
  theme?: string;
  /** Case-insensitive substring filter on commit subject/author/sha. */
  filter?: string;
  /** Called when a row is clicked (not the sha chip). */
  onSelect?: (commit: GraphSnapshotCommit) => void;
  /** Called when a sha chip is clicked. */
  onCopySha?: (sha: string) => void;
}

export interface GraphRenderResult {
  node: HTMLElement;
  /** Number of commits actually rendered after filtering. */
  rendered: number;
  /** Total commits in the snapshot. */
  total: number;
}

/**
 * Lowercase-match a commit against a filter string. Now backed by the
 * shared structured query parser (W10): `author:`, `grep:`, `ref:`,
 * `since:`, `until:`, `sha:` terms plus bare text. A bare term keeps the
 * original subject/author/sha behaviour.
 */
export function commitMatches(c: GraphSnapshotCommit, filter: string): boolean {
  if (!filter) return true;
  return commitMatchesQuery(c, parseQuery(filter));
}

/**
 * Render a snapshot into a detached DOM node. The caller mounts it.
 * Re-render on filter/theme change by calling again and swapping nodes.
 */
export function renderGraph(
  snapshot: GraphSnapshot,
  opts: GraphRenderOptions = {},
): GraphRenderResult {
  const palette = paletteFor(opts.theme);
  // Parse the query once for the whole list (not per-commit).
  const query = parseQuery(opts.filter ?? '');
  const filtered =
    query.terms.length === 0
      ? snapshot.commits
      : snapshot.commits.filter(c => commitMatchesQuery(c, query));

  // Shared lane layout — the SAME function the VS Code webview calls.
  const rows = assignLanes(filtered, palette);
  const lane = buildLaneSvg(rows, {
    rowHeight: ROW_H,
    colWidth: COL_W,
    // In the browser the node stroke is the surface background token.
    nodeStroke: 'var(--bg-elev)',
  });

  const wrap = el('div', 'graph-wrap');

  // Graph (SVG) column.
  const graphCol = el('div', 'graph-col');
  graphCol.style.width = `${lane.graphWidth}px`;
  graphCol.innerHTML =
    `<svg width="${lane.graphWidth}" height="${rows.length * ROW_H}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" ` +
    `aria-label="commit graph lanes">${lane.rowsSvg}</svg>`;

  // Rows column.
  const rowsCol = el('div', 'rows-col');
  rowsCol.setAttribute('role', 'listbox');
  rowsCol.setAttribute('aria-label', 'commits');

  const frag = document.createDocumentFragment();

  rows.forEach((r, i) => {
    const c = r.commit as GraphSnapshotCommit;
    const row = el('div', 'row');
    row.dataset.sha = c.sha;
    row.dataset.index = String(i);
    row.setAttribute('role', 'option');
    row.tabIndex = -1;

    const refsHtml = c.refs
      .map(ref => `<span class="ref ${classifyRef(ref)}">${escapeHtml(refLabel(ref))}</span>`)
      .join('');

    row.innerHTML =
      `<span class="refs">${refsHtml}</span>` +
      `<span class="subject">${escapeHtml(c.subject)}</span>` +
      `<span class="meta">` +
      `<span class="author" style="color:${authorColor(c.author)}" title="${escapeHtml(c.email)}">${escapeHtml(c.author)}</span>` +
      `<span class="ago" title="${escapeHtml(absoluteTime(c.date))}">${timeAgo(c.date)}</span>` +
      `<span class="sha" data-sha="${escapeHtml(c.sha)}" title="Copy ${escapeHtml(c.shortSha)}">${escapeHtml(c.shortSha)}</span>` +
      `</span>`;

    row.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('sha')) {
        e.stopPropagation();
        opts.onCopySha?.(c.sha);
        return;
      }
      selectRow(rowsCol, row);
      opts.onSelect?.(c);
    });

    frag.appendChild(row);
  });

  rowsCol.appendChild(frag);
  wrap.appendChild(graphCol);
  wrap.appendChild(rowsCol);

  return { node: wrap, rendered: rows.length, total: snapshot.commits.length };
}

/** Mark a row active + clear siblings. Exported for keyboard nav (W4). */
export function selectRow(container: HTMLElement, row: HTMLElement): void {
  container.querySelectorAll('.row.active').forEach(x => x.classList.remove('active'));
  row.classList.add('active');
  row.scrollIntoView({ block: 'nearest' });
}
