/**
 * Pure windowing + targeting maths for the blame view (W21).
 *
 * DOM-free + framework-free so it's unit-tested under node --test. The
 * blame view used to soft-cap at 4000 rendered lines; this module lets it
 * render an UNbounded file by mounting only the visible slice (the same
 * strategy graph rows use in W16) and adds the blame-specific bits the
 * generic window helper doesn't carry: a fixed 20px row height, a
 * "virtualise above N lines" threshold, content-height geometry, a
 * 1-based "reveal this line" scroll target, and a `path:line` / `path#L42`
 * target parser so the user can jump straight to a line.
 *
 * The core slice maths is reused from ./virtual (computeWindow et al.) so
 * there's a single, tested windowing implementation — this module only
 * specialises it for blame.
 *
 * Tests: web/src/blameWindow.test.mjs
 */

import { computeWindow, windowChanged, scrollToReveal, type WindowRange } from './virtual.ts';

/** Fixed blame row height in px (matches `.blame-row` in styles.css). */
export const BLAME_ROW_H = 20;

/** Line count at/above which the blame view switches to windowed rendering. */
export const BLAME_VIRTUAL_THRESHOLD = 600;

/** Rows over-rendered on each edge of the viewport (blame rows are short). */
export const BLAME_OVERSCAN = 12;

/** Whether a file of `total` lines is big enough to warrant windowing. */
export function shouldVirtualizeBlame(total: number): boolean {
  const n = Math.floor(total);
  return Number.isFinite(n) && n >= BLAME_VIRTUAL_THRESHOLD;
}

/** Full pixel height of `total` blame rows (the scroll spacer height). */
export function blameContentHeight(total: number): number {
  return Math.max(0, Math.floor(total) || 0) * BLAME_ROW_H;
}

/** Resolve the [start,end) slice of blame rows to mount for a scroll pos. */
export function blameWindow(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  overscan: number = BLAME_OVERSCAN,
): WindowRange {
  return computeWindow({ scrollTop, viewportHeight, rowHeight: BLAME_ROW_H, total, overscan });
}

/**
 * The scrollTop that brings a 1-based line number into view, nudging the
 * container the minimum distance. Clamps out-of-range lines. Pure so the
 * "jump to line" behaviour is testable without a DOM.
 */
export function revealBlameLine(
  line: number,
  scrollTop: number,
  viewportHeight: number,
  total: number,
): number {
  const idx = Math.max(0, (Math.floor(line) || 1) - 1);
  return scrollToReveal(idx, scrollTop, viewportHeight, BLAME_ROW_H, total);
}

/** A parsed blame target: a file path plus an optional 1-based line. */
export interface BlameTarget {
  path: string;
  /** 1-based line to reveal after load, or null. */
  line: number | null;
}

/**
 * Parse a blame target from the path input. Accepts a bare path, the
 * GitHub-style `path#L123` anchor, or `path:123`. A trailing `:digits` is
 * only treated as a line when there's a non-empty path before it, so a
 * path that genuinely ends in a colon-number is the rare loser (the user
 * can always use the `#L` form). Whitespace is trimmed.
 */
export function parseBlameTarget(input: string): BlameTarget {
  const raw = (input ?? '').trim();
  if (!raw) return { path: '', line: null };

  const anchor = /^(.*?)#L(\d+)$/.exec(raw);
  if (anchor && anchor[1].trim()) {
    const line = clampLine(anchor[2]);
    if (line) return { path: anchor[1].trim(), line };
  }

  const colon = /^(.*):(\d+)$/.exec(raw);
  if (colon && colon[1].trim()) {
    const line = clampLine(colon[2]);
    if (line) return { path: colon[1].trim(), line };
  }

  return { path: raw, line: null };
}

function clampLine(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export { windowChanged };
export type { WindowRange };
