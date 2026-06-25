/**
 * Pure responsive-layout logic (W11).
 *
 * DOM-free + vscode-free so it's unit-tested under node --test. Decides,
 * from a viewport width, which of the app's side surfaces (the ref rail
 * and the detail panel) should collapse into overlay drawers instead of
 * sitting inline. The view layer (main.ts) reads these decisions and
 * toggles classes / aria state; the breakpoint maths lives here.
 *
 * Two breakpoints, mobile-first:
 *   - below RAIL_BP   : the ref rail is a drawer (off-canvas, toggled).
 *   - below COMPACT_BP: rows tighten (denser, hide the author column)
 *                       and the detail panel becomes a full-width sheet.
 *
 * Tests: web/src/responsive.test.mjs
 */

/** Width at/below which the ref rail collapses into a drawer. */
export const RAIL_BREAKPOINT = 860;
/** Width at/below which the layout switches to compact (mobile) density. */
export const COMPACT_BREAKPOINT = 600;

export interface Layout {
  /** True when the ref rail should be an overlay drawer, not inline. */
  railIsDrawer: boolean;
  /** True for the dense, single-column mobile presentation. */
  compact: boolean;
  /** True when the detail panel should cover the full width. */
  detailFullWidth: boolean;
}

/** Resolve the layout mode for a viewport width. */
export function layoutFor(width: number): Layout {
  const w = Number.isFinite(width) ? width : RAIL_BREAKPOINT + 1;
  const railIsDrawer = w <= RAIL_BREAKPOINT;
  const compact = w <= COMPACT_BREAKPOINT;
  return {
    railIsDrawer,
    compact,
    detailFullWidth: compact,
  };
}

/**
 * Whether a layout change between two widths is "material" — i.e. it
 * crosses a breakpoint and therefore warrants a re-render. Lets the
 * resize handler skip the vast majority of resize events (every pixel)
 * and only rebuild when the mode actually flips.
 */
export function layoutChanged(prev: number, next: number): boolean {
  const a = layoutFor(prev);
  const b = layoutFor(next);
  return a.railIsDrawer !== b.railIsDrawer || a.compact !== b.compact;
}
