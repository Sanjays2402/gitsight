/**
 * Pure presentation helpers for the activity day drill-down (W22).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The day
 * panel (dayPanel.ts) owns the DOM; the date/label formatting lives here.
 *
 * Tests: web/src/dayFormat.test.mjs
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Format a YYYY-MM-DD key as a human heading, e.g.
 * "Thursday, June 25, 2026". Uses UTC arithmetic on the date portion so
 * it's timezone-stable for tests (the key is already author-local). Returns
 * the raw key unchanged if it's malformed.
 */
export function formatDayHeading(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) return date ?? '';
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (month < 0 || month > 11 || day < 1 || day > 31) return date;
  const d = new Date(Date.UTC(year, month, day));
  const weekday = WEEKDAYS[d.getUTCDay()];
  return `${weekday}, ${MONTHS[month]} ${day}, ${year}`;
}

/** "1 commit" / "N commits" — the day panel's subheading. */
export function commitCountLabel(n: number): string {
  const count = Math.max(0, Math.floor(n) || 0);
  return `${count} ${count === 1 ? 'commit' : 'commits'}`;
}

/**
 * Tally the distinct authors in a day's commit list, busiest first, for the
 * panel's author summary. Keyed by email (falling back to name) like the
 * contributors view. Returns name + count pairs.
 */
export function dayAuthorTally(
  commits: Array<{ author: string; email?: string }>,
): Array<{ name: string; count: number }> {
  const byKey = new Map<string, { name: string; count: number }>();
  for (const c of commits) {
    const key = (c.email || '').trim().toLowerCase() || c.author.trim().toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) existing.count++;
    else byKey.set(key, { name: c.author.trim() || key, count: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

/** What reconciling the day panel against a route should do (W84). */
export type DayPanelAction = 'open' | 'close' | 'none';

/**
 * Decide how to reconcile the open day panel with a deep-linked day (W84), so
 * every code path that touches the panel's URL state — Esc, the close button,
 * and back/forward — converges on the same decision instead of each re-deriving
 * it inline:
 *
 *   - A route carrying a day that differs from the open one -> 'open' (load it).
 *   - A route carrying the SAME day already open -> 'none' (no re-fetch).
 *   - A route with no day while a panel is open -> 'close'.
 *   - A route with no day and nothing open -> 'none'.
 *
 * `openDate` is the panel's currently-open day (null when closed); `routeDay`
 * is the URL's day= value (null when absent). Pure so the convergence is
 * unit-testable without the DOM.
 */
export function dayPanelAction(openDate: string | null, routeDay: string | null): DayPanelAction {
  if (routeDay) return openDate === routeDay ? 'none' : 'open';
  return openDate ? 'close' : 'none';
}
