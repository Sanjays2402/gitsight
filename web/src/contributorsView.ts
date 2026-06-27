/**
 * Contributors leaderboard view (W14).
 *
 * Renders the shared ContributorStats as a ranked list: each row shows
 * the author, their commit count, a share bar, percentage, and the span
 * of their activity. The author colour (same hash as the graph) is the
 * only colour; everything else is monochrome chrome.
 *
 * Data prep is the shared `buildContributors` (unit-tested); this module
 * owns the DOM only.
 */

import { el } from './format';
import { timeAgo } from './format';
import { escapeHtml } from '@shared/graphCore';
import { authorColor } from '@shared/graphPalette';
import {
  sharePercent,
  contributorChurn,
  churnShare,
  maxContributorChurn,
  type ContributorStats,
  type Contributor,
  type ContributorSort,
} from '@shared/contributors';

export interface ContributorsViewOptions {
  /** Fired when a row is clicked (drives an author: filter). */
  onPick?: (c: Contributor) => void;
  /** Fired when a row's compare toggle is clicked (W35 selection). */
  onCompareToggle?: (c: Contributor) => void;
  /** Emails currently selected for comparison (W35), to mark rows. */
  selectedForCompare?: string[];
  /** Active sort key for the leaderboard (W60). Default 'commits'. */
  sort?: ContributorSort;
  /** Fired when the user picks a sort segment (W60); host re-sorts + re-renders. */
  onSort?: (sort: ContributorSort) => void;
}

/** The sort segments shown in the leaderboard header (W60). */
const SORT_SEGMENTS: Array<[ContributorSort, string, string]> = [
  ['commits', 'Commits', 'Most commits first'],
  ['churn', 'Churn', 'Most lines changed first'],
  ['recent', 'Recent', 'Most recently active first'],
  ['name', 'Name', 'Alphabetical by name'],
];

