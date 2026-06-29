/**
 * Pure presentation helpers for the compare view (W18).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The
 * compare view (compareView.ts) owns the DOM; the pure string/number
 * transforms live here. Imports the shared CompareFile type via a relative
 * .ts path so Node resolves it without the @shared Vite alias.
 *
 * Tests: web/src/compareFormat.test.mjs
 */

import type { CompareFile, CompareFileStatus, CompareCommit } from '../../src/shared/rangeCompare.ts';

/** Single-letter glyph for a compare file status (monochrome chrome). */
export function compareGlyph(status: CompareFileStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
    default:
      return '?';
  }
}

/** Human label for a compare file status (tooltip / aria). */
export function compareLabel(status: CompareFileStatus): string {
  return status === 'typechange' ? 'type change' : status;
}

/** Churn cell parts for one compare file: `+N -M`, `binary`, or `0`. */
export interface CompareChurn {
  binary: boolean;
  insertions: number;
  deletions: number;
  text: string;
}

export function compareChurn(file: CompareFile): CompareChurn {
  if (file.binary) return { binary: true, insertions: 0, deletions: 0, text: 'binary' };
  const ins = Math.max(0, file.insertions);
  const del = Math.max(0, file.deletions);
  const segs: string[] = [];
  if (ins > 0) segs.push(`+${ins}`);
  if (del > 0) segs.push(`-${del}`);
  return { binary: false, insertions: ins, deletions: del, text: segs.length ? segs.join(' ') : '0' };
}

/** Split a path into directory + filename (dim dir, emphasise base). */
export function splitComparePath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * Normalise + validate a user-entered ref so a stray flag/space can't be
 * smuggled toward the companion (which also guards via isSafeRev, but a
 * client-side check gives instant feedback). Returns the trimmed ref or
 * null when it's empty / obviously unsafe.
 */
export function sanitizeRef(ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  if (/[\s]/.test(r)) return null;
  if (r.startsWith('-')) return null;
  if (r.length > 200) return null;
  return r;
}

// ── Commit-list filtering (W54) ──────────────────────────────────────

/** The minimal commit shape the compare commit-list filter matches against. */
export type FilterableCommit = Pick<CompareCommit, 'sha' | 'shortSha' | 'author' | 'subject'>;

/** Normalise a commit-filter query: trimmed + lowercased. */
export function normalizeCommitQuery(query: string): string {
  return (query ?? '').trim().toLowerCase();
}

/**
 * Whether a single commit matches a (raw) query (W54). An empty/whitespace
 * query matches everything. Otherwise the lowercased query must be a
 * substring of the subject, the author, or either sha form — so you can find
 * a commit in a wide ahead/behind column by what you remember about it
 * (a word from the message, who wrote it, or a sha prefix).
 */
