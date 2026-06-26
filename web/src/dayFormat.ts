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
