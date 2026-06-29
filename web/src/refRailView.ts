/**
 * Branch / ref filter rail (W9).
 *
 * A left sidebar listing the snapshot's branches, remotes, and tags
 * (grouped + counted), built from the shared refRail logic. Clicking a
 * ref drives the search box with a `ref:` term so the graph filters to
 * that ref — reusing W10's structured query rather than a bespoke filter.
 *
 * Pure data prep lives in @shared/refRail (unit-tested); this module owns
 * the DOM. The rail can be collapsed; its open/closed state is the
 * caller's concern (main.ts persists it).
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { buildRailSections, refQuery, type RailRef } from '@shared/refRail';
import { compareDivergence } from './compareFormat';
import type { GraphSnapshot } from '@shared/graphSnapshot';

const GROUP_ICON = {
  branch: 'branch',
  remote: 'remote',
  tag: 'tag',
} as const;

export interface RefRailOptions {
  snapshot: GraphSnapshot;
  /** The active ref filter (the ref name), if any, for highlighting. */
  activeRef?: string;
  /** Fired when a ref is clicked; value is the query to apply. */
  onPick: (query: string, ref: RailRef) => void;
  /** Fired when the "all" / clear row is clicked. */
  onClear: () => void;
  /** Fired when a ref's detail caret is clicked (W29 popover) with the anchor. */
  onShowDetail?: (ref: RailRef, anchor: HTMLElement) => void;
  /** Sort refs by divergence from HEAD, most-diverged first (W110), else natural. */
  sortByDivergence?: boolean;
  /** A ref's ahead/behind vs HEAD for the W110 sort; null when level/unknown. */
  divergence?: (ref: RailRef) => { ahead: number; behind: number } | null;
  /** Toggle the W110 divergence sort (persisted by the caller). */
  onToggleSort?: () => void;
}

/** Build the rail node from a snapshot. Returns null when there are no refs. */
export function createRefRail(opts: RefRailOptions): HTMLElement | null {
  const sections = buildRailSections(opts.snapshot.commits);
  if (sections.length === 0) return null;

  const rail = el('nav', 'ref-rail');
  rail.setAttribute('aria-label', 'Filter by ref');

  // "All commits" clear row.
  const allRow = el('button', 'rail-all' + (opts.activeRef ? '' : ' active'));
  allRow.innerHTML = `<span class="rail-ico">${icons.graph}</span><span>All commits</span>`;
  allRow.addEventListener('click', () => opts.onClear());
  rail.appendChild(allRow);

  // W110: a header toggle to sort refs by how far they've diverged from HEAD
  // (most-diverged first) so the busiest branches surface — handy on a repo
  // with many refs. Off by default (natural alphabetical sections).
  if (opts.onToggleSort) {
    const on = !!opts.sortByDivergence;
    const sortBtn = el('button', 'rail-sort' + (on ? ' on' : ''));
    sortBtn.type = 'button';
    sortBtn.title = on ? 'Sorting by divergence from HEAD' : 'Sort by divergence from HEAD';
    sortBtn.setAttribute('aria-pressed', String(on));
    sortBtn.innerHTML = `<span class="rail-ico">${icons.gitCompare}</span><span>Most diverged</span>`;
    sortBtn.addEventListener('click', () => opts.onToggleSort!());
    rail.appendChild(sortBtn);
  }

  for (const section of sections) {
    const sec = el('div', 'rail-section');
    const head = el('div', 'rail-section-head');
    head.innerHTML =
      `<span>${escapeHtml(section.label)}</span><span class="rail-count">${section.refs.length}</span>`;
    sec.appendChild(head);

    // W110: optionally order this section's refs by divergence vs HEAD. The
    // pure compareDivergence ranks diverged > ahead/behind > level (W105), then
    // by total drift; a missing lookup reads as level so it sinks. Natural order
    // (the section's build order) when the toggle is off.
    let refs = section.refs;
    if (opts.sortByDivergence && opts.divergence) {
      refs = section.refs.slice().sort((a, b) =>
        compareDivergence(opts.divergence!(a) ?? { ahead: 0, behind: 0 }, opts.divergence!(b) ?? { ahead: 0, behind: 0 }),
      );
    }
    for (const ref of refs) {
      const item = el('div', 'rail-ref' + (ref.name === opts.activeRef ? ' active' : ''));
      item.title = ref.name;
      const ico = icons[GROUP_ICON[ref.group]] ?? icons.branch;
      const pick = el('button', 'rail-ref-pick');
      pick.innerHTML =
        `<span class="rail-ico">${ico}</span>` +
        `<span class="rail-name">${escapeHtml(ref.name)}</span>` +
        (ref.isHead ? `<span class="rail-head" title="HEAD">HEAD</span>` : '');
      pick.addEventListener('click', () => opts.onPick(refQuery(ref), ref));
      item.appendChild(pick);

      // Detail caret (W29): opens a popover with the ref's tip + ahead/behind.
      if (opts.onShowDetail) {
        const caret = el('button', 'rail-caret');
        caret.title = 'Ref details';
        caret.setAttribute('aria-label', `Details for ${ref.name}`);
        caret.innerHTML = icons.chevron;
        caret.addEventListener('click', e => {
          e.stopPropagation();
          opts.onShowDetail!(ref, caret);
        });
        item.appendChild(caret);
      }

      sec.appendChild(item);
    }
    rail.appendChild(sec);
  }

  return rail;
}

/**
 * Extract the active ref name from a filter string, if it is exactly a
 * single `ref:` term (so the rail can highlight the matching row). Returns
 * undefined for compound or non-ref queries.
 */
export function activeRefFromFilter(filter: string): string | undefined {
  const m = /^ref:"([^"]+)"$/.exec(filter.trim()) ?? /^ref:(\S+)$/.exec(filter.trim());
  return m ? m[1] : undefined;
}
