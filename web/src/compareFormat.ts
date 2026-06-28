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
 */
export function compareRefPaletteItems(
  refs: ReadonlyArray<{ name: string }>,
  head = 'HEAD',
  currentBranch: string | null = null,
  limit = 30,
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
    items.push({ side: 'against-head', label: `Compare ${name} with HEAD`, base: name, head });
    items.push({ side: 'from-head', label: `Compare HEAD with ${name}`, base: head, head: name });
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
