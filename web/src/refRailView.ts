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

  for (const section of sections) {
    const sec = el('div', 'rail-section');
    const head = el('div', 'rail-section-head');
    head.innerHTML =
      `<span>${escapeHtml(section.label)}</span><span class="rail-count">${section.refs.length}</span>`;
    sec.appendChild(head);

    for (const ref of section.refs) {
      const item = el('button', 'rail-ref' + (ref.name === opts.activeRef ? ' active' : ''));
      item.title = ref.name;
      const ico = icons[GROUP_ICON[ref.group]] ?? icons.branch;
      item.innerHTML =
        `<span class="rail-ico">${ico}</span>` +
        `<span class="rail-name">${escapeHtml(ref.name)}</span>` +
        (ref.isHead ? `<span class="rail-head" title="HEAD">HEAD</span>` : '');
      item.addEventListener('click', () => opts.onPick(refQuery(ref), ref));
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
