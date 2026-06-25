/**
 * Pure virtual-window maths for the commit list (W16).
 *
 * DOM-free + framework-free so it's unit-tested under node --test. Given a
 * scroll offset, a viewport height, and a fixed row height, it decides
 * which slice of a long row list is actually worth mounting — plus an
 * overscan margin so a fast flick doesn't flash blank rows. The graph view
 * reads these decisions and mounts only the visible window (bounded DOM
 * node + listener count) while a full-height spacer preserves the
 * scrollbar geometry.
 *
 * The snapshot already caps history via --max (default 500); above the
 * VIRTUAL_THRESHOLD the graph switches from "mount every row" to this
 * windowed strategy so a 500-1000 commit history scrolls at 60fps.
 *
 * Tests: web/src/virtual.test.mjs
 */

/** Row count at/above which the graph view switches to windowed rendering. */
export const VIRTUAL_THRESHOLD = 150;

/** Default rows mounted beyond the viewport on each edge. */
export const DEFAULT_OVERSCAN = 6;

export interface WindowInput {
  /** Scroll offset of the container, in px (clamped to >= 0). */
  scrollTop: number;
  /** Visible height of the scroll container, in px. */
  viewportHeight: number;
  /** Fixed height of one row, in px (coerced to >= 1). */
  rowHeight: number;
  /** Total number of rows in the list. */
  total: number;
  /** Rows to over-render on each edge. Default DEFAULT_OVERSCAN. */
  overscan?: number;
}

export interface WindowRange {
  /** First index to mount (inclusive). */
  start: number;
  /** One past the last index to mount (exclusive). */
  end: number;
  /** Pixel offset of `start` from the top (start * rowHeight). */
  offsetTop: number;
  /** Full list height so the scrollbar reflects every row (total * rowHeight). */
  totalHeight: number;
}

/**
 * Resolve the [start, end) slice to mount for a scroll position. Always
 * returns a valid, clamped range — even for an empty list, a zero-height
 * viewport, or a scroll offset past the end (over-scroll bounce).
 */
export function computeWindow(input: WindowInput): WindowRange {
  const rowHeight = Math.max(1, Math.floor(input.rowHeight) || 1);
  const total = Math.max(0, Math.floor(input.total) || 0);
  const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN));
  const totalHeight = total * rowHeight;

  if (total === 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  }

  const scrollTop = Math.min(Math.max(0, input.scrollTop || 0), totalHeight);
  const viewportHeight = Math.max(0, input.viewportHeight || 0);

  const firstVisible = Math.floor(scrollTop / rowHeight);
  // Rows that fit in the viewport, +1 to cover a partially-scrolled top row.
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1;

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + visibleCount + overscan);

  return { start, end, offsetTop: start * rowHeight, totalHeight };
}

/** True when two ranges mount a different slice (so a re-render is needed). */
export function windowChanged(a: WindowRange, b: WindowRange): boolean {
  return a.start !== b.start || a.end !== b.end;
}

/**
 * The scrollTop that brings row `index` fully into a viewport, nudging the
 * container the minimum distance (like `scrollIntoView({ block: 'nearest' })`
 * but computed rather than DOM-driven, so it works for unmounted rows).
 * Returns the current scrollTop unchanged when the row is already visible.
 */
export function scrollToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
): number {
  const rh = Math.max(1, Math.floor(rowHeight) || 1);
  const n = Math.max(0, Math.floor(total) || 0);
  if (n === 0) return 0;
  const i = Math.min(Math.max(0, index), n - 1);
  const top = i * rh;
  const bottom = top + rh;
  const viewTop = Math.max(0, scrollTop || 0);
  const viewBottom = viewTop + Math.max(0, viewportHeight || 0);
  if (top < viewTop) return top;
  if (bottom > viewBottom) return Math.max(0, bottom - Math.max(0, viewportHeight || 0));
  return viewTop;
}
