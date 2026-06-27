/**
 * Contribution-calendar view (W13).
 *
 * Renders the shared ActivityCalendar as a GitHub-style heatmap grid:
 * week columns x weekday rows, month labels along the top, a weekday
 * spine on the left, and an intensity legend. Monochrome chrome with the
 * accent colour driving the 0..4 intensity ramp — no emoji, no colour
 * outside the heat cells.
 *
 * The data prep is the shared `buildActivityCalendar` (unit-tested); this
 * module owns the DOM only.
 */

import { el } from './format';
import { escapeHtml } from '@shared/graphCore';
import { buildStreaks, activeDaysOf, adjacentYear } from '@shared/activity';
import type { ActivityCalendar, ActivityDay } from '@shared/activity';

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

/** The activity metric a calendar charts (W39). */
export type ActivityMetric = 'commits' | 'churn';

export interface ActivityViewOptions {
  /** Fired when a day cell with commits is clicked (drives a since/until filter). */
  onPickDay?: (day: ActivityDay) => void;
  /** Which metric the calendar is charting (W39). Default 'commits'. */
  metric?: ActivityMetric;
  /** Fired when the user switches the metric segmented control (W39). */
  onSwitchMetric?: (metric: ActivityMetric) => void;
  /** The calendar year currently scoped, or null for the rolling window (W43). */
  year?: number | null;
  /** All years available in history, newest-first, for the picker (W43). */
  years?: number[];
  /** Fired when the user picks a year (number) or clears to rolling (null) (W43). */
  onPickYear?: (year: number | null) => void;
}

/** Render the activity calendar into a detached node. */
export function renderActivity(cal: ActivityCalendar, opts: ActivityViewOptions = {}): HTMLElement {
  const wrap = el('div', 'activity');
  const metric: ActivityMetric = opts.metric ?? 'commits';
  const isChurn = metric === 'churn';
  // Noun the cells count, used across the stats + tooltips so commits and
  // churn read naturally from the same render path.
  const unit = isChurn ? 'lines changed' : 'commits';

  // Metric segmented control (W39) + year picker (W43) sit in one controls
  // row so the toggle is discoverable even on an empty calendar.
  if (opts.onSwitchMetric || opts.onPickYear) {
    const controls = el('div', 'activity-controls');
    if (opts.onSwitchMetric) {
      controls.appendChild(buildMetricToggle(metric, opts.onSwitchMetric));
    }
    if (opts.onPickYear) {
      controls.appendChild(buildYearPicker(opts.year ?? null, opts.years ?? [], opts.onPickYear));
    }
    wrap.appendChild(controls);
  }

  if (cal.weeks.length === 0) {
    const empty = el('div', 'activity-empty');
    const yr = opts.year != null ? ` in ${opts.year}` : '';
    empty.textContent = isChurn
      ? `No code churn to chart${yr}.`
      : `No commit activity to chart${yr}.`;
    wrap.appendChild(empty);
    return wrap;
  }

  // Header: headline stats.
  const head = el('div', 'activity-head');
  head.innerHTML =
    `<div class="activity-stat"><span class="n">${cal.total.toLocaleString()}</span><span class="l">${escapeHtml(unit)}</span></div>` +
    `<div class="activity-stat"><span class="n">${cal.activeDays}</span><span class="l">active days</span></div>` +
    `<div class="activity-stat"><span class="n">${cal.max.toLocaleString()}</span><span class="l">${isChurn ? 'busiest day (lines)' : 'busiest day'}</span></div>`;

  // Streak readout (W33): current + longest runs of consecutive active days.
  // Streaks are a commits story ("days I committed in a row"), so they only
  // show on the commits metric — churn days don't carry the same meaning.
  const streak = metric === 'commits' ? buildStreaks(activeDaysOf(cal)) : null;
  if (streak && streak.longest > 0) {
    const curClass = streak.live ? 'activity-stat streak live' : 'activity-stat streak';
    const curTitle = streak.live
      ? `Current streak: ${dayLabel(streak.currentStart, streak.lastActive)}`
      : streak.lastActive
        ? `Last active ${escapeHtml(streak.lastActive)} — streak lapsed`
        : '';
    head.insertAdjacentHTML(
      'beforeend',
      `<div class="${curClass}" title="${curTitle}">` +
        `<span class="n">${streak.current}${streak.live ? '' : '<span class="streak-dot" aria-hidden="true"></span>'}</span>` +
        `<span class="l">current streak</span></div>` +
        `<div class="activity-stat streak" title="Longest streak: ${dayLabel(streak.longestStart, streak.longestEnd)}">` +
        `<span class="n">${streak.longest}</span><span class="l">longest streak</span></div>`,
    );
  }

  if (cal.first && cal.last) {
    const span = el('div', 'activity-range');
    span.textContent = `${cal.first} \u2192 ${cal.last}`;
    head.appendChild(span);
  }
  wrap.appendChild(head);

  // The grid: a months row, then a body with the weekday spine + cells.
  const grid = el('div', 'activity-grid');

  // Month labels aligned to their week columns.
  const monthsRow = el('div', 'activity-months');
  // Spacer above the weekday spine.
  monthsRow.appendChild(el('span', 'activity-spine-cell'));
  const monthTrack = el('div', 'activity-month-track');
  for (const m of cal.months) {
    const label = el('span', 'activity-month');
    label.textContent = m.label;
    // Position by column index; each column is 1 cell (13px) + gap.
    label.style.gridColumnStart = String(m.weekIndex + 1);
    monthTrack.appendChild(label);
  }
  monthTrack.style.gridTemplateColumns = `repeat(${cal.weeks.length}, var(--cell))`;
  monthsRow.appendChild(monthTrack);
  grid.appendChild(monthsRow);

  // Body: weekday spine + the week columns.
  const body = el('div', 'activity-body');

  const spine = el('div', 'activity-spine');
  for (const label of WEEKDAY_LABELS) {
    const cell = el('span', 'activity-weekday');
    cell.textContent = label;
    spine.appendChild(cell);
  }
  body.appendChild(spine);

  const cells = el('div', 'activity-cells');
  cells.style.gridTemplateColumns = `repeat(${cal.weeks.length}, var(--cell))`;
  for (const week of cal.weeks) {
    for (const day of week) {
      const cell = el('span', `activity-cell lvl-${day.level}` + (day.filler ? ' filler' : ''));
      if (!day.filler) {
        const label = isChurn
          ? `${day.count.toLocaleString()} ${day.count === 1 ? 'line' : 'lines'} changed`
          : day.count === 1
            ? '1 commit'
            : `${day.count} commits`;
        cell.title = `${day.date} \u00b7 ${label}`;
        if (day.count > 0 && opts.onPickDay) {
          cell.setAttribute('role', 'button');
          cell.tabIndex = 0;
          cell.addEventListener('click', () => opts.onPickDay!(day));
          cell.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              opts.onPickDay!(day);
            }
          });
        }
      }
      cells.appendChild(cell);
    }
  }
  body.appendChild(cells);
  grid.appendChild(body);
  wrap.appendChild(grid);

  // Legend.
  const legend = el('div', 'activity-legend');
  legend.innerHTML =
    `<span>Less</span>` +
    [0, 1, 2, 3, 4].map(l => `<span class="activity-cell lvl-${l}"></span>`).join('') +
    `<span>More</span>`;
  wrap.appendChild(legend);

  return wrap;
}