export function commitMatchesQuery(commit: FilterableCommit, query: string): boolean {
  const q = normalizeCommitQuery(query);
  if (!q) return true;
  if (commit.subject.toLowerCase().includes(q)) return true;
  if (commit.author.toLowerCase().includes(q)) return true;
  if (commit.sha.toLowerCase().includes(q)) return true;
  if (commit.shortSha.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Filter a commit list by a subject/author/sha query (W54). Preserves the
 * input order and identity (returns the same objects). An empty query returns
 * a fresh copy of the list so callers can treat the result uniformly.
 */
export function filterCompareCommits<T extends FilterableCommit>(commits: T[], query: string): T[] {
  const q = normalizeCommitQuery(query);
  if (!q) return commits.slice();
  return commits.filter(c => commitMatchesQuery(c, q));
}

/**
 * The first commit matching a query across the two compare columns (W62), or
 * null when none match (or the query is empty). `ahead` is searched before
 * `behind` so pressing Enter in the filter box resolves to the commit unique
 * to head first — the side users are usually hunting in. Order within a column
 * is preserved (newest-first as the columns render).
 */
export function firstCompareMatch<T extends FilterableCommit>(
  ahead: T[],
  behind: T[],
  query: string,
): T | null {
  const q = normalizeCommitQuery(query);
  if (!q) return null;
  for (const c of ahead) if (commitMatchesQuery(c, q)) return c;
  for (const c of behind) if (commitMatchesQuery(c, q)) return c;
  return null;
}

// ── Match-list keyboard stepping (W70) ───────────────────────────────

/**
 * Step a focused index through a match list (W70). `count` is how many matches
 * there are; `current` is the focused index (-1 = nothing focused yet); `delta`
 * is +1 (next) or -1 (previous). Returns the next index, wrapping around the
 * ends so Down past the last match lands on the first and Up past the first
 * lands on the last. An empty list returns -1 (nothing to focus). A first step
 * from -1 lands on the first match for +1 and the last for -1, so pressing Down
 * with nothing focused selects the top match.
 *
 * Pure so the wrap/clamp logic is testable without the DOM; the compare view
 * owns the focus-ring rendering + the keyboard wiring.
 */
export function stepMatch(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (delta === 0) return current < 0 ? -1 : Math.min(current, count - 1);
  // From "nothing focused", a forward step starts at 0 and a backward step at
  // the last index.
  if (current < 0) return delta > 0 ? 0 : count - 1;
  // Wrap with a positive modulo so -1 maps to count-1.
  return ((current + delta) % count + count) % count;
}

/**
 * Legible match-count readout for the compare filter box (W74). Reports how
 * many commits match the query and, once the user steps a focus ring through
 * them (W70), the 1-based position of the focused match — so a wide range's
 * "where am I in the matches" is visible at a glance.
 *
 * - No matches (count 0): "No matches".
 * - Matches but nothing focused (focusIdx < 0): "N matches" (or "1 match").
 * - A focused match: "i of N" (1-based), clamped into range defensively.
 *
 * Returns '' for a non-positive count when the caller wants to hide the badge
 * entirely on an empty query — but callers typically only mount the badge when
 * the filter box is shown, so the explicit "No matches" covers a live query
 * that simply matches nothing.
 */
export function matchSummary(count: number, focusIdx: number): string {
  if (count <= 0) return 'No matches';
  if (focusIdx < 0) return count === 1 ? '1 match' : `${count} matches`;
  const pos = Math.min(Math.max(0, focusIdx), count - 1) + 1;
  return `${pos} of ${count}`;
}

// ── Empty-match reveal (W78) ─────────────────────────────────────────

/**
 * Whether the compare filter should reveal its "no commits match" state (W78).
 * True only when the user has typed a non-empty query AND it matches nothing,
 * so the view can scroll the empty columns into view + announce it. A blank
 * query (everything matches) or a query with results returns false, so we don't
 * yank the scroll on a partial match or an empty box.
 */
export function shouldRevealEmpty(query: string, matchCount: number): boolean {
  return normalizeCommitQuery(query).length > 0 && matchCount <= 0;
}

/**
 * The notice text for the compare filter's empty state (W78). When a non-empty
 * query matches nothing, returns `No commits match "<query>"` (the raw query
 * trimmed for display, not lowercased, so the user sees what they typed).
 * Returns '' when there's a match or the query is blank so the caller can hide
 * the notice. Long queries are ellipsised so the banner can't blow out.
 */
export function emptyFilterMessage(query: string, matchCount: number): string {
  if (!shouldRevealEmpty(query, matchCount)) return '';
  const shown = query.trim();
  const clipped = shown.length > 60 ? `${shown.slice(0, 60)}\u2026` : shown;
  return `No commits match \u201c${clipped}\u201d`;
}

// ── Compare ref command-palette source (W87) ─────────────────────────

/** Which side of the comparison a ref takes in a palette entry (W87). */
export type CompareRefSide = 'against-head' | 'from-head';

/** One Cmd-K entry that loads a comparison for a ref (W87, data only). */
export interface CompareRefPaletteItem {
  /** "Compare <ref> with HEAD" (ref is the base) or the reverse (ref is head). */
  side: CompareRefSide;
  label: string;
  /** The base ref of the comparison this entry loads. */
  base: string;
  /** The head ref of the comparison this entry loads. */
  head: string;
  /**
   * A compact divergence readout vs HEAD (W95), e.g. "3 ahead, 1 behind", set
   * only when a `divergence` lookup is supplied. Lets the palette double as a
   * quick "how far has this ref drifted from HEAD" scan. Absent otherwise.
   */
  hint?: string;
}

/** A ref's ahead/behind position vs HEAD over the loaded snapshot (W95). */
export interface RefDivergence {
  /** Commits reachable from the ref but not HEAD. */
  ahead: number;
  /** Commits reachable from HEAD but not the ref. */
  behind: number;
  /** False when the count is a lower bound (history was --max-capped). */
  exact: boolean;
}

/**
 * Adapter from a W29 RefInsight to the W95 divergence hint wording (W100). The
 * rail popover and the compare palette both show "how far is this ref from
 * HEAD", but historically diverged on the level-case label ("up to date with
 * HEAD" vs "even with HEAD"). This funnels the popover through the same
 * `refDivergenceHint`, so both surfaces read identically. Pure (a thin field
 * map) so the unification is unit-testable.
 */
export function refInsightDivergenceHint(insight: { ahead: number; behind: number; exact: boolean }): string {
  return refDivergenceHint({ ahead: insight.ahead, behind: insight.behind, exact: insight.exact });
}

/**
 * Compact divergence readout for a compare-ref palette hint (W95). Mirrors the
 * W29 `aheadBehindLabel` shape but tuned for an inline palette hint: "even with
 * HEAD" when level, else "N ahead, M behind" trimming a zero side, with a `~`
 * prefix on an inexact (history-capped) count. Pure so the wording is testable.
 */
export function refDivergenceHint(div: RefDivergence): string {
  const approx = div.exact ? '' : '~';
  if (div.ahead <= 0 && div.behind <= 0) return 'even with HEAD';
  const parts: string[] = [];
  if (div.ahead > 0) parts.push(`${approx}${div.ahead} ahead`);
  if (div.behind > 0) parts.push(`${approx}${div.behind} behind`);
  return parts.join(', ');
}

/**
 * Build the command-palette source for comparing the loaded snapshot's refs
 * against HEAD (W87), so a comparison is reachable from Cmd-K without typing
 * into the Compare form. Mirrors the W82 blame-author / W32 commit-search
 * provider pattern: pure + data only (the view maps each entry to a real
 * PaletteItem with its run), so the gating is unit-testable.
 *
 * For each ref we emit the natural "Compare <ref> with HEAD" (ref...HEAD, the
 * common "what's on HEAD that <ref> doesn't have" direction) and the reverse
 * "Compare HEAD with <ref>" (HEAD...ref) so either direction is one keystroke.
 * The current-branch ref (the one HEAD already points at) is skipped — comparing
 * a ref with itself is a no-op — as is anything literally named HEAD.
 *
 * Refs run through `sanitizeRef` so a crafted ref name can't smuggle a flag or
 * space toward the companion, de-dupe case-insensitively, and the ref count is
 * capped at `limit` (each yielding two entries) so a repo with hundreds of refs
 * can't flood the palette; the palette's own fuzzy filter narrows from there.
 *
 * W95: when a `divergence` lookup is supplied (the host computes ahead/behind
 * vs HEAD client-side from the loaded snapshot via the W29 refInsight), each
 * entry gains a compact `hint` ("3 ahead, 1 behind") so the palette doubles as
 * a divergence scan. Both directions for a ref share the same hint (it's the
 * ref's position vs HEAD). Omitted when no lookup is given so the entry shape is
 * unchanged for callers that don't pass one.
 */
export function compareRefPaletteItems(
  refs: ReadonlyArray<{ name: string }>,
  head = 'HEAD',
  currentBranch: string | null = null,
  limit = 30,
  divergence?: (refName: string) => RefDivergence | null,
): CompareRefPaletteItem[] {
  const items: CompareRefPaletteItem[] = [];
  const seen = new Set<string>();
  const cap = Math.max(0, Math.floor(limit));
  const currentNorm = (currentBranch ?? '').trim().toLowerCase();
  let added = 0;
  for (const r of refs) {
    if (added >= cap) break;
    const name = sanitizeRef(r?.name ?? '');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Comparing the ref HEAD already points at (or a literal "HEAD") is a no-op.
    if (key === 'head' || (currentNorm && key === currentNorm)) continue;
    // W95: the ref's divergence vs HEAD, when the host supplies a lookup.
    const div = divergence ? divergence(name) : null;
    const hint = div ? refDivergenceHint(div) : undefined;
    const against: CompareRefPaletteItem = { side: 'against-head', label: `Compare ${name} with HEAD`, base: name, head };
    const from: CompareRefPaletteItem = { side: 'from-head', label: `Compare HEAD with ${name}`, base: head, head: name };
    if (hint !== undefined) {
      against.hint = hint;
      from.hint = hint;
    }
    items.push(against, from);
    added++;
  }
  return items;
}

// ── Compare ref-pair validation (W92) ────────────────────────────────

/** The outcome of validating a base/head ref pair for a comparison (W92). */
export type CompareRouteResult =
  | { ok: true; base: string; head: string }
  | { ok: false; reason: 'empty-base' | 'empty-head' | 'self-compare' };

/** The non-ok reasons a compare pair can be rejected for (W92). */
export type CompareRouteError = Exclude<CompareRouteResult, { ok: true }>['reason'];

/**
 * Validate + normalise a base/head ref pair into a runnable comparison (W92).
 * The single source of truth shared by the Compare form submit, the W87
 * command-palette ref entries, and a deep link's round-trip, so every path
 * that loads a comparison agrees on what's valid:
 *
 *  - Each ref runs through `sanitizeRef` (trim, reject flags/spaces/over-long);
 *    a ref that doesn't survive yields an `empty-base` / `empty-head` reason.
 *  - A self-comparison (base and head resolve to the same ref, case-insensitive)
 *    is rejected with `self-compare` — `git diff main...main` is always empty, so
 *    loading it just writes a junk `#compare?base=main&head=main` hash and an
 *    empty result. Callers surface a quiet notice instead of running it.
 *
 * Pure so the gating is unit-testable without the DOM or a backend; the view
 * maps an `ok:false` reason to a toast and an `ok:true` to a `runCompare`.
 */
export function compareRouteFromRefs(base: string, head: string): CompareRouteResult {
  const b = sanitizeRef(base);
  if (!b) return { ok: false, reason: 'empty-base' };
  const h = sanitizeRef(head);
  if (!h) return { ok: false, reason: 'empty-head' };
  if (b.toLowerCase() === h.toLowerCase()) return { ok: false, reason: 'self-compare' };
  return { ok: true, base: b, head: h };
}

/** Human notice for a rejected compare ref pair (W92), for a toast/aria. */
export function compareRouteError(reason: CompareRouteError): string {
  switch (reason) {
    case 'empty-base':
      return 'Enter a base ref to compare';
    case 'empty-head':
      return 'Enter a ref to compare against';
    case 'self-compare':
      return 'Pick two different refs to compare';
  }
}

/**
 * Inline-notice text for a rejected compare pair shown under the form (W98).
 * Unlike the transient W92 toast, this names the specific clash so two
 * still-valid-looking ref inputs explain themselves. For a self-compare it
 * names both refs ("main and HEAD point at the same commit") using the raw,
 * trimmed values the user typed; for an empty side it falls back to the W92
 * wording. Returns '' for an ok pair so the caller hides the notice. Pure so
 * the wording is testable without the form.
 */
export function compareInvalidNotice(reason: CompareRouteError, base: string, head: string): string {
  if (reason === 'self-compare') {
    const b = base.trim();
    const h = head.trim();
    return b && h ? `${b} and ${h} point at the same commit` : 'Pick two different refs to compare';
  }
  return compareRouteError(reason);
}

// ── Self-compare one-key recovery (W103) ─────────────────────────────

/**
 * Suggest the most useful OTHER ref to compare against when a self-compare is
 * detected (W103). On a `main...main` clash the user almost always wants to
 * retype the HEAD side; this picks the ref that's diverged the MOST from the
 * base (ahead + behind, vs HEAD as a tie-break weight) so a one-key fix lands
 * on the ref with something worth comparing, not a level sibling.
 *
 * `base` is the clashing ref; `refs` carry an optional ahead/behind position.
 * Refs equal to the base (case-insensitive) are skipped, blanks dropped, and a
 * ref's score is ahead+behind (higher = more diverged). Ties keep the input
 * order so a snapshot's natural ordering (current branch first) decides. Returns
 * null when there's no other ref to suggest. Pure so the pick is testable; the
 * form focuses + selects the head field with the suggestion on Enter.
 */
export function nextRefSuggestion(
  base: string,
  refs: ReadonlyArray<{ name: string; ahead?: number; behind?: number }>,
): string | null {
  const b = (base ?? '').trim().toLowerCase();
  let best: string | null = null;
  let bestScore = -1;
  for (const r of refs) {
    const name = sanitizeRef(r?.name ?? '');
    if (!name || name.toLowerCase() === b) continue;
    const score = Math.max(0, r.ahead ?? 0) + Math.max(0, r.behind ?? 0);
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

// ── Divergence classification (W105) ─────────────────────────────────

/**
 * The shape of a ref's position vs HEAD, for a one-glance dot colour (W105).
 * A clean fast-forward reads differently from a real divergence at a glance:
 *   - 'level'    : even with HEAD (no ahead, no behind);
 *   - 'ahead'    : only ahead (HEAD can fast-forward to it);
 *   - 'behind'   : only behind (it can fast-forward to HEAD);
 *   - 'diverged' : both ahead AND behind (a merge/rebase is needed).
 * Reused by the rail popover so the W100-unified label gains a colour band.
 */
export type DivergenceClass = 'level' | 'ahead' | 'behind' | 'diverged';

/** Classify a ref's ahead/behind into one of the four divergence shapes (W105). */
export function divergenceClass(div: { ahead: number; behind: number }): DivergenceClass {
  const ahead = div.ahead > 0;
  const behind = div.behind > 0;
  if (ahead && behind) return 'diverged';
  if (ahead) return 'ahead';
  if (behind) return 'behind';
  return 'level';
}

// ── Self-compare suggestion affordance (W108) ────────────────────────

/**
 * Label for the inline "compare against <ref>?" affordance shown beside the
 * W98 self-notice (W108). W103 silently retyped HEAD on a clash; this surfaces
 * the suggestion as a visible, clickable link so the recovery isn't a hidden
 * keystroke. Pure so the wording is testable; the view wires a button to a real
 * onCompare. Returns '' for a blank/unsafe ref so the caller hides the link.
 */
export function suggestionLabel(ref: string): string {
  const r = sanitizeRef(ref ?? '');
  return r ? `Compare with ${r} instead` : '';
}

/**
 * Where to land focus after a self-compare clash (W115). W108 surfaces a
 * clickable \"Compare with <ref> instead\" suggestion, but recovery still needed
 * the mouse. When a suggestion is present, focus it ('suggest') so a single
 * Enter runs the comparison; otherwise focus the head field ('head') so the
 * user can retype. Pure so the choice is testable; the view focuses the matching
 * element. Keeps keyboard recovery to one key when a suggestion exists.
 */
export function suggestionFocusTarget(hasSuggestion: boolean): 'suggest' | 'head' {
  return hasSuggestion ? 'suggest' : 'head';
}

// ── Divergence ordering (W110) ───────────────────────────────────────

/**
 * Rank a divergence class so the rail can sort refs most-diverged first (W110):
 * a real divergence (both ahead and behind, needing a merge) is the most
 * interesting, then a one-sided drift (ahead or behind), then level refs that
 * are even with HEAD. Pure so the ordering is testable.
 */
function divergenceRank(cls: DivergenceClass): number {
  switch (cls) {
    case 'diverged':
      return 3;
    case 'ahead':
    case 'behind':
      return 2;
    case 'level':
      return 0;
  }
}

/**
 * Comparator that orders two refs by how far each has diverged from HEAD (W110),
 * most-diverged first, reusing the W105 classes: diverged > ahead/behind >
 * level. Within the same class the bigger total drift (ahead + behind) sorts
 * first so the busiest ref leads, and a stable tie keeps 0 so the caller's
 * existing order (alphabetical sections) survives. Pure (returns a number) so a
 * rail header toggle can sort the ref list without the comparator touching DOM.
 */
export function compareDivergence(
  a: { ahead: number; behind: number },
  b: { ahead: number; behind: number },
): number {
  const rankDelta = divergenceRank(divergenceClass(b)) - divergenceRank(divergenceClass(a));
  if (rankDelta !== 0) return rankDelta;
  return (b.ahead + b.behind) - (a.ahead + a.behind);
}

// ── Self-compare suggestion palette source (W120) ────────────────────

/** One Cmd-K entry for the self-compare recovery suggestion (W120, data only). */
export interface CompareSuggestPaletteItem {
  /** The base ref of the recovered comparison (the clashing ref kept as base). */
  base: string;
  /** The suggested head ref to compare against instead. */
  head: string;
  /** "Compare <base> with <head> instead" — the palette label. */
  label: string;
}

/**
 * Build the command-palette source for the self-compare recovery (W120), so the
 * W103/W108 suggestion is reachable from Cmd-K too, not just the inline pill.
 * Pure + data only (the view maps the entry to a real PaletteItem with its run),
 * mirroring the W82/W87/W119 sources. Returns a single entry only when the
 * loaded comparison is a genuine self-compare (base === head, case-insensitive)
 * AND a distinct suggestion exists; both refs run through sanitizeRef so a
 * suggestion equal to the base, or an unsafe ref, yields nothing. Empty list
 * otherwise so a healthy comparison contributes no palette noise.
 */
export function compareSuggestPaletteItems(
  base: string,
  head: string,
  suggestion: string | null,
): CompareSuggestPaletteItem[] {
  const b = sanitizeRef(base ?? '');
  const h = sanitizeRef(head ?? '');
  const s = sanitizeRef(suggestion ?? '');
  // Only on a real self-compare clash, with a distinct suggestion to offer.
  if (!b || !h || b.toLowerCase() !== h.toLowerCase()) return [];
  if (!s || s.toLowerCase() === b.toLowerCase()) return [];
  return [{ base: b, head: s, label: `Compare ${b} with ${s} instead` }];
}
