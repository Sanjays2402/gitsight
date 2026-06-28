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
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { buildStreaks, activeDaysOf, adjacentYear } from '@shared/activity';
import type { ActivityCalendar, ActivityDay } from '@shared/activity';
import { popoverPosition, tooltipSummary, truncateSubject, isPointInAnyRect } from './activityTooltip';
import type { DayResult } from './data';

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
  /**
   * Fetch a day's commits for the hover popover (W55). When wired (and the
   * metric is commits), hovering a populated cell shows the top 1-2 commit
   * subjects. Results are debounced + cached by the controller. Omit to keep
   * the plain native-title tooltip.
   */
  peekDay?: (date: string) => Promise<DayResult>;
  /**
   * Open the full W22 day panel for a date (W75). When wired, a pinned peek
   * (W68) gains a "View full day" footer link so the preview (top 6 subjects)
   * bridges to the complete day drill-down. Omit to hide the link.
   */
  onOpenDay?: (date: string) => void;
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
  // Hover popover (W55): only on the commits metric (churn cells have no
  // commit subjects to preview) and only when the host wired a day fetcher.
  // The popover mounts inside `wrap`, so it's removed automatically when a
  // re-render replaces the calendar — no external disposal needed.
  const peek = !isChurn && opts.peekDay ? new DayPeekController(wrap, opts.peekDay, opts.onOpenDay) : null;
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
        // Rich hover popover (W55): show the day's top subjects. Suppressing
        // the native title while the popover is up avoids a double tooltip.
        // W61: the same preview surfaces on keyboard focus so it isn't
        // mouse-exclusive. focus/blur mirror enter/leave; the cell is made
        // focusable + labelled here so the preview works even if onPickDay
        // isn't wired (the W22 click path already sets these when it is).
        if (day.count > 0 && peek) {
          if (cell.tabIndex < 0) cell.tabIndex = 0;
          cell.setAttribute('aria-label', `${day.date}: ${label}`);
          cell.addEventListener('mouseenter', () => peek.enter(cell, day.date));
          cell.addEventListener('mouseleave', () => peek.leave());
          cell.addEventListener('focus', () => peek.enter(cell, day.date));
          cell.addEventListener('blur', () => peek.leave());
          // W68: `p` pins the hovered/focused peek so it stays open for
          // reading (Esc or an outside click dismisses it). The pin keeps the
          // popover up without the day panel's full slide-in.
          cell.addEventListener('keydown', e => {
            if (e.key === 'p' || e.key === 'P') {
              e.preventDefault();
              peek.pin(cell, day.date);
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

/**
 * Hover popover controller for the activity calendar (W55; pinnable W68).
 *
 * On `enter(cell, date)` it starts a short hover-intent timer; if the pointer
 * lingers, it fetches that day's commits (via the injected loader), caches the
 * result by date, and shows a small popover with the top 1-2 subjects + a
 * "+N more" count, positioned above/below the cell and clamped to the
 * viewport (pure maths in activityTooltip.ts). `leave()` cancels a pending
 * fetch and hides the popover after a brief grace so moving between adjacent
 * cells doesn't flicker. The popover element lives inside the calendar wrap,
 * so a calendar re-render disposes it automatically.
 *
 * W68 adds PINNING: `pin(cell, date)` (or the popover's pin button) keeps the
 * popover open for reading regardless of pointer movement. A pinned popover
 * becomes interactive (pointer-events on), shows a close affordance, and is
 * dismissed by Esc or a click outside both it and its anchor cell — without
 * the W22 day panel's full slide-in.
 */
class DayPeekController {
  private readonly load: (date: string) => Promise<DayResult>;
  private readonly onOpenDay: ((date: string) => void) | undefined;
  private readonly pop: HTMLElement;
  private readonly cache = new Map<string, { subjects: string[]; more: number }>();
  private enterTimer: number | null = null;
  private leaveTimer: number | null = null;
  private activeDate: string | null = null;
  // W68 pinned state: the cell + date a pinned popover is anchored to, plus
  // the window listeners that dismiss it (removed on unpin/dispose).
  private pinned = false;
  private pinnedCell: HTMLElement | null = null;
  private readonly onDocPointer: (e: MouseEvent) => void;
  private readonly onKeydown: (e: KeyboardEvent) => void;

  constructor(host: HTMLElement, load: (date: string) => Promise<DayResult>, onOpenDay?: (date: string) => void) {
    this.load = load;
    this.onOpenDay = onOpenDay;
    this.pop = el('div', 'activity-peek');
    this.pop.hidden = true;
    this.pop.setAttribute('role', 'tooltip');
    host.appendChild(this.pop);
    // Dismiss a pinned peek on an outside click or Esc. Bound once; the
    // handlers no-op while unpinned so they're cheap to leave attached.
    this.onDocPointer = e => this.handleOutsidePointer(e);
    this.onKeydown = e => {
      if (this.pinned && e.key === 'Escape') {
        e.preventDefault();
        this.unpin();
        this.pinnedCell?.focus();
      }
    };
  }

  enter(cell: HTMLElement, date: string): void {
    // A pinned popover owns the screen; ignore incidental hovers elsewhere.
    if (this.pinned) return;
    this.cancelLeave();
    this.activeDate = date;
    // Hover-intent: wait a beat so a quick sweep across the grid doesn't fetch.
    if (this.enterTimer !== null) clearTimeout(this.enterTimer);
    this.enterTimer = window.setTimeout(() => void this.show(cell, date), 140);
  }

  leave(): void {
    // While pinned, leaving the cell must NOT hide the popover.
    if (this.pinned) return;
    if (this.enterTimer !== null) {
      clearTimeout(this.enterTimer);
      this.enterTimer = null;
    }
    this.activeDate = null;
    // Grace period so moving onto an adjacent cell doesn't flash the popover.
    this.cancelLeave();
    this.leaveTimer = window.setTimeout(() => this.hide(), 80);
  }

  /** Pin the peek to a cell so it stays open for reading (W68). */
  pin(cell: HTMLElement, date: string): void {
    if (this.enterTimer !== null) {
      clearTimeout(this.enterTimer);
      this.enterTimer = null;
    }
    this.cancelLeave();
    this.activeDate = date;
    void this.show(cell, date, true);
  }

  private async show(cell: HTMLElement, date: string, asPin = false): Promise<void> {
    let summary = this.cache.get(date);
    if (!summary) {
      const res = await this.load(date);
      // Superseded by a later hover / a leave -> drop this result.
      if (this.activeDate !== date) return;
      if (!res.ok) return;
      summary = tooltipSummary(res.day.commits, asPin ? 6 : 2);
      // Cache the richer pinned summary too; a later hover re-trims from it is
      // fine since a pin shows more, a hover shows fewer of the same subjects.
      this.cache.set(date, summary);
    }
    if (this.activeDate !== date) return;
    if (summary.subjects.length === 0) return;
    if (asPin) {
      this.pinned = true;
      this.pinnedCell = cell;
    }
    this.renderInto(summary, date);
    this.position(cell);
    if (asPin) this.installPinListeners();
  }

  private renderInto(summary: { subjects: string[]; more: number }, date: string): void {
    const items = summary.subjects
      .map(s => `<span class="activity-peek-subject">${escapeHtml(truncateSubject(s))}</span>`)
      .join('');
    const more = summary.more > 0 ? `<span class="activity-peek-more">+${summary.more} more</span>` : '';
    if (this.pinned) {
      // Pinned: a header with the date + a close button, then the subjects.
      // The popover is interactive so the close button is clickable.
      this.pop.classList.add('pinned');
      // W75: when the host wired onOpenDay, a footer link opens the full W22
      // day panel — the peek is a preview (top 6), the panel is the detail.
      const footer = this.onOpenDay
        ? `<button class="activity-peek-open" type="button">View full day</button>`
        : '';
      this.pop.innerHTML =
        `<div class="activity-peek-head"><span class="activity-peek-date">${escapeHtml(date)}</span>` +
        `<button class="activity-peek-close" type="button" aria-label="Close" title="Close (Esc)">${icons.close}</button></div>` +
        items +
        more +
        footer;
      this.pop.querySelector<HTMLElement>('.activity-peek-close')?.addEventListener('click', () => {
        this.unpin();
        this.pinnedCell?.focus();
      });
      // W75: the footer link routes to the full day panel, then drops the peek.
      this.pop.querySelector<HTMLElement>('.activity-peek-open')?.addEventListener('click', () => {
        const d = date;
        this.unpin();
        this.onOpenDay?.(d);
      });
    } else {
      this.pop.classList.remove('pinned');
      // A faint hint that the peek can be pinned for reading (W68). Only shown
      // when a day cell is keyboard-focusable (the peek is reachable), so it
      // doesn't promise an action the user can't take.
      const hint = `<span class="activity-peek-hint">Press <kbd>p</kbd> to pin</span>`;
      this.pop.innerHTML = items + more + hint;
    }
    this.pop.hidden = false;
  }

  private position(cell: HTMLElement): void {
    const anchor = cell.getBoundingClientRect();
    const box = this.pop.getBoundingClientRect();
    const place = popoverPosition(
      { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom },
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    // Fixed positioning so the viewport-relative rect maths line up directly.
    this.pop.style.position = 'fixed';
    this.pop.style.left = `${Math.round(place.left)}px`;
    this.pop.style.top = `${Math.round(place.top)}px`;
    this.pop.dataset.side = place.side;
  }

  /** Wire the outside-click + Esc listeners for a freshly-pinned popover. */
  private installPinListeners(): void {
    // Defer the pointer listener so the click that pinned (if any) doesn't
    // immediately dismiss it.
    setTimeout(() => {
      if (this.pinned) document.addEventListener('mousedown', this.onDocPointer, true);
    }, 0);
    document.addEventListener('keydown', this.onKeydown, true);
  }

  /** Dismiss a pinned popover when a click lands outside it AND its anchor (W68). */
  private handleOutsidePointer(e: MouseEvent): void {
    if (!this.pinned) return;
    const popRect = this.pop.getBoundingClientRect();
    const cellRect = this.pinnedCell?.getBoundingClientRect() ?? null;
    const inside = isPointInAnyRect(
      e.clientX,
      e.clientY,
      [
        { left: popRect.left, top: popRect.top, right: popRect.right, bottom: popRect.bottom },
        cellRect ? { left: cellRect.left, top: cellRect.top, right: cellRect.right, bottom: cellRect.bottom } : null,
      ],
    );
    if (!inside) this.unpin();
  }

  /** Clear the pinned state + listeners and hide the popover (W68). */
  private unpin(): void {
    this.pinned = false;
    this.pinnedCell = null;
    this.pop.classList.remove('pinned');
    document.removeEventListener('mousedown', this.onDocPointer, true);
    document.removeEventListener('keydown', this.onKeydown, true);
    this.hide();
  }

  private hide(): void {
    this.pop.hidden = true;
  }

  private cancelLeave(): void {
    if (this.leaveTimer !== null) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
  }

  dispose(): void {
    if (this.enterTimer !== null) clearTimeout(this.enterTimer);
    this.cancelLeave();
    document.removeEventListener('mousedown', this.onDocPointer, true);
    document.removeEventListener('keydown', this.onKeydown, true);
    this.pop.remove();
  }
}
