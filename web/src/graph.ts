/**
 * GitSight web — commit graph renderer (W2; virtualized in W16).
 *
 * This is the proof of the whole mission: it REUSES the extension's
 * stack-agnostic renderer (`@shared/graphCore`) to lay out lanes and
 * build the SVG, then paints the commit rows in the web app's own design
 * language. Zero forked geometry.
 *
 * W16 adds windowed rendering: above VIRTUAL_THRESHOLD commits the rows
 * column mounts only the visible slice (+overscan) and recycles on
 * scroll, so a 500-1000 commit history stays at 60fps with a bounded DOM
 * node + listener count. The lane SVG stays whole (static markup is
 * cheap and guarantees lane alignment); only the interactive HTML rows
 * are virtualized. A GraphController owns selection so keyboard nav keeps
 * working even when the target row is currently unmounted.
 */

import {
  assignLanes,
  buildLaneSvg,
  classifyRef,
  refLabel,
  escapeHtml,
  type LaneRow,
} from '@shared/graphCore';
import { paletteFor, authorColor } from '@shared/graphPalette';
import type { GraphSnapshot, GraphSnapshotCommit } from '@shared/graphSnapshot';
import { parseQuery, commitMatchesQuery } from '@shared/commitQuery';
import { timeAgo, absoluteTime, el } from './format';
import {
  computeWindow,
  windowChanged,
  scrollToReveal,
  VIRTUAL_THRESHOLD,
  type WindowRange,
} from './virtual';
import { GraphMinimap } from './minimapView';
import { MINIMAP_THRESHOLD } from './minimap';

const ROW_H = 30;
const COL_W = 16;

export interface GraphRenderOptions {
  /** Theme key for the lane palette (see @shared/graphPalette). */
  theme?: string;
  /** Case-insensitive substring filter on commit subject/author/sha. */
  filter?: string;
  /** Called when a row is selected (click or keyboard). */
  onSelect?: (commit: GraphSnapshotCommit) => void;
  /** Called when a sha chip is clicked. */
  onCopySha?: (sha: string) => void;
  /** Called on right-click of a row (W28 context menu) with the event. */
  onContextMenu?: (commit: GraphSnapshotCommit, e: MouseEvent) => void;
  /**
   * The scroll container the rows live in. Required to enable W16
   * windowing; without it the graph falls back to mounting every row.
   */
  scrollContainer?: HTMLElement;
}

export interface GraphRenderResult {
  node: HTMLElement;
  /** Number of commits actually rendered after filtering. */
  rendered: number;
  /** Total commits in the snapshot. */
  total: number;
  /** Owns selection + (when windowed) scroll recycling. Dispose on swap. */
  controller: GraphController;
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
 * Render a snapshot into a detached DOM node + a controller. The caller
 * mounts the node and keeps the controller for keyboard nav / disposal.
 * Re-render on filter/theme change by calling again and swapping nodes
 * (dispose the old controller first to drop its scroll listener).
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

  // Graph (SVG) column — rendered whole; it's static markup.
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

  wrap.appendChild(graphCol);
  wrap.appendChild(rowsCol);

  const controller = new GraphController({
    rows,
    rowsCol,
    opts,
    scrollContainer: opts.scrollContainer,
  });

  // Minimap (W45): a condensed lane strip for fast scroll-to-region on long
  // histories. Needs a scroll container to drive; only worth it above a
  // threshold (a short graph fits on screen already).
  if (opts.scrollContainer && rows.length >= MINIMAP_THRESHOLD) {
    const maxLanes = Math.max(...rows.map(r => r.lanes.length), 1);
    const minimap = new GraphMinimap({
      rows: rows.map(r => ({ lane: r.lane, color: r.color })),
      scrollContainer: opts.scrollContainer,
      contentHeight: rows.length * ROW_H,
      maxLanes,
    });
    wrap.appendChild(minimap.node);
    controller.attachMinimap(minimap);
  }

  return { node: wrap, rendered: rows.length, total: snapshot.commits.length, controller };
}

interface GraphControllerArgs {
  rows: LaneRow<GraphSnapshotCommit>[];
  rowsCol: HTMLElement;
  opts: GraphRenderOptions;
  scrollContainer?: HTMLElement;
}

/**
 * Owns the rows column: mounts rows (all, or a scrolling window when the
 * list is large), tracks the selected index, and exposes keyboard-nav
 * helpers that work even when the selected row is currently unmounted.
 */
