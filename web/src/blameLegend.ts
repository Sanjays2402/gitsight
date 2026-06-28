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

// ── Blame line context menu (W77) ────────────────────────────────────

/** The actions a blame line's right-click menu can offer (W77). */
export type BlameMenuAction = 'isolate' | 'show-all' | 'view-author' | 'copy-line';

/** One choice in a blame line's context menu (data only — no DOM/closure). */
export interface BlameMenuChoice {
  action: BlameMenuAction;
  label: string;
  /** The author this choice acts on (isolate / view-author). */
  author?: string;
  /** The author's resolved email (view-author only), when known. */
  email?: string;
  /** Draw a hairline separator above this item. */
  separator?: boolean;
}

/** The state a blame line menu is built from (W77). */
export interface BlameMenuContext {
  /** The right-clicked line's author name. */
  author: string;
  /** The right-clicked line's author email (may be empty). */
  email?: string;
  /** The currently-isolated author, or null when showing all. */
  activeAuthor: string | null;
  /** Whether a "view contributor" panel can be opened (email-keyed W23). */
  canViewAuthor?: boolean;
  /** Whether line-copy permalinks are wired (W57). */
  canCopyLine?: boolean;
}

/**
 * Build the choice list for a blame line's right-click menu (W77), so the
 * W40/W76 author isolate is reachable without hunting the legend. Pure (data
 * only — the view maps each choice to a real ContextMenuItem with its closure),
 * so the gating logic is unit-testable:
 *
 *  - Right-clicking the ACTIVE author's line offers only "Show all authors".
 *  - Right-clicking a non-active author offers "Isolate <author>"; if a
 *    DIFFERENT author is currently isolated, "Show all authors" is added too
 *    so you can clear without first isolating this one.
 *  - "View <author>'s contributions" is offered when the W23 panel is wired
 *    AND an email resolved (the panel is email-keyed).
 *  - "Copy link to this line" is offered when the W57 permalink is wired.
 *
 * The author-actions and the copy/view actions are separated by a hairline so
 * the destructive-ish filter actions read apart from the navigation ones.
 */
export function buildBlameLineMenu(ctx: BlameMenuContext): BlameMenuChoice[] {
  const choices: BlameMenuChoice[] = [];
  const isActive = ctx.activeAuthor !== null && norm(ctx.activeAuthor) === norm(ctx.author);
  if (isActive) {
    choices.push({ action: 'show-all', label: 'Show all authors' });
  } else {
    choices.push({ action: 'isolate', label: `Isolate ${ctx.author}`, author: ctx.author });
    // Another author is isolated -> let the user clear straight from here too.
    if (ctx.activeAuthor !== null) {
      choices.push({ action: 'show-all', label: 'Show all authors' });
    }
  }
  if (ctx.canViewAuthor && ctx.email) {
    choices.push({
      action: 'view-author',
      label: `View ${ctx.author}'s contributions`,
      author: ctx.author,
      email: ctx.email,
      separator: true,
    });
  }
  if (ctx.canCopyLine) {
    choices.push({ action: 'copy-line', label: 'Copy link to this line', separator: true });
  }
  return choices;
}

// ── Blame author command-palette source (W82) ────────────────────────

/** A palette action for the blame author isolate (W82). */
export type BlameAuthorPaletteAction = 'isolate' | 'show-all';

/** One Cmd-K entry scoped to the loaded blame's authors (W82, data only). */
export interface BlameAuthorPaletteItem {
  action: BlameAuthorPaletteAction;
  label: string;
  /** The author to isolate (isolate only; absent for show-all). */
  author?: string;
}

/**
 * Build the command-palette source for the loaded blame's authors (W82), so
 * the W40/W76 isolate is reachable from Cmd-K, not just the legend (W40) or a
 * right-click (W77). Mirrors the W32 commit-search provider pattern: pure +
 * data only (the view maps each entry to a real PaletteItem with its run),
 * so the gating is unit-testable.
 *
 *  - When an author is isolated, the first entry is "Show all authors" so the
 *    filter can be cleared from the palette, followed by an "Isolate <name>"
 *    for every OTHER author (re-isolating the active one is a no-op, so it's
 *    omitted).
 *  - When nothing is isolated, every author gets an "Isolate <name>" entry.
 *
 * Authors are de-duped case-insensitively (the blame model's author list is
 * already distinct, but this stays defensive) and capped at `limit` isolate
 * entries so a file touched by hundreds of authors can't flood the palette;
 * the palette's own fuzzy filter narrows from there.
 */
export function blameAuthorPaletteItems(
  authors: ReadonlyArray<{ author: string }>,
  active: string | null,
  limit = 12,
): BlameAuthorPaletteItem[] {
  const items: BlameAuthorPaletteItem[] = [];
  const activeNorm = active ? norm(active) : null;
  if (activeNorm) {
    items.push({ action: 'show-all', label: 'Blame: show all authors' });
  }
  const seen = new Set<string>();
  const cap = Math.max(0, Math.floor(limit));
  let added = 0;
  for (const a of authors) {
    const name = (a.author || '').trim();
    if (!name) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    // Re-isolating the already-active author would be a no-op — skip it.
    if (activeNorm && key === activeNorm) continue;
    if (added >= cap) break;
    items.push({ action: 'isolate', label: `Blame: isolate ${name}`, author: name });
    added++;
  }
  return items;
}
