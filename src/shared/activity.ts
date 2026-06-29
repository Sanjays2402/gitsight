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

/** Whole-day distance b - a between two day keys (negative if b precedes a). */
function dayDiff(a: string, b: string): number {
  return Math.round((dayDate(b).getTime() - dayDate(a).getTime()) / MS_PER_DAY);
}

/** A commit-activity streak summary (W33). */
export interface ActivityStreak {
  /** Longest run of consecutive active calendar days (0 when none). */
  longest: number;
  /** First/last day (YYYY-MM-DD) of the longest run, or null when none. */
  longestStart: string | null;
  longestEnd: string | null;
  /**
   * Run of consecutive active days ending on the most recent active day
   * (0 when none). This is the "current" streak even if it has lapsed.
   */
  current: number;
  /** First day of the current run, or null when none. */
  currentStart: string | null;
  /** The most recent active day overall, or null. */
  lastActive: string | null;
  /**
   * True when the current run is still alive relative to `now` — i.e. the
   * last active day is today or within `graceDays` of it. A lapsed streak
   * (last commit several days ago) reports `live: false`.
   */
  live: boolean;
}

export interface StreakOptions {
  /** "Now" reference in ms (injectable for tests). Default Date.now(). */
  now?: number;
  /**
   * How many days the last active day may trail `now` and still count as a
   * live streak. Default 1 (today or yesterday), which also absorbs most
   * author-local vs UTC midnight edge cases.
   */
  graceDays?: number;
}

/**
 * Compute current + longest commit streaks from a set of active day keys
 * (W33). Pure + order-independent: dedupes + sorts the input, then walks it
 * counting runs of consecutive calendar days. A "run" is a maximal sequence
 * where each day is exactly one day after the previous.
 *
 * The CURRENT streak is the run ending on the most recent active day; it is
 * flagged `live` when that day is within `graceDays` of `now` (so a streak
 * that lapsed days ago still reports its length but `live: false`).
 *
 * `now` is compared in UTC (matching the UTC-midnight day maths the
 * calendar uses); the 1-day default grace absorbs timezone skew at the day
 * boundary, so the readout doesn't flicker around local midnight.
 */
export function buildStreaks(days: string[], opts: StreakOptions = {}): ActivityStreak {
  const now = opts.now ?? Date.now();
  const grace = Math.max(0, Math.floor(opts.graceDays ?? 1));

  const keys = [...new Set(days.filter(isDayKey))].sort();
  if (keys.length === 0) {
    return {
      longest: 0,
      longestStart: null,
      longestEnd: null,
      current: 0,
      currentStart: null,
      lastActive: null,
      live: false,
    };
  }

  let longest = 0;
  let longestStart: string | null = null;
  let longestEnd: string | null = null;

  let runStart = keys[0];
  let runLen = 1;
  const commit = (start: string, end: string, len: number): void => {
    if (len > longest) {
      longest = len;
      longestStart = start;
      longestEnd = end;
    }
  };

  for (let i = 1; i < keys.length; i++) {
    if (dayDiff(keys[i - 1], keys[i]) === 1) {
      runLen++;
    } else {
      commit(runStart, keys[i - 1], runLen);
      runStart = keys[i];
      runLen = 1;
    }
  }
  const lastActive = keys[keys.length - 1];
  commit(runStart, lastActive, runLen);

  // The current run is the final run (it ends on lastActive).
  const current = runLen;
  const currentStart = runStart;
  const nowKey = new Date(now).toISOString().slice(0, 10);
  const gap = dayDiff(lastActive, nowKey);
  const live = gap >= 0 && gap <= grace;

  return { longest, longestStart, longestEnd, current, currentStart, lastActive, live };
}