/** Render the contributor leaderboard into a detached node. */
export function renderContributors(stats: ContributorStats, opts: ContributorsViewOptions = {}): HTMLElement {
  const wrap = el('div', 'contributors');

  if (stats.contributors.length === 0) {
    const empty = el('div', 'contributors-empty');
    empty.textContent = 'No contributors to rank yet.';
    wrap.appendChild(empty);
    return wrap;
  }

  const head = el('div', 'contributors-head');
  head.innerHTML =
    `<div class="activity-stat"><span class="n">${stats.totalAuthors}</span><span class="l">contributors</span></div>` +
    `<div class="activity-stat"><span class="n">${stats.totalCommits}</span><span class="l">commits</span></div>`;
  // Sort segmented control (W60): commits / churn / recent / name. Only shown
  // when the host wires onSort (i.e. the payload carries churn so churn-sort is
  // meaningful). Mirrors the activity metric toggle's chrome.
  if (opts.onSort) {
    head.appendChild(buildSortControl(opts.sort ?? 'commits', opts.onSort));
  }
  wrap.appendChild(head);

  const list = el('div', 'contributors-list');
  list.setAttribute('role', 'list');
  const topShare = stats.contributors[0].share || 1;
  // Busiest author's churn drives the W67 mini churn-bar scale. 0 when no
  // churn has been folded (older payloads), which hides the track entirely.
  const maxChurn = maxContributorChurn(stats.contributors);
  const selected = new Set((opts.selectedForCompare ?? []).map(e => e.toLowerCase()));
  const sortKey = opts.sort ?? 'commits';

  stats.contributors.forEach((c, i) => {
    const row = el('div', 'contributor-row');
    row.setAttribute('role', 'listitem');

    // The main clickable region (author filter). A nested button keeps the
    // row semantics clean so the compare toggle can live alongside it.
    const main = el(opts.onPick ? 'button' : 'div', 'contributor-main-btn');
    if (opts.onPick) {
      (main as HTMLButtonElement).type = 'button';
      main.setAttribute('aria-label', `Filter to ${escapeHtml(c.name)}`);
      main.addEventListener('click', () => opts.onPick!(c));
    }

    const rank = el('span', 'contributor-rank');
    rank.textContent = String(i + 1);

    const dot = el('span', 'contributor-dot');
    dot.style.background = authorColor(c.name);

    const info = el('div', 'contributor-main');
    const name = el('div', 'contributor-name');
    name.textContent = c.name;
    name.title = c.email;
    const span = el('div', 'contributor-span');
    span.textContent =
      c.firstDate === c.lastDate
        ? `${timeAgo(c.lastDate)}`
        : `${timeAgo(c.firstDate)} \u2192 ${timeAgo(c.lastDate)}`;
    info.append(name, span);

    // Bars: the commit-share bar (width relative to the busiest contributor),
    // and below it a thinner churn bar (W67) scaled to the busiest author's
    // churn — so lines-changed is visible without opening the compare panel.
    // The churn track is omitted when there's no churn data (maxChurn 0) so
    // older payloads degrade to the single commit bar.
    const bars = el('div', 'contributor-bars');
    const barWrap = el('div', 'contributor-bar');
    const bar = el('span', 'contributor-bar-fill');
    bar.style.width = `${Math.max(2, Math.round((c.share / topShare) * 100))}%`;
    bar.style.background = authorColor(c.name);
    barWrap.appendChild(bar);
    bars.appendChild(barWrap);

    const cChurn = contributorChurn(c);
    if (maxChurn > 0) {
      const churnWrap = el('div', 'contributor-churn-bar' + (sortKey === 'churn' ? ' active' : ''));
      churnWrap.title = `${cChurn.toLocaleString()} lines changed`;
      const churnFill = el('span', 'contributor-churn-bar-fill');
      // A real-but-tiny churn still shows a sliver; a true zero collapses.
      churnFill.style.width = cChurn > 0 ? `${Math.max(2, Math.round(churnShare(c, maxChurn) * 100))}%` : '0';
      churnFill.style.background = authorColor(c.name);
      churnWrap.appendChild(churnFill);
      bars.appendChild(churnWrap);
    }

    const count = el('div', 'contributor-count');
    // The count cell leads with commits + share; when there's churn data it
    // appends a +ins/-del readout. Sorting by churn promotes the churn line so
    // the ordering key is the prominent number (W60).
    const churn = cChurn;
    const churnHtml =
      churn > 0
        ? `<span class="contributor-churn">` +
          (c.insertions > 0 ? `<span class="add">+${c.insertions}</span>` : '') +
          (c.deletions > 0 ? `<span class="del">-${c.deletions}</span>` : '') +
          `</span>`
        : '';
    count.innerHTML =
      `<span class="commits">${c.commits}</span>` +
      `<span class="pct">${sharePercent(c)}%</span>` +
      churnHtml;
    if (sortKey === 'churn' && churn > 0) count.classList.add('by-churn');

    main.append(rank, dot, info, bars, count);
    row.appendChild(main);

    // Compare toggle (W35): mark up to two authors to set side by side.
    if (opts.onCompareToggle) {
      const isOn = selected.has((c.email || c.name).toLowerCase());
      const cmp = el('button', 'contributor-compare-toggle' + (isOn ? ' on' : ''));
      cmp.type = 'button';
      cmp.textContent = 'vs';
      cmp.title = isOn ? `Remove ${c.name} from comparison` : `Add ${c.name} to comparison`;
      cmp.setAttribute('aria-pressed', String(isOn));
      cmp.setAttribute('aria-label', `Compare ${escapeHtml(c.name)}`);
      cmp.addEventListener('click', () => opts.onCompareToggle!(c));
      row.appendChild(cmp);
    }

    list.appendChild(row);
  });

  wrap.appendChild(list);
  return wrap;
}

/**
 * Segmented sort control for the leaderboard header (W60). Commits / Churn /
 * Recent / Name; the active segment is accented, and clicking an inactive one
 * fires onSort so the host re-sorts the (client-side) list and re-renders.
 * Monochrome chrome, accent on the active segment — mirrors the activity
 * metric toggle so the two views feel consistent.
 */
function buildSortControl(active: ContributorSort, onSort: (s: ContributorSort) => void): HTMLElement {
  const bar = el('div', 'contributor-sort');
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Sort contributors');
  for (const [key, label, title] of SORT_SEGMENTS) {
    const on = key === active;
    const btn = el('button', 'contributor-sort-seg' + (on ? ' on' : ''));
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(on));
    if (!on) btn.addEventListener('click', () => onSort(key));
    bar.appendChild(btn);
  }
  return bar;
}
