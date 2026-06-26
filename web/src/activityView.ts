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
import { buildStreaks, activeDaysOf } from '@shared/activity';
import type { ActivityCalendar, ActivityDay } from '@shared/activity';

const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

export interface ActivityViewOptions {
  /** Fired when a day cell with commits is clicked (drives a since/until filter). */
  onPickDay?: (day: ActivityDay) => void;
}

/** Render the activity calendar into a detached node. */
export function renderActivity(cal: ActivityCalendar, opts: ActivityViewOptions = {}): HTMLElement {
  const wrap = el('div', 'activity');

  if (cal.weeks.length === 0) {
    const empty = el('div', 'activity-empty');
    empty.textContent = 'No commit activity to chart yet.';
    wrap.appendChild(empty);
    return wrap;
  }

  // Header: headline stats.
  const head = el('div', 'activity-head');
  head.innerHTML =
    `<div class="activity-stat"><span class="n">${cal.total}</span><span class="l">commits</span></div>` +
    `<div class="activity-stat"><span class="n">${cal.activeDays}</span><span class="l">active days</span></div>` +
    `<div class="activity-stat"><span class="n">${cal.max}</span><span class="l">busiest day</span></div>`;

  // Streak readout (W33): current + longest runs of consecutive active days.
  // The "current" run is dim when it has lapsed (live=false) so an unbroken
  // streak reads as the live, accented one.
  const streak = buildStreaks(activeDaysOf(cal));
  if (streak.longest > 0) {
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
        const label = day.count === 1 ? '1 commit' : `${day.count} commits`;
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

/** Tooltip label for a streak span: "Jun 01 -> Jun 11" or a single day. */
function dayLabel(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  return start === end ? escapeHtml(start) : `${escapeHtml(start)} \u2192 ${escapeHtml(end)}`;
}