/** Extract the active (count > 0, non-filler) day keys from a calendar. */
export function activeDaysOf(cal: ActivityCalendar): string[] {
  const out: string[] = [];
  for (const week of cal.weeks) {
    for (const day of week) {
      if (!day.filler && day.count > 0) out.push(day.date);
    }
  }
  return out;
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
  const counts = new Map<string, number>();
  for (const c of commits) {
    const key = dayKey(c.date);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return buildActivityCalendarFromCounts(counts, opts);
}

/**
 * The shared calendar-assembly core (W39): turn a per-day VALUE map into the
 * week×weekday grid. `buildActivityCalendar` feeds it commit counts; the
 * churn calendar feeds it summed insertions+deletions. The value drives the
 * cell count, the 0..4 intensity bucket, the totals, and the active-day
 * tally identically for either metric.
 */
export function buildActivityCalendarFromCounts(
  counts: Map<string, number>,
  opts: CalendarOptions = {},
): ActivityCalendar {
  const maxWeeks = Math.max(1, Math.floor(opts.maxWeeks ?? 53));

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

const RECORD = '\x1e';

/** The git pretty-format the companion uses for the churn calendar read:
 *  a RECORD separator (\x1e) then the author date (%aI), then --numstat rows. */
export const CHURN_LOG_FORMAT = '%x1e%aI';

/**
 * Fold `git log --pretty=CHURN_LOG_FORMAT --numstat` output into per-day
 * churn (W39). Each \x1e-delimited record begins with the commit's author
 * date (%aI); the numstat rows that follow contribute insertions+deletions
 * to that author-local day. Binary rows (`-\t-`) contribute 0. Days with no
 * textual churn are omitted so the calendar's active-day set matches the
 * days that actually changed code.
 */
export function parseChurnByDay(stdout: string): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const record of stdout.split(RECORD)) {
    const lines = record.split('\n').map(l => l.replace(/\r$/, ''));
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) continue;
    const key = dayKey(lines[i].trim());
    if (!key) continue;
    let churn = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(lines[j]);
      if (!m) continue;
      const ins = m[1] === '-' ? 0 : parseInt(m[1], 10);
      const del = m[2] === '-' ? 0 : parseInt(m[2], 10);
      churn += ins + del;
    }
    if (churn > 0) byDay.set(key, (byDay.get(key) ?? 0) + churn);
  }
  return byDay;
}

/** Build the churn contribution calendar (W39) from a numstat log. */
export function buildChurnCalendar(stdout: string, opts: CalendarOptions = {}): ActivityCalendar {
  return buildActivityCalendarFromCounts(parseChurnByDay(stdout), opts);
}

// ── Metric switching (W88) ───────────────────────────────────────────

/** Which quantity the activity calendar's cells count (W39/W88). */
export type ActivityMetric = 'commits' | 'churn';

/** True when a value is a valid activity metric (guards a deep-link param). */
export function isActivityMetric(v: unknown): v is ActivityMetric {
  return v === 'commits' || v === 'churn';
}

/**
 * Flip the activity metric between commits and churn (W88). A degenerate or
 * unknown current value normalises to 'commits' so a first toggle lands on
 * 'churn' deterministically — this is the single source of truth the keyboard
 * shortcut, the on-screen toggle, and any future caller share, so every path
 * agrees on what "the other metric" is.
 */
export function toggleActivityMetric(current: unknown): ActivityMetric {
  return current === 'churn' ? 'commits' : 'churn';
}

/** One Cmd-K entry that flips the activity metric (W124, data only). */
export interface ActivityMetricPaletteItem {
  /** The metric this entry switches to (the OTHER metric). */
  metric: ActivityMetric;
  /** "Activity: chart churn (lines changed)" / "Activity: chart commits". */
  label: string;
  /**
   * A short readout of the metric being switched FROM (W130) — e.g. "now
   * charting commits" — so the single flip entry tells the user what it's
   * leaving, not just where it lands. Always set (the metric is always known).
   */
  hint: string;
}

/**
 * A short "what's charted now" hint for the activity metric (W130). The W124
 * palette offers a single flip entry, which says where it lands but not what
 * it's switching from; this names the CURRENT metric ("now charting commits" /
 * "now charting churn") so the user reads the before as well as the after. A
 * degenerate/unknown current normalises to commits (matching toggleActivityMetric
 * so the hint + the flip agree). Pure so the wording is testable.
 */
export function activityMetricHint(current: unknown): string {
  // The current metric is the OTHER side of the toggle (toggle flips it), so a
  // current of churn toggles to commits — meaning we're "now charting churn".
  const now: ActivityMetric = toggleActivityMetric(current) === 'commits' ? 'churn' : 'commits';
  return now === 'churn' ? 'now charting churn' : 'now charting commits';
}

