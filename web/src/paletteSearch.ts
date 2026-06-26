/**
 * Pure fuzzy-match + ranking core for the command palette (W26).
 *
 * DOM-free + framework-free + NO @shared import, so it's unit-tested under
 * node --test. The Cmd-K palette (commandPalette.ts) owns the overlay DOM
 * and builds the item list (views/refs/searches) using @shared/refRail;
 * this module is just the matcher: it decides whether a query is a
 * subsequence of an item label and scores how good the match is, returning
 * the matched character positions so the UI can highlight them.
 *
 * Scoring favours, in order: word-start hits (after a separator or a
 * camelCase boundary), contiguous runs, and matches near the start of the
 * label. An empty query matches everything in natural order so the palette
 * shows the full command list on open.
 *
 * Tests: web/src/paletteSearch.test.mjs
 */

/** A selectable command-palette entry. `value` is what the host acts on. */
export interface PaletteItem {
  id: string;
  kind: 'view' | 'ref' | 'search' | 'action';
  label: string;
  /** Subtitle / category shown dim on the right (e.g. "View", "Branch"). */
  hint?: string;
  /** Opaque payload the host consumes (view id, ref: query, search text). */
  value: string;
  /** Tie-break weight; lower sorts earlier when scores are equal. */
  weight?: number;
}

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices into the target that matched, ascending (for highlighting). */
  positions: number[];
}

export interface RankedItem<T extends PaletteItem = PaletteItem> {
  item: T;
  match: FuzzyMatch;
}

const SEPARATORS = new Set([' ', '/', '.', '_', '-', '\\', ':']);

/** Base + bonus weights for the scorer (tuned for short command labels). */
const MATCH = 16;
const CONSECUTIVE = 12;
const WORD_START = 10;

/**
 * True when target[i] begins a "word": index 0, a char after a separator,
 * or a camelCase boundary (lower/digit -> upper). Drives the word-start
 * bonus so `gg` prefers "Go to Graph" over a mid-word hit.
 */
export function isWordStart(target: string, i: number): boolean {
  if (i <= 0) return true;
  const prev = target[i - 1];
  if (SEPARATORS.has(prev)) return true;
  const cur = target[i];
  const prevLowerOrDigit = /[a-z0-9]/.test(prev);
  const curUpper = /[A-Z]/.test(cur);
  return prevLowerOrDigit && curUpper;
}

/**
 * Score `query` against `target` as a fuzzy subsequence. Returns null when
 * query is not a subsequence of target (case-insensitive). An empty query
 * is a zero-score match with no positions (matches everything).
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const t = target.toLowerCase();
  if (q.length > target.length) return null;

  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  let firstMatch = -1;

  for (let i = 0; i < target.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    positions.push(i);
    let s = MATCH;
    if (isWordStart(target, i)) s += WORD_START;
    if (i === prevMatch + 1) s += CONSECUTIVE;
    if (firstMatch < 0) firstMatch = i;
    score += s;
    prevMatch = i;
    qi++;
  }

  if (qi < q.length) return null;

  // Prefer matches that start near the front of the label.
  score -= Math.min(firstMatch, 10);
  // Mild preference for tighter labels (fewer unmatched trailing chars).
  score -= Math.max(0, target.length - q.length) * 0.1;
  return { score, positions };
}

/**
 * Rank items against a query. An empty query returns every item in natural
 * order (score 0). Otherwise non-matching items are dropped and the rest
 * sort by score desc, then by `weight` asc, then shorter label, then label
 * text — a stable, predictable order.
 */
export function rankItems<T extends PaletteItem>(items: T[], query: string): RankedItem<T>[] {
  const q = query.trim();
  if (q.length === 0) {
    return items.map(item => ({ item, match: { score: 0, positions: [] } }));
  }
  const ranked: RankedItem<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(q, item.label);
    if (match) ranked.push({ item, match });
  }
  ranked.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    const wa = a.item.weight ?? 0;
    const wb = b.item.weight ?? 0;
    if (wa !== wb) return wa - wb;
    if (a.item.label.length !== b.item.label.length) return a.item.label.length - b.item.label.length;
    return a.item.label.localeCompare(b.item.label);
  });
  return ranked;
}

/**
 * Split a label into highlighted / plain runs from a match's positions, so
 * the UI can render matched characters emphasised without re-running the
 * matcher. Adjacent matched indices coalesce into one run.
 */
export interface LabelRun {
  text: string;
  match: boolean;
}

export function highlightRuns(label: string, positions: number[]): LabelRun[] {
  if (positions.length === 0) return label ? [{ text: label, match: false }] : [];
  const set = new Set(positions);
  const runs: LabelRun[] = [];
  let buf = '';
  let bufMatch = set.has(0);
  for (let i = 0; i < label.length; i++) {
    const m = set.has(i);
    if (m === bufMatch) {
      buf += label[i];
    } else {
      if (buf) runs.push({ text: buf, match: bufMatch });
      buf = label[i];
      bufMatch = m;
    }
  }
  if (buf) runs.push({ text: buf, match: bufMatch });
  return runs;
}
