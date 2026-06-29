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

/** The actions a blame line's right-click menu can offer (W77; W90). */
export type BlameMenuAction = 'isolate' | 'show-all' | 'view-author' | 'copy-line' | 'open-line';

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
  /** Whether opening a line permalink in a new tab is wired (W90). */
  canOpenLine?: boolean;
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
 *  - "Open line in new tab" (W90) follows the copy entry when wired, so a
 *    specific blamed line is one click to revisit in a fresh tab.
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
  // W90: only a hairline above when it's the FIRST nav entry (no copy above it),
  // so the copy + open pair reads as one group.
  if (ctx.canOpenLine) {
    choices.push({ action: 'open-line', label: 'Open line in new tab', separator: !ctx.canCopyLine });
  }
  return choices;
}

// ── Blame author isolate keyboard cycle (W126) ───────────────────────

/**
 * Pick the next author to isolate when cycling the blame legend from the
 * keyboard (W126: `a`/`A` on the Blame view). Walks the authors in the same
 * ownership order the palette uses (W102: most lines first, share + name
 * tie-breaks) so `a` steps from the biggest owner down. The cycle is:
 *
 *   show-all (null) -> author[0] -> author[1] -> ... -> author[n-1] -> null -> ...
 *
 * so repeatedly pressing `a` isolates each author in turn and then returns to
 * "show all", never getting stuck. Returns the next author NAME to isolate, or
 * null to show all. An empty author list yields null (nothing to isolate).
 * Case-insensitive match on the active author; an active author no longer in the
 * list (e.g. after a file switch) restarts at the first. Pure so the cycle is
 * testable; the view feeds the result into setBlameAuthor.
 */
export function nextBlameAuthor(
  authors: ReadonlyArray<{ author: string; lines?: number; share?: number }>,
  active: string | null,
): string | null {
  const sorted = sortBlameAuthorsForPalette(authors)
    .map(a => (a.author || '').trim())
    .filter(Boolean);
  if (sorted.length === 0) return null;
  if (!active) return sorted[0];
  const activeNorm = norm(active);
  const idx = sorted.findIndex(name => norm(name) === activeNorm);
  // Active not in the list -> restart the cycle at the biggest owner.
  if (idx < 0) return sorted[0];
  // Last author -> wrap back to "show all"; otherwise step to the next.
  return idx >= sorted.length - 1 ? null : sorted[idx + 1];
}

/**
 * Pick the PREVIOUS author to isolate when cycling the blame legend backward
 * from the keyboard (W131: `A`/Shift-a on the Blame view). The mirror of
 * nextBlameAuthor over the same W102 ownership order, so a long author list is
 * reachable in both directions. The cycle is:
 *
 *   show-all (null) -> author[n-1] -> ... -> author[1] -> author[0] -> null -> ...
 *
 * so from "show all" the first backward step lands on the SMALLEST owner (the
 * tail of the order `a` walks toward), then steps up toward the biggest, and
 * wraps back to "show all" past the first. Returns the previous author NAME to
 * isolate, or null to show all. An empty author list yields null. Case-insensitive
 * match on the active author; an active author no longer in the list restarts at
 * the LAST entry (mirroring nextBlameAuthor's restart-at-first). Pure so the
 * cycle is testable; the view feeds the result into setBlameAuthor.
 */
export function prevBlameAuthor(
  authors: ReadonlyArray<{ author: string; lines?: number; share?: number }>,
  active: string | null,
): string | null {
  const sorted = sortBlameAuthorsForPalette(authors)
    .map(a => (a.author || '').trim())
    .filter(Boolean);
  if (sorted.length === 0) return null;
  const last = sorted.length - 1;
  if (!active) return sorted[last];
  const activeNorm = norm(active);
  const idx = sorted.findIndex(name => norm(name) === activeNorm);
  // Active not in the list -> restart the backward cycle at the smallest owner.
  if (idx < 0) return sorted[last];
  // First author -> wrap back to "show all"; otherwise step to the previous.
  return idx <= 0 ? null : sorted[idx - 1];
}

/** A palette action for the blame author isolate (W82). */
export type BlameAuthorPaletteAction = 'isolate' | 'show-all';

/** One Cmd-K entry scoped to the loaded blame's authors (W82, data only). */
export interface BlameAuthorPaletteItem {
  action: BlameAuthorPaletteAction;
  label: string;
  /** The author to isolate (isolate only; absent for show-all). */
  author?: string;
  /**
   * A compact ownership readout (W97) — e.g. "128 lines · 34%" — set on the
   * isolate entries when the blame model carries the author's line count/share,
   * so the palette doubles as a "who owns this file" scan. Absent on show-all
   * and when no stats are available.
   */
  hint?: string;
}

/**
 * Compact ownership readout for a blame-author palette hint (W97; W112). Renders
 * the author's line count + rounded share of the file, e.g. "128 lines · 34%",
 * or just the count when the share is unknown. Singular "1 line". W112: when the
 * lines/share are mismatched — many lines but a tiny share, or few lines but a
 * big share — a "concentrated" / "spread thin" micro-tag is appended so the
 * skew is visible at a glance. Pure so the wording is testable; the view
 * composes it into the palette item hint.
 */
export function blameAuthorShareHint(lines: number, share: number): string {
  const n = Math.max(0, Math.floor(lines || 0));
  const lineWord = n === 1 ? 'line' : 'lines';
  const pct = Number.isFinite(share) && share > 0 ? Math.round(share * 100) : 0;
  const base = pct > 0 ? `${n} ${lineWord} \u00b7 ${pct}%` : `${n} ${lineWord}`;
  const tag = ownershipTag(n, share);
  return tag ? `${base} \u00b7 ${tag}` : base;
}

