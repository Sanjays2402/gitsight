/**
 * Pure contributor-compare logic (W35).
 *
 * DOM-free + framework-free + NO @shared alias, so it's unit-tested under
 * node --test. The contributors leaderboard (W14) ranks authors but offers
 * no way to set two side by side. This module takes two W23 author details
 * (commits, churn, touched files) and computes the comparison the view
 * renders: per-author totals + the file overlap between them (files BOTH
 * touched, plus each author's exclusive files).
 *
 * The AuthorFile/AuthorDetail shapes come in via a relative .ts import (the
 * same trick the other web helpers use) so Node resolves them at test time
 * without the Vite `@shared` alias.
 *
 * Tests: web/src/contributorCompare.test.mjs
 */

import type { AuthorDetail, AuthorFile } from '../../src/shared/authorDetail.ts';

/** A per-author summary line in the comparison. */
export interface AuthorSummary {
  name: string;
  email: string;
  commits: number;
  insertions: number;
  deletions: number;
  /** Total insertions + deletions across the author's touched files. */
  churn: number;
  /** Distinct files the author has touched. */
  files: number;
}

/** The file-overlap breakdown between two authors. */
export interface FileOverlap {
  /** Paths BOTH authors touched, busiest-combined first. */
  shared: string[];
  /** Count of files only author A touched. */
  onlyA: number;
  /** Count of files only author B touched. */
  onlyB: number;
  /** shared / (union) as a 0..1 Jaccard index (0 when neither touched anything). */
  jaccard: number;
}

/** The full two-author comparison the view renders. */
export interface ContributorComparison {
  a: AuthorSummary;
  b: AuthorSummary;
  overlap: FileOverlap;
}

/** Sum a churn total over an author's files. */
function churnOf(files: AuthorFile[]): number {
  let n = 0;
  for (const f of files) n += Math.max(0, f.insertions) + Math.max(0, f.deletions);
  return n;
}

/** Fold one author detail into a compact summary row. */
export function summariseAuthor(d: AuthorDetail): AuthorSummary {
  let insertions = 0;
  let deletions = 0;
  for (const f of d.files) {
    insertions += Math.max(0, f.insertions);
    deletions += Math.max(0, f.deletions);
  }
  return {
    name: d.name,
    email: d.email,
    commits: d.commits,
    insertions,
    deletions,
    churn: churnOf(d.files),
    files: d.filesTouched,
  };
}

/**
 * Compute the file overlap between two authors from their touched-file
 * lists. `shared` lists paths both touched, ordered by combined churn so
 * the files they collaborate on most surface first. Jaccard = |intersection|
 * / |union| over the touched-file SETS (uses the displayed file lists, which
 * are the most-touched subset — a stable, bounded proxy).
 */
export function fileOverlap(aFiles: AuthorFile[], bFiles: AuthorFile[]): FileOverlap {
  const aChurn = new Map<string, number>();
  for (const f of aFiles) aChurn.set(f.path, Math.max(0, f.insertions) + Math.max(0, f.deletions));
  const bChurn = new Map<string, number>();
  for (const f of bFiles) bChurn.set(f.path, Math.max(0, f.insertions) + Math.max(0, f.deletions));

  const shared: string[] = [];
  for (const path of aChurn.keys()) {
    if (bChurn.has(path)) shared.push(path);
  }
  shared.sort((x, y) => (bChurn.get(y)! + aChurn.get(y)!) - (bChurn.get(x)! + aChurn.get(x)!) || x.localeCompare(y));

  const onlyA = aChurn.size - shared.length;
  const onlyB = bChurn.size - shared.length;
  const union = aChurn.size + bChurn.size - shared.length;
  const jaccard = union > 0 ? shared.length / union : 0;

  return { shared, onlyA, onlyB, jaccard };
}

