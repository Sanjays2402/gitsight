/**
 * Pure blame age-legend + author-filter helpers (W40).
 *
 * DOM-free + framework-free + NO @shared alias, so it's unit-tested under
 * node --test. The blame heatmap (blameView.ts) colours each line by age
 * but shows no key for what the colours mean, and gives no way to isolate
 * one author. This module supplies:
 *
 *   - buildAgeRamp(oldest, newest): a handful of evenly-spaced stops across
 *     the file's age span, each with its heat value (0..1) and a relative
 *     age label, so the view can draw a legend from oldest -> newest.
 *   - isAuthorDimmed: the predicate the view uses to fade lines that don't
 *     belong to the currently-isolated author.
 *
 * Tests: web/src/blameLegend.test.mjs
 */

/** One stop on the age-ramp legend. */
export interface AgeRampStop {
  /** Heat value 0 (oldest/cold) .. 1 (newest/hot). */
  heat: number;
  /** Unix author-time (seconds) this stop represents. */
  unixSec: number;
}

/**
 * Build N evenly-spaced stops across an age span (oldest..newest), each
 * carrying the heat value the blame ramp maps it to. Returns oldest-first
 * so the legend reads cold -> hot left to right. When the span is degenerate
 * (single commit, or no times) returns a single newest stop so the legend
 * still renders something sane.
 */
export function buildAgeRamp(oldest: number, newest: number, stops = 5): AgeRampStop[] {
  const n = Math.max(2, Math.floor(stops));
  // No real span: one hot stop (everything is "newest" by blameHeat's rule).
  if (!oldest || !newest || newest <= oldest) {
    const t = newest || oldest || 0;
    return [{ heat: 1, unixSec: t }];
  }
  const out: AgeRampStop[] = [];
  for (let i = 0; i < n; i++) {
    const heat = i / (n - 1); // 0 .. 1
    const unixSec = Math.round(oldest + heat * (newest - oldest));
    out.push({ heat, unixSec });
  }
  return out;
}

/**
 * Whether a line should be dimmed given the currently-isolated author.
 * No active author (null/empty) -> nothing dims. Otherwise every line whose
 * author isn't the active one fades. Case-insensitive, trimmed compare so a
 * legend click matches the line author exactly.
 */
export function isAuthorDimmed(lineAuthor: string, activeAuthor: string | null): boolean {
  if (!activeAuthor) return false;
  return norm(lineAuthor) !== norm(activeAuthor);
}

/**
 * Toggle the isolated author: clicking the active author clears the filter,
 * clicking a different one switches to it. Returns the next active author
 * (or null when cleared).
 */
export function toggleAuthorFilter(current: string | null, clicked: string): string | null {
  return current !== null && norm(current) === norm(clicked) ? null : clicked;
}

function norm(s: string): string {
  return (s || '').trim().toLowerCase();
}

/**
 * Resolve a blame author's email from the per-line model (W51). The legend
 * works in author NAMES (BlameAuthorStat carries no email), but the W23
 * contributor panel is keyed by email — so to open it from a legend click we
 * map the name back to the email of the first line that author touched.
 * Case-insensitive, trimmed match. Returns '' when the author has no email on
 * record (e.g. an uncommitted-change pseudo-author) so the caller can fall
 * back to the name. `lines` is the BlameModel's per-line list.
 */
export function authorEmailFromLines(
  lines: ReadonlyArray<{ author: string; email: string }>,
  author: string,
): string {
  const want = norm(author);
  for (const l of lines) {
    if (norm(l.author) === want && l.email) return l.email;
  }
  return '';
}
