/**
 * GitSight shared activity-calendar logic (W13).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. Aggregates a snapshot's
 * commits into a GitHub-style contribution calendar: a grid of weeks
 * (columns) by weekday (rows), each cell carrying the commit count for
 * that day and a 0..4 intensity level. Both the web app's Activity view
 * and (potentially) the extension can render from this same data.
 *
 * Day bucketing uses the DATE PORTION of each commit's ISO author date
 * (`%aI` emits the author's local time with offset, so the first 10 chars
 * are the author-local calendar day — exactly what a contribution graph
 * wants). This keeps the function pure + timezone-stable for tests.
 *
 * No cross-file runtime import (Node type-strip compatible) — only an
 * `import type`.
 *
 * Tests: test/git/activity.test.ts
 */

import type { GraphSnapshotCommit } from './graphSnapshot';

/** One day cell in the calendar. */
export interface ActivityDay {
  /** YYYY-MM-DD (author-local). */
  date: string;
  count: number;
  /** Intensity bucket, 0 (none) .. 4 (busiest). */
  level: 0 | 1 | 2 | 3 | 4;
  /** True when this cell pads the grid outside the real commit range. */
  filler: boolean;
}

/** A month label anchored to the week column where the month starts. */
export interface ActivityMonth {
  /** Short month name, e.g. "Jun". */
  label: string;
  /** Zero-based week-column index this label sits above. */
  weekIndex: number;
}

export interface ActivityCalendar {
  /** Columns of weeks; each week is 7 days, Sunday (row 0) .. Saturday. */
  weeks: ActivityDay[][];
  /** Month labels for the week columns. */
  months: ActivityMonth[];
  /** Total commits counted (within the rendered window). */
  total: number;
  /** Busiest single day's count (>= 1 when any commits exist). */
  max: number;
  /** Number of days with at least one commit. */
  activeDays: number;
  /** First / last real day in the window (YYYY-MM-DD), or null when empty. */
  first: string | null;
  last: string | null;
}

const MS_PER_DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Extract the author-local calendar day from an ISO date string. */
export function dayKey(iso: string): string | null {
  if (typeof iso !== 'string' || iso.length < 10) return null;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** True when a YYYY-MM-DD string is a structurally valid calendar day key. */
export function isDayKey(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Filter a snapshot's commits to a single author-local day (W22 drill-down).
 * Buckets by the same `dayKey` the calendar uses, so the returned list
 * exactly matches the count shown on that calendar cell. Preserves the
 * input order (git emits newest-first).
 */
export function filterCommitsByDay<T extends Pick<GraphSnapshotCommit, 'date'>>(
  commits: T[],
  date: string,
): T[] {
  if (!isDayKey(date)) return [];
  return commits.filter(c => dayKey(c.date) === date);
}

/** A UTC-midnight Date for a YYYY-MM-DD key (used only for grid maths). */
function dayDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

/** Format a UTC Date back to a YYYY-MM-DD key. */
function keyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket a per-day count into a 0..4 intensity level relative to the
 * busiest day. Linear quartiles over [1..max] so a single commit is
 * always level 1 and the busiest day is always level 4.
 */
export function activityLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 1) return count > 0 ? 4 : 0;
  const ratio = count / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

export interface CalendarOptions {
  /** Cap the rendered window to the most recent N weeks. Default 53. */
  maxWeeks?: number;
}

/**
 * Build the contribution calendar from a snapshot's commits. The grid
 * spans from the Sunday on/before the earliest commit to the Saturday
 * on/after the latest commit, trimmed to the most recent `maxWeeks`.
 */
export function buildActivityCalendar(
  commits: Pick<GraphSnapshotCommit, 'date'>[],
  opts: CalendarOptions = {},
): ActivityCalendar {
  const maxWeeks = Math.max(1, Math.floor(opts.maxWeeks ?? 53));
  const counts = new Map<string, number>();
  for (const c of commits) {
    const key = dayKey(c.date);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return { weeks: [], months: [], total: 0, max: 0, activeDays: 0, first: null, last: null };
  }

  const keys = [...counts.keys()].sort();
  const first = keys[0];
  const last = keys[keys.length - 1];

  // Align the grid to whole weeks: start on the Sunday on/before `first`,
  // end on the Saturday on/after `last`.
  const start = dayDate(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = dayDate(last);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));

  let max = 0;
  for (const n of counts.values()) max = Math.max(max, n);

  // Walk day-by-day into week columns.
  const weeks: ActivityDay[][] = [];
  let cursor = start.getTime();
  const endTime = end.getTime();
  let week: ActivityDay[] = [];
  let total = 0;
  let activeDays = 0;
  while (cursor <= endTime) {
    const key = keyOf(new Date(cursor));
    const count = counts.get(key) ?? 0;
    const inRange = key >= first && key <= last;
    if (count > 0) {
      total += count;
      activeDays++;
    }
    week.push({
      date: key,
      count,
      level: activityLevel(count, max),
      filler: !inRange && count === 0,
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cursor += MS_PER_DAY;
  }
  if (week.length) {
    // Pad the trailing partial week so every column is 7 tall.
    while (week.length < 7) {
      const key = keyOf(new Date(cursor));
      week.push({ date: key, count: 0, level: 0, filler: true });
      cursor += MS_PER_DAY;
    }
    weeks.push(week);
  }

  // Trim to the most recent maxWeeks columns.
  const trimmed = weeks.length > maxWeeks ? weeks.slice(weeks.length - maxWeeks) : weeks;

  return {
    weeks: trimmed,
    months: monthLabels(trimmed),
    total,
    max,
    activeDays,
    first,
    last,
  };
}

/**
 * Compute month labels: a label sits above the first week column whose
 * Sunday falls in a new month (skipping a label that would collide with
 * the previous one in the first column).
 */
function monthLabels(weeks: ActivityDay[][]): ActivityMonth[] {
  const labels: ActivityMonth[] = [];
  let lastMonth = -1;
  weeks.forEach((week, i) => {
    const firstDay = week[0];
    const month = Number(firstDay.date.slice(5, 7)) - 1;
    if (month !== lastMonth) {
      // Avoid a cramped label in the very first column if it would be
      // immediately followed by another.
      labels.push({ label: MONTHS[month] ?? '', weekIndex: i });
      lastMonth = month;
    }
  });
  return labels;
}
