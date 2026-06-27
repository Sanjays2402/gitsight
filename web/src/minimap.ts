/**
 * Pure graph-minimap geometry (W45).
 *
 * DOM-free + framework-free so it's unit-tested under node --test. The
 * minimap is a condensed strip down the graph's edge: one thin mark per
 * commit (at its lane's x, in its lane colour) plus a draggable viewport
 * indicator, so on a long history you can see the shape of the branch
 * structure and jump straight to a region.
 *
 * This module owns the maths that map between three coordinate spaces:
 *   - row INDEX        (0 .. total-1)
 *   - CONTENT pixels   (the full scrollable height = total * rowHeight)
 *   - MINIMAP pixels   (the fixed track height the strip is drawn in)
 * The view (minimapView.ts) reads these decisions and paints; the seek
 * maths (pointer -> scrollTop) live here so click/drag-to-scroll is covered
 * without a browser. Mirrors the W16 virtual-window approach: cheap, pure,
 * clamped against every edge case (empty list, zero heights, over-scroll).
 *
 * Tests: web/src/minimap.test.mjs
 */

/** Row count at/above which the minimap is worth showing. */
export const MINIMAP_THRESHOLD = 60;

/** The minimap track's drawn width in px (lanes are packed into this). */
export const MINIMAP_WIDTH = 56;

export interface MinimapMark {
  /** Source row index. */
  index: number;
  /** Y centre of the mark on the minimap track, in px. */
  y: number;
  /** X centre of the mark (lane position packed into the track width), in px. */
  x: number;
}

/**
 * Y centre (px) of a row's mark on the minimap track. Rows are spread
 * evenly across `trackHeight`; a single-row list sits at the top. Clamped so
 * an out-of-range index still lands on the track.
 */
export function minimapMarkY(index: number, total: number, trackHeight: number): number {
  const n = Math.max(1, Math.floor(total) || 1);
  const h = Math.max(0, trackHeight || 0);
  if (n <= 1) return 0;
  const i = Math.min(Math.max(0, index), n - 1);
  return (i / (n - 1)) * h;
}

/**
 * X centre (px) of a lane's mark within the track width. Lanes are packed
 * edge-to-edge so even a wide graph fits the fixed strip; a single-lane
 * graph centres. Clamped to the track.
 */
export function minimapMarkX(lane: number, maxLanes: number, width: number): number {
  const lanes = Math.max(1, Math.floor(maxLanes) || 1);
  const w = Math.max(0, width || 0);
  if (lanes <= 1) return w / 2;
  const l = Math.min(Math.max(0, lane), lanes - 1);
  // Inset half a slot on each side so edge lanes aren't flush to the border.
  const slot = w / lanes;
  return slot / 2 + l * slot;
}

export interface MinimapViewport {
  /** Y offset (px) of the viewport indicator on the track. */
  top: number;
  /** Height (px) of the viewport indicator (>= a small min for grab-ability). */
  height: number;
}

/** Smallest the viewport indicator may shrink to, so it stays draggable. */
export const MINIMAP_MIN_VIEWPORT = 16;

/**
 * The viewport indicator's position + height on the minimap track, given
 * the current scroll state. Maps the visible content slice
 * [scrollTop, scrollTop+viewportHeight] into track space. The indicator is
 * clamped to a minimum height (so it's always grabbable) and kept fully
 * within the track even at the extremes.
 */
export function minimapViewport(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
  trackHeight: number,
): MinimapViewport {
  const track = Math.max(0, trackHeight || 0);
  const content = Math.max(0, contentHeight || 0);
  const view = Math.max(0, viewportHeight || 0);
  if (content <= 0 || track <= 0) return { top: 0, height: track };
  // The whole content fits -> the indicator covers the whole track.
  if (view >= content) return { top: 0, height: track };

  const ratio = track / content;
  let height = Math.max(MINIMAP_MIN_VIEWPORT, view * ratio);
  height = Math.min(height, track);
  const maxScroll = Math.max(1, content - view);
  const clampedScroll = Math.min(Math.max(0, scrollTop || 0), maxScroll);
  // Spread the indicator's top across the leftover track travel so it hits
  // the bottom exactly when scrolled to the end.
  const travel = track - height;
  const top = (clampedScroll / maxScroll) * travel;
  return { top, height };
}

/**
 * The scrollTop that centres the viewport on a pointer position over the
 * minimap track (click / drag-to-scroll). `pointerY` is measured from the
 * track top. Result is clamped to the valid scroll range so a click near an
 * edge doesn't over- or under-shoot.
 */
export function minimapSeekScrollTop(
  pointerY: number,
  trackHeight: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const track = Math.max(1, trackHeight || 0);
  const content = Math.max(0, contentHeight || 0);
  const view = Math.max(0, viewportHeight || 0);
  const maxScroll = Math.max(0, content - view);
  if (maxScroll <= 0) return 0;
  const frac = Math.min(Math.max(0, pointerY / track), 1);
  // Centre the viewport on the pointer: the fraction names the middle of
  // the visible slice, so back off half a viewport.
  const target = frac * content - view / 2;
  return Math.min(Math.max(0, target), maxScroll);
}

/**
 * Build the mark list for a minimap: one entry per row at its lane x + its
 * track y. Pure so the SVG builder can be tested. `lanes[i]` is the lane
 * index of row i; `maxLanes` packs the x spread.
 */
export function buildMinimapMarks(
  lanes: number[],
  maxLanes: number,
  trackHeight: number,
  width: number,
): MinimapMark[] {
  const total = lanes.length;
  const marks: MinimapMark[] = [];
  for (let i = 0; i < total; i++) {
    marks.push({
      index: i,
      y: minimapMarkY(i, total, trackHeight),
      x: minimapMarkX(lanes[i], maxLanes, width),
    });
  }
  return marks;
}