/**
 * Build the command-palette source for the activity metric (W124), so the
 * W39 segmented control / W88 keyboard toggle is reachable from Cmd-K too.
 * Mirrors the W119 rail-sort source: a single entry that flips to the OTHER
 * metric (charting churn when on commits, commits when on churn) — there's only
 * ever one useful action, so the palette stays uncluttered. Pure + data only
 * (the view maps the entry to a real PaletteItem with its run). Reuses
 * toggleActivityMetric so the palette agrees with the keyboard on "the other
 * metric" even for a degenerate current value.
 *
 * W130: each entry carries a `hint` naming the CURRENT metric ("now charting
 * commits") so the palette reads what it's switching FROM, not just the label's
 * destination.
 */
export function activityMetricPaletteItems(current: unknown): ActivityMetricPaletteItem[] {
  const next = toggleActivityMetric(current);
  const label =
    next === 'churn' ? 'Activity: chart churn (lines changed)' : 'Activity: chart commits';
  return [{ metric: next, label, hint: activityMetricHint(current) }];
}

// ── Year scoping (W43) ───────────────────────────────────────────────

/**
 * The whole-week column count a single calendar year can span once padded
 * to Sunday..Saturday: at most 366 + 6 + 6 = 378 days = 54 columns. Using
 * this as the year view's `maxWeeks` means a year grid is never trimmed.
 */
export const YEAR_MAX_WEEKS = 54;

/** Extract the 4-digit calendar year from an ISO date, or null when unparseable. */
export function commitYear(iso: string): number | null {
  const key = dayKey(iso);
  return key ? Number(key.slice(0, 4)) : null;
}

/**
 * True for a plausible 4-digit calendar year. Guards a `year` query param
 * before it reaches the git read so a junk value degrades to the default
 * (rolling) calendar rather than scoping to nonsense.
 */
export function isCalendarYear(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1970 && v <= 9999;
}

/**
 * The distinct calendar years present across a set of ISO author dates,
 * newest-first. Drives the year picker's option list (W43); derived from
 * the UNFILTERED history so every year stays reachable while one is scoped.
 */
export function calendarYears(dates: string[]): number[] {
  const set = new Set<number>();
  for (const d of dates) {
    const y = commitYear(d);
    if (y !== null) set.add(y);
  }
  return [...set].sort((a, b) => b - a);
}

/** Inclusive day bounds (`YYYY-01-01` .. `YYYY-12-31`) for a calendar year. */
export function yearBounds(year: number): { since: string; until: string } {
  const y = String(year).padStart(4, '0');
  return { since: `${y}-01-01`, until: `${y}-12-31` };
}

/** True when an ISO author date falls within the given calendar year. */
export function inCalendarYear(iso: string, year: number): boolean {
  return commitYear(iso) === year;
}

/**
 * Filter a per-day count map (commit counts or churn) to a single calendar
 * year (W43). Keys are `YYYY-MM-DD`, so a cheap prefix compare scopes the
 * churn calendar by author-local year without a second git read.
 */
export function filterCountsByYear(counts: Map<string, number>, year: number): Map<string, number> {
  const prefix = `${String(year).padStart(4, '0')}-`;
  const out = new Map<string, number>();
  for (const [key, value] of counts) {
    if (key.startsWith(prefix)) out.set(key, value);
  }
  return out;
}

/**
 * Resolve which year to navigate to from the picker's prev/next arrows
 * (W43). `years` is the newest-first option list; `current` is the active
 * year (or null for the rolling \"recent\" view); `delta` is +1 (newer) or
 * -1 (older). From the rolling view, going older lands on the newest year;
 * going newer is a no-op (you're already at the most recent window).
 * Returns the target year, or null to mean the rolling view. Clamped to the
 * available list so navigation never lands on a year with no data.
 */
export function adjacentYear(years: number[], current: number | null, delta: number): number | null {
  if (years.length === 0) return null;
  if (current === null) {
    // Rolling view: older -> the most recent concrete year; newer -> stay.
    return delta < 0 ? years[0] : null;
  }
  const idx = years.indexOf(current);
  if (idx === -1) return delta < 0 ? years[0] : null;
  // `years` is newest-first, so a NEWER year is a LOWER index.
  const nextIdx = delta > 0 ? idx - 1 : idx + 1;
  if (nextIdx < 0) return null; // past the newest concrete year -> rolling
  if (nextIdx >= years.length) return current; // already the oldest
  return years[nextIdx];
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
