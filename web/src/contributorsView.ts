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
import { sharePercent, type ContributorStats, type Contributor } from '@shared/contributors';

export interface ContributorsViewOptions {
  /** Fired when a row is clicked (drives an author: filter). */
  onPick?: (c: Contributor) => void;
  /** Fired when a row's compare toggle is clicked (W35 selection). */
  onCompareToggle?: (c: Contributor) => void;
  /** Emails currently selected for comparison (W35), to mark rows. */
  selectedForCompare?: string[];
}

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
  wrap.appendChild(head);

  const list = el('div', 'contributors-list');
  list.setAttribute('role', 'list');
  const topShare = stats.contributors[0].share || 1;
  const selected = new Set((opts.selectedForCompare ?? []).map(e => e.toLowerCase()));

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

    // Share bar: width relative to the busiest contributor so the top
    // author fills the track.
    const barWrap = el('div', 'contributor-bar');
    const bar = el('span', 'contributor-bar-fill');
    bar.style.width = `${Math.max(2, Math.round((c.share / topShare) * 100))}%`;
    bar.style.background = authorColor(c.name);
    barWrap.appendChild(bar);

    const count = el('div', 'contributor-count');
    count.innerHTML =
      `<span class="commits">${c.commits}</span>` +
      `<span class="pct">${sharePercent(c)}%</span>`;

    main.append(rank, dot, info, barWrap, count);
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