/** Helper: the since/until filter a day click should produce. */
export function dayFilter(day: ActivityDay): string {
  return `since:${escapeHtml(day.date)} until:${escapeHtml(day.date)}`;
}

/**
 * Segmented control to switch the calendar metric (W39): Commits | Churn.
 * Monochrome chrome, accent on the active segment; clicking the inactive
 * one fires onSwitchMetric so the host re-fetches.
 */
function buildMetricToggle(active: ActivityMetric, onSwitch: (m: ActivityMetric) => void): HTMLElement {
  const bar = el('div', 'activity-metric');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Activity metric');
  const segs: Array<[ActivityMetric, string, string]> = [
    ['commits', 'Commits', 'Count commits per day'],
    ['churn', 'Churn', 'Count lines changed (insertions + deletions) per day'],
  ];
  for (const [metric, label, title] of segs) {
    const on = metric === active;
    const btn = el('button', 'activity-metric-seg' + (on ? ' on' : ''));
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(on));
    if (!on) btn.addEventListener('click', () => onSwitch(metric));
    bar.appendChild(btn);
  }
  return bar;
}

/** Tooltip label for a streak span: "Jun 01 -> Jun 11" or a single day. */
function dayLabel(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  return start === end ? escapeHtml(start) : `${escapeHtml(start)} \u2192 ${escapeHtml(end)}`;
}

/**
 * Year picker (W43): prev/next arrows flanking a select that scopes the
 * calendar to one calendar year, plus a "Recent" option (null) for the
 * rolling window. Older steps back in time, newer forward; the arrows are
 * disabled at the ends. Monochrome chrome, no emoji.
 */
function buildYearPicker(
  current: number | null,
  years: number[],
  onPick: (year: number | null) => void,
): HTMLElement {
  const wrap = el('div', 'activity-year');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Calendar year');

  // Older = step back in time. years is newest-first, so "older" moves to a
  // later index; from Recent it lands on the newest concrete year.
  const older = adjacentYear(years, current, -1);
  const newer = adjacentYear(years, current, 1);

  const prev = el('button', 'activity-year-arrow');
  prev.type = 'button';
  prev.innerHTML = '\u2039';
  prev.title = 'Older year';
  prev.setAttribute('aria-label', 'Older year');
  // Disable when stepping older wouldn't move (already oldest).
  prev.disabled = older === current;
  if (!prev.disabled) prev.addEventListener('click', () => onPick(older));

  const select = el('select', 'activity-year-select') as HTMLSelectElement;
  select.setAttribute('aria-label', 'Select calendar year');
  const recent = el('option', '', 'Recent') as HTMLOptionElement;
  recent.value = '';
  recent.selected = current === null;
  select.appendChild(recent);
  for (const y of years) {
    const opt = el('option', '', String(y)) as HTMLOptionElement;
    opt.value = String(y);
    opt.selected = current === y;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const v = select.value;
    onPick(v === '' ? null : Number(v));
  });

  const next = el('button', 'activity-year-arrow');
  next.type = 'button';
  next.innerHTML = '\u203a';
  next.title = 'Newer year';
  next.setAttribute('aria-label', 'Newer year');
  // Disable when already at the rolling (newest) view.
  next.disabled = current === null || newer === current;
  if (!next.disabled) next.addEventListener('click', () => onPick(newer));

  wrap.append(prev, select, next);
  return wrap;
}