/** Build the full comparison from two author details. */
export function buildContributorComparison(a: AuthorDetail, b: AuthorDetail): ContributorComparison {
  return {
    a: summariseAuthor(a),
    b: summariseAuthor(b),
    overlap: fileOverlap(a.files, b.files),
  };
}

/** Format the overlap Jaccard as a rounded integer percent. */
export function overlapPercent(overlap: FileOverlap): number {
  return Math.round(overlap.jaccard * 100);
}

// ── Compare pair ordering (W89) ──────────────────────────────────────

/**
 * Swap the two halves of a comparison pair (W89). The W47 deep link
 * (#contributors?vs=a,b) and the W35 panel both render a FIXED A|B order; this
 * flips it so the user can put either author on the left, and the shared link
 * reflects the order they're actually viewing. Pure (a fresh reversed tuple,
 * no mutation) so the ordering logic is testable without the panel — the view
 * passes its `[a, b]` selection and re-opens with `[b, a]`.
 *
 * Works over any `[T, T]` so it serves both the `{email,name}` selection in
 * main.ts and a bare email pair.
 */
export function swapComparePair<T>(pair: readonly [T, T]): [T, T] {
  return [pair[1], pair[0]];
}

// ── Compare panel keyboard (W93) ─────────────────────────────────────

/** What a key pressed while the compare panel is open should do (W93). */
export type ComparePanelKeyAction = 'swap' | 'close' | 'none';

/**
 * Map a key to a compare-panel action (W93). The W35/W47/W89 comparison panel
 * is mouse-only; this gives it keyboard parity with the rest of the app:
 *
 *   - `s` / `S`  -> 'swap'  (reuse the W89 swap-order action).
 *   - `Escape`   -> 'close'.
 *   - anything else -> 'none'.
 *
 * Pure so the mapping is unit-testable without the DOM; the panel owns the
 * listener + a guard so it doesn't fight the palette/help Esc (mirrors W84's
 * `canCloseOnEsc`). `s` is only meaningful when there are two authors to swap,
 * which the panel is by definition (it's open), so no extra gating is needed
 * here — the view no-ops a swap when the selection isn't a pair.
 */
export function comparePanelKeyAction(key: string): ComparePanelKeyAction {
  if (key === 's' || key === 'S') return 'swap';
  if (key === 'Escape') return 'close';
  return 'none';
}

// ── Compare panel focus trap (W99) ───────────────────────────────────

/**
 * Next focusable index when Tab cycles within a trapped panel (W99). `count`
 * is how many focusable controls the panel has; `current` the focused one's
 * index (-1 when focus is outside); `delta` is +1 (Tab) or -1 (Shift-Tab).
 * Wraps both ends so Tab past the last lands on the first and Shift-Tab past
 * the first lands on the last, keeping focus inside the panel. From outside
 * (-1) a forward step lands on the first control and a backward step on the
 * last. An empty panel returns -1 (nothing to focus). Pure so the wrap logic
 * is testable without the DOM; the panel binds Tab to it + calls focus().
 */
export function nextTrapIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return ((current + delta) % count + count) % count;
}

// ── Compare panel initial focus (W104) ───────────────────────────────

/**
 * The control to focus when the compare panel opens (W104). W99 traps Tab but
 * lands focus on the panel root, so a screen-reader user hears the container,
 * not an action. This picks the first ACTIONABLE control instead — the swap
 * button when present (it's the panel's primary action), else the first
 * focusable (the close button) — so opening the panel announces what you can
 * do. `roles` is the panel's tabbable list mapped to what each control is, in
 * DOM order. Returns the index to focus, or -1 when empty. Pure so the choice
 * is testable without the DOM; the panel calls focusables[idx].focus().
 */
export function firstTrapTarget(roles: ReadonlyArray<'swap' | 'share' | 'close' | 'other'>): number {
  if (roles.length === 0) return -1;
  const swap = roles.indexOf('swap');
  if (swap >= 0) return swap;
  const close = roles.indexOf('close');
  if (close >= 0) return close;
  return 0;
}
