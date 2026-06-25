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

  stats.contributors.forEach((c, i) => {
    const row = el(opts.onPick ? 'button' : 'div', 'contributor-row');
    row.setAttribute('role', 'listitem');

    const rank = el('span', 'contributor-rank');
    rank.textContent = String(i + 1);

    const dot = el('span', 'contributor-dot');
    dot.style.background = authorColor(c.name);

    const main = el('div', 'contributor-main');
    const name = el('div', 'contributor-name');
    name.textContent = c.name;
    name.title = c.email;
    const span = el('div', 'contributor-span');
    span.textContent =
      c.firstDate === c.lastDate
        ? `${timeAgo(c.lastDate)}`
        : `${timeAgo(c.firstDate)} \u2192 ${timeAgo(c.lastDate)}`;
    main.append(name, span);

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

    row.append(rank, dot, main, barWrap, count);
    if (opts.onPick) {
      row.setAttribute('aria-label', `Filter to ${escapeHtml(c.name)}`);
      row.addEventListener('click', () => opts.onPick!(c));
    }
    list.appendChild(row);
  });

  wrap.appendChild(list);
  return wrap;
}

/** The author: filter a contributor click should produce. */
export function contributorFilter(c: Contributor): string {
  const value = c.email || c.name;
  return /\s/.test(value) ? `author:"${value}"` : `author:${value}`;
}