/**
 * A micro-tag describing skewed ownership for a blame author (W112): "spread
 * thin" when the author touched many lines but owns a small share of the file
 * (work scattered across a big codebase), "concentrated" when they own a large
 * share off relatively few lines (a focused stake in a small file). Empty for a
 * balanced or stat-less author so the common case carries no tag. Thresholds:
 * >= 100 lines under 10% reads spread-thin; >= 60% share under 40 lines reads
 * concentrated. Pure so the bands are testable.
 */
export function ownershipTag(lines: number, share: number): string {
  const n = Math.max(0, Math.floor(lines || 0));
  const pct = Number.isFinite(share) && share > 0 ? share : 0;
  if (n >= 100 && pct > 0 && pct < 0.1) return 'spread thin';
  if (pct >= 0.6 && n > 0 && n < 40) return 'concentrated';
  return '';
}

/** The ownership filter the blame legend can scope to (W116). */
export type OwnershipFilter = 'concentrated' | 'spread-thin';

/**
 * Whether a blame author passes the active ownership filter (W116). Reuses the
 * W112 ownershipTag bands so the quick filter agrees exactly with the micro-tag:
 * a 'concentrated' filter keeps only authors tagged \"concentrated\", 'spread-thin'
 * only those tagged \"spread thin\", and a null filter keeps everyone. Pure so the
 * predicate is testable; the legend dims/hides non-matching chips. Stat-less
 * authors (no tag) never match a non-null filter, so they fall away when one's on.
 */
export function matchesOwnership(lines: number, share: number, filter: OwnershipFilter | null): boolean {
  if (!filter) return true;
  const tag = ownershipTag(lines, share);
  return filter === 'concentrated' ? tag === 'concentrated' : tag === 'spread thin';
}

/**
 * Toggle the ownership filter (W116): clicking the active band clears it,
 * clicking the other switches to it. Mirrors toggleAuthorFilter's shape so the
 * two legend toggles behave identically. Returns the next filter (or null).
 */
export function toggleOwnershipFilter(current: OwnershipFilter | null, clicked: OwnershipFilter): OwnershipFilter | null {
  return current === clicked ? null : clicked;
}

/**
 * Map a keypress to an ownership-band toggle on the Blame view (W121): `c`/`C`
 * toggles "concentrated", `t`/`T` toggles "spread-thin" (mnemonic: thin), so the
 * W116 legend bands are reachable without the chips. Returns the band to toggle,
 * or null for any other key. Pure so the key map is testable; the view feeds the
 * result into toggleOwnershipFilter. Mirrors the W88 toggleActivityMetric /
 * W122 contributor-sort key-map shape.
 */
export function ownershipKeyAction(key: string): OwnershipFilter | null {
  if (key === 'c' || key === 'C') return 'concentrated';
  if (key === 't' || key === 'T') return 'spread-thin';
  return null;
}

/**
 * Sort blame authors for the palette by ownership (W102; W107): most lines
 * first, share as a secondary tie-break, name as the final stable key — so the
 * biggest owners survive a `limit` cap on a many-author file. Stat-less authors
 * (no `lines`) count as zero and sink below anyone with a line count. W107: when
 * two authors touched the same number of lines, the one owning a larger SHARE of
 * the file sorts first (a low-share author at equal lines is spread thinner), and
 * only then does name (case-insensitive) break a true tie so identical-stat
 * authors keep a stable order. Pure + does NOT mutate the input (works over a
 * fresh copy) so a frozen author list stays intact. Generic over any author-shape
 * with the optional `lines`/`share`.
 */
export function sortBlameAuthorsForPalette<T extends { author: string; lines?: number; share?: number }>(
  authors: ReadonlyArray<T>,
): T[] {
  return authors.slice().sort((a, b) => {
    const la = typeof a.lines === 'number' ? a.lines : 0;
    const lb = typeof b.lines === 'number' ? b.lines : 0;
    if (lb !== la) return lb - la;
    const sa = typeof a.share === 'number' ? a.share : 0;
    const sb = typeof b.share === 'number' ? b.share : 0;
    if (sb !== sa) return sb - sa;
    return norm(a.author).localeCompare(norm(b.author));
  });
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
 *
 * W97: when an author carries `lines`/`share` (the blame model's BlameAuthorStat
 * does), each isolate entry gains a compact `hint` ("128 lines · 34%") so the
 * palette doubles as a "who owns this file" scan. Omitted when the author has no
 * stats, so the W82 entry shape is unchanged for stat-less callers.
 *
 * W102: the list is sorted by ownership (lines desc, name tie-break) BEFORE the
 * cap, so on a file touched by more authors than `limit` the biggest owners
 * always survive the truncation — a tail of one-line drive-by authors can never
 * crowd the people who actually own the file out of the palette.
 */
export function blameAuthorPaletteItems(
  authors: ReadonlyArray<{ author: string; lines?: number; share?: number }>,
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
  for (const a of sortBlameAuthorsForPalette(authors)) {
    const name = (a.author || '').trim();
    if (!name) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    // Re-isolating the already-active author would be a no-op — skip it.
    if (activeNorm && key === activeNorm) continue;
    if (added >= cap) break;
    const item: BlameAuthorPaletteItem = { action: 'isolate', label: `Blame: isolate ${name}`, author: name };
    // W97: an ownership hint when the model carries this author's line stats.
    if (typeof a.lines === 'number') {
      item.hint = blameAuthorShareHint(a.lines, typeof a.share === 'number' ? a.share : 0);
    }
    items.push(item);
    added++;
  }
  return items;
}