export class GraphController {
  private rows: LaneRow<GraphSnapshotCommit>[];
  private rowsCol: HTMLElement;
  private opts: GraphRenderOptions;
  private scrollContainer: HTMLElement | null;
  private readonly virtual: boolean;
  private selected = -1;
  private win: WindowRange = { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  private onScroll: (() => void) | null = null;
  private minimap: GraphMinimap | null = null;

  constructor(args: GraphControllerArgs) {
    this.rows = args.rows;
    this.rowsCol = args.rowsCol;
    this.opts = args.opts;
    this.scrollContainer = args.scrollContainer ?? null;
    this.virtual = !!this.scrollContainer && this.rows.length >= VIRTUAL_THRESHOLD;

    if (this.virtual) {
      this.rowsCol.classList.add('virtual');
      this.rowsCol.style.height = `${this.rows.length * ROW_H}px`;
      this.renderWindow(true);
      this.onScroll = () => this.handleScroll();
      this.scrollContainer!.addEventListener('scroll', this.onScroll, { passive: true });
    } else {
      this.renderAll();
    }
  }

  /** Attach a minimap (W45) so its lifecycle is tied to this controller. */
  attachMinimap(minimap: GraphMinimap): void {
    this.minimap = minimap;
  }

  /** Drop the scroll listener. Call before swapping in a fresh graph. */
  dispose(): void {
    if (this.onScroll && this.scrollContainer) {
      this.scrollContainer.removeEventListener('scroll', this.onScroll);
    }
    this.onScroll = null;
    this.minimap?.dispose();
    this.minimap = null;
  }

  count(): number {
    return this.rows.length;
  }

  selectedSha(): string | null {
    return this.selected >= 0 ? this.rows[this.selected].commit.sha : null;
  }

  /** Move the selection by delta rows, scrolling it into view. */
  move(delta: number): GraphSnapshotCommit | null {
    const n = this.rows.length;
    if (n === 0) return null;
    let next = this.selected < 0 ? (delta > 0 ? 0 : n - 1) : this.selected + delta;
    next = Math.max(0, Math.min(n - 1, next));
    this.select(next, true);
    return this.rows[next].commit;
  }

  /** Select a row by sha (e.g. from a parent-chip click), revealing it. */
  selectSha(sha: string): boolean {
    const idx = this.rows.findIndex(r => r.commit.sha === sha);
    if (idx < 0) return false;
    this.select(idx, true);
    return true;
  }

  /** Fire onSelect for the current selection (Enter key). */
  activateSelected(): void {
    if (this.selected < 0) return;
    this.opts.onSelect?.(this.rows[this.selected].commit);
  }

  /** Mark a row selected, optionally scrolling it into view + remounting. */
  private select(index: number, scroll: boolean): void {
    this.selected = index;
    if (this.virtual && this.scrollContainer) {
      if (scroll) {
        const sc = this.scrollContainer;
        sc.scrollTop = scrollToReveal(index, sc.scrollTop, sc.clientHeight, ROW_H, this.rows.length);
      }
      // Ensure the row is mounted before we try to mark it active.
      this.renderWindow(false);
    }
    this.markActive();
  }

  private handleScroll(): void {
    if (!this.scrollContainer) return;
    this.renderWindow(false);
  }

  /** (Re)mount the visible window of rows. Force re-renders unconditionally. */
  private renderWindow(force: boolean): void {
    const sc = this.scrollContainer!;
    const next = computeWindow({
      scrollTop: sc.scrollTop,
      viewportHeight: sc.clientHeight,
      rowHeight: ROW_H,
      total: this.rows.length,
    });
    if (!force && !windowChanged(this.win, next)) {
      this.win = next;
      return;
    }
    this.win = next;
    const frag = document.createDocumentFragment();
    for (let i = next.start; i < next.end; i++) {
      frag.appendChild(this.buildRow(this.rows[i], i, true));
    }
    this.rowsCol.replaceChildren(frag);
    this.markActive();
  }

  /** Mount every row (small histories — keeps the original DOM shape). */
  private renderAll(): void {
    const frag = document.createDocumentFragment();
    this.rows.forEach((r, i) => frag.appendChild(this.buildRow(r, i, false)));
    this.rowsCol.replaceChildren(frag);
  }

  /** Reflect the selected index onto whichever rows are mounted. */
  private markActive(): void {
    this.rowsCol.querySelectorAll('.row.active').forEach(x => x.classList.remove('active'));
    if (this.selected < 0) return;
    const row = this.rowsCol.querySelector<HTMLElement>(`.row[data-index="${this.selected}"]`);
    if (row) {
      row.classList.add('active');
      row.setAttribute('aria-selected', 'true');
    }
  }

  private buildRow(
    r: LaneRow<GraphSnapshotCommit>,
    i: number,
    positioned: boolean,
  ): HTMLElement {
    const c = r.commit;
    const row = el('div', 'row');
    row.dataset.sha = c.sha;
    row.dataset.index = String(i);
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    if (positioned) row.style.top = `${i * ROW_H}px`;

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
        this.opts.onCopySha?.(c.sha);
        return;
      }
      this.selected = i;
      this.markActive();
      this.opts.onSelect?.(c);
    });

    if (this.opts.onContextMenu) {
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        // Select the row so the menu's target is visually anchored.
        this.selected = i;
        this.markActive();
        this.opts.onContextMenu!(c, e);
      });
    }

    return row;
  }
}

/** Mark a row active + clear siblings. Exported for compatibility (W4). */
export function selectRow(container: HTMLElement, row: HTMLElement): void {
  container.querySelectorAll('.row.active').forEach(x => x.classList.remove('active'));
  row.classList.add('active');
  row.scrollIntoView({ block: 'nearest' });
}
