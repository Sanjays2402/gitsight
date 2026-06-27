/**
 * Pure helpers for the activity day hover popover (W55).
 *
 * DOM-free + framework-free + NO @shared alias, so they're unit-tested under
 * node --test. The activity view (activityView.ts) owns the popover DOM + the
 * hover/fetch lifecycle; the viewport-clamping maths and the subject summary
 * live here where they can be tested without a browser.
 *
 * Tests: web/src/activityTooltip.test.mjs
 */

/** An anchor's viewport-relative rectangle (a calendar cell). */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A box size. */
export interface BoxSize {
  width: number;
  height: number;
}

/** The visible viewport. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** Resolved popover placement: where it lands + which side of the anchor. */
export interface PopoverPlacement {
  left: number;
  top: number;
  side: 'above' | 'below';
}

/**
 * Position a hover popover near an anchor cell (W55), clamped inside the
 * viewport. The popover is centred horizontally on the anchor and prefers to
 * sit ABOVE it (calendars read top-down, so a popover above doesn't cover the
 * row you're scanning). It flips below when there isn't room above, and falls
 * back to whichever side has more room when neither fits. Both axes are
 * clamped to a margin so the box never bleeds off-screen.
 */
export function popoverPosition(
  anchor: AnchorRect,
  size: BoxSize,
  viewport: ViewportSize,
  gap = 8,
  margin = 8,
): PopoverPlacement {
  // Horizontal: centre on the anchor, then clamp to the viewport margins.
  const centerX = (anchor.left + anchor.right) / 2;
  let left = centerX - size.width / 2;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  left = Math.max(margin, Math.min(left, maxLeft));

  // Vertical: prefer above; flip below; else the roomier side.
  const roomAbove = anchor.top;
  const roomBelow = viewport.height - anchor.bottom;
  const needed = size.height + gap;
  let side: 'above' | 'below';
  if (roomAbove >= needed) side = 'above';
  else if (roomBelow >= needed) side = 'below';
  else side = roomAbove >= roomBelow ? 'above' : 'below';

  let top = side === 'above' ? anchor.top - size.height - gap : anchor.bottom + gap;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  top = Math.max(margin, Math.min(top, maxTop));

  return { left, top, side };
}

/** A commit subject as it arrives from /api/day (the minimal shape we read). */
export interface TooltipCommit {
  subject: string;
}

/** The popover's subject summary: the top N subjects + how many remain. */
export interface TooltipSummary {
  subjects: string[];
  more: number;
}

/**
 * Summarise a day's commits for the popover (W55): the first `max` subjects
 * (trimmed, blanks dropped) plus a count of how many commits aren't shown, so
 * the view can render "+N more". `max` is clamped to at least 1. Subjects keep
 * their source order (newest-first as the day endpoint returns them).
 */
export function tooltipSummary(commits: TooltipCommit[], max = 2): TooltipSummary {
  const cap = Math.max(1, Math.floor(max) || 1);
  const cleaned = (commits ?? [])
    .map(c => (c?.subject ?? '').trim())
    .filter(s => s.length > 0);
  const subjects = cleaned.slice(0, cap);
  const more = Math.max(0, (commits?.length ?? 0) - subjects.length);
  return { subjects, more };
}

/** Truncate a subject for the popover so a long message can't blow out the box. */
export function truncateSubject(subject: string, max = 72): string {
  const s = (subject ?? '').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}
