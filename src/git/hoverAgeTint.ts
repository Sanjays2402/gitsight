/**
 * Pure helpers for the Blame Hover Author-Age Tint (F46).
 *
 * The blame hover already shows the author and a `timeAgo()` string, but
 * users glance at the hover and miss the temporal dimension — a commit
 * from yesterday and a commit from six years ago look identical when both
 * say "Sanjay Subramanian". This module classifies a commit timestamp
 * into an age bucket and returns a colour swatch the hover renderer can
 * inline as `<span style="color:#…">name</span>` (MarkdownString with
 * supportHtml). Tints follow the project's existing branch-age palette
 * so users get visual consistency across the extension.
 *
 *   fresh   (< agingDays)         — green   #22c55e
 *   aging   (< staleDays)         — yellow  #eab308
 *   stale   (< ancientDays)       — orange  #f97316
 *   ancient (>= ancientDays)      — red     #ef4444
 *
 * Tints are also exposed as `vscode.ThemeColor`-style ids so a future
 * hover renderer that gains `appendColored()` can swap them in.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/hoverAgeTint.test.ts.
 */

export type HoverAgeBucket = 'fresh' | 'aging' | 'stale' | 'ancient';

export interface HoverAgeThresholds {
  /** Past this many days, the commit is at least "aging". */
  agingDays: number;
  /** Past this, "stale". */
  staleDays: number;
  /** Past this, "ancient". */
  ancientDays: number;
}

export const DEFAULT_HOVER_AGE_THRESHOLDS: HoverAgeThresholds = {
  agingDays: 30,
  staleDays: 180,
  ancientDays: 720, // ~2 years; anything older is "ancient" red
};

/**
 * Classify a commit date relative to a reference `now`. A commit dated in
 * the future is treated as `fresh` (clock skew shouldn't surprise the
 * user with a scary red tint). Missing/invalid date → `ancient` so the
 * pathological case is at least visually obvious.
 */
export function classifyHoverAge(
  date: Date | undefined,
  now: Date,
  t: HoverAgeThresholds = DEFAULT_HOVER_AGE_THRESHOLDS,
): HoverAgeBucket {
  if (!date || Number.isNaN(date.getTime())) return 'ancient';
  const ms = now.getTime() - date.getTime();
  if (ms <= 0) return 'fresh';
  const days = ms / 86_400_000;
  if (days >= t.ancientDays) return 'ancient';
  if (days >= t.staleDays) return 'stale';
  if (days >= t.agingDays) return 'aging';
  return 'fresh';
}

/**
 * The hex tint to inline into a MarkdownString span. Returned even for
 * `fresh` so callers can opt into colouring every line if they want; the
 * default config skips fresh to keep the hover from looking like a
 * Christmas tree on a healthy repo.
 */
export function hoverTintColor(bucket: HoverAgeBucket): string {
  switch (bucket) {
    case 'fresh':   return '#22c55e';
    case 'aging':   return '#eab308';
    case 'stale':   return '#f97316';
    case 'ancient': return '#ef4444';
  }
}

/**
 * Short human label e.g. "stale · 200d ago" — used by the hover tooltip
 * to make the bucket explicit without forcing the user to learn the
 * colour code.
 */
export function hoverAgeLabel(bucket: HoverAgeBucket, date: Date | undefined, now: Date): string {
  if (!date || Number.isNaN(date.getTime())) return 'ancient';
  const days = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
  return `${bucket} · ${days}d`;
}

/**
 * Sanitise a user-displayed string for inlining inside a `style="color: …"`
 * span. Markdown `<span>` is the only HTML element vscode's MarkdownString
 * supports when `supportHtml = true`, and a stray `</span>` from a malicious
 * commit author shouldn't be able to break out of the styling context.
 */
export function escapeForHtmlSpan(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a single coloured span for use inside a MarkdownString with
 * supportHtml=true. The bucket→colour mapping is fixed; callers wanting
 * different tints should hex-override at the call site rather than fork
 * this helper.
 *
 *   tintSpan('aging', 'Sanjay') → '<span style="color:#eab308">Sanjay</span>'
 */
export function tintSpan(bucket: HoverAgeBucket, text: string): string {
  const colour = hoverTintColor(bucket);
  const safe = escapeForHtmlSpan(text);
  return `<span style="color:${colour}">${safe}</span>`;
}

/** Resolve the configured thresholds, clamping any silly values. */
export function resolveThresholds(args: {
  agingDays?: number;
  staleDays?: number;
  ancientDays?: number;
}): HoverAgeThresholds {
  const aging = clampDays(args.agingDays, DEFAULT_HOVER_AGE_THRESHOLDS.agingDays);
  let stale = clampDays(args.staleDays, DEFAULT_HOVER_AGE_THRESHOLDS.staleDays);
  let ancient = clampDays(args.ancientDays, DEFAULT_HOVER_AGE_THRESHOLDS.ancientDays);
  // Enforce monotonic increase so a misconfigured user doesn't get
  // surprising bucket flips (e.g. stale < aging would never trigger 'aging').
  if (stale <= aging) stale = aging + 1;
  if (ancient <= stale) ancient = stale + 1;
  return { agingDays: aging, staleDays: stale, ancientDays: ancient };
}

function clampDays(v: number | undefined, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(36500, Math.max(1, Math.floor(v))); // 1 day .. ~100y
}
