/**
 * Pure presentation helpers for the blame heatmap (W12).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The
 * view module (blameView.ts) owns the DOM; the colour ramp + age label
 * maths live here.
 *
 * Tests: web/src/blameFormat.test.mjs
 */

/**
 * Map a 0..1 blame "heat" (1 = newest/hot, 0 = oldest/cold) to an HSL
 * colour. Mirrors the extension's heatmapColor ramp but inverted to take
 * the shared `blameHeat` value: hot lines run warm (red/orange), cold
 * lines run blue. Saturation/lightness fixed for legibility on the strip.
 */
export function heatColor(heat: number): string {
  const h = Math.min(1, Math.max(0, heat));
  // heat 1 -> hue 0 (red), heat 0 -> hue 220 (blue).
  const hue = Math.round((1 - h) * 220);
  return `hsl(${hue}, 70%, 50%)`;
}

/** Deterministic per-author colour (same hash as the graph author dots). */
export function authorDot(author: string): string {
  let h = 0;
  for (const c of author) h = (h << 5) - h + c.charCodeAt(0);
  return `hsl(${Math.abs(h) % 360}, 65%, 60%)`;
}

/**
 * Relative-age label from a unix-SECONDS timestamp, e.g. "3mo". Compact
 * (no "ago" suffix) since it sits in a tight gutter. `now` is injectable
 * for stable tests.
 */
export function relativeAgeFromUnix(unixSec: number, now: number = Date.now()): string {
  if (!unixSec || unixSec <= 0) return '';
  const s = Math.floor(now / 1000 - unixSec);
  if (s < 0) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

/** Summary line for the blame header, e.g. "248 lines · 4 authors". */
export function blameSummary(totalLines: number, authorCount: number): string {
  const lines = `${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`;
  const authors = `${authorCount} ${authorCount === 1 ? 'author' : 'authors'}`;
  return `${lines} \u00b7 ${authors}`;
}
