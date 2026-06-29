/**
 * Ref-detail popover (W29).
 *
 * A small floating card anchored to a rail ref's caret, showing the ref's
 * tip commit (subject/author/age), its ahead/behind versus HEAD (computed
 * client-side from the loaded snapshot by the pure refInsight module), and
 * quick actions: filter the graph to the ref, open its tip's detail, or
 * compare the ref against HEAD. No backend round-trip — the popover reads
 * everything from the in-memory graph.
 *
 * Owns a single popover element; opening a second closes the first. Dismiss
 * on outside-click / Esc / scroll.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { timeAgo, absoluteTime } from './format';
import { authorColor } from '@shared/graphPalette';
import { buildRefInsight, type InsightCommit } from './refInsight';
import { refInsightDivergenceHint, divergenceClass } from './compareFormat';
import type { RailRef } from '@shared/refRail';

export interface RefDetailActions {
  /** Filter the graph to this ref. */
  onFilter: (ref: RailRef) => void;
  /** Open the tip commit's detail panel. */
  onOpenTip: (sha: string) => void;
  /** Compare this ref against HEAD. */
  onCompare: (ref: RailRef) => void;
}

let popover: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

/** Close any open ref-detail popover. */
export function closeRefDetail(): void {
  cleanup?.();
  popover?.remove();
  popover = null;
  cleanup = null;
}

/**
 * Open the ref-detail popover for `ref`, anchored under `anchor`. `commits`
 * is the loaded snapshot list and `headTip` HEAD's tip sha (for the
 * ahead/behind math). Replaces any open popover.
 */
export function openRefDetail(
  ref: RailRef,
  anchor: HTMLElement,
  commits: InsightCommit[],
  headTip: string,
  actions: RefDetailActions,
): void {
  closeRefDetail();

  const insight = buildRefInsight(commits, ref.tipSha, headTip);

  const pop = el('div', 'ref-detail');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', `Details for ${ref.name}`);

  // Header: ref name + group.
  const head = el('div', 'ref-detail-head');
  head.innerHTML =
    `<span class="rd-name">${escapeHtml(ref.name)}</span>` +
    `<span class="rd-group">${ref.group}${ref.isHead ? ' \u00b7 HEAD' : ''}</span>`;
  pop.appendChild(head);

  // Ahead/behind vs HEAD.
  if (!ref.isHead) {
    const ab = el('div', 'rd-aheadbehind');
    // W105: a divergence dot whose colour distinguishes a clean fast-forward
    // (ahead/behind) from a real divergence (both) at a glance. The label is
    // the W100-unified text; a "diverged" tag is appended when both sides drift.
    const cls = divergenceClass(insight);
    const diverged = cls === 'diverged';
    ab.innerHTML =
      `<span class="rd-div-dot ${cls}" aria-hidden="true"></span>` +
      `<span class="rd-ico">${icons.gitCompare}</span>` +
      `<span>${escapeHtml(refInsightDivergenceHint(insight))}${diverged ? ' \u00b7 diverged' : ''}</span>`;
    if (!insight.exact) ab.title = 'Approximate — history is capped below this ancestry.';
    pop.appendChild(ab);
  }

  // Tip commit.
  if (insight.tip) {
    const tip = insight.tip;
    const card = el('div', 'rd-tip');
    card.innerHTML =
      `<div class="rd-tip-subject">${escapeHtml(tip.subject)}</div>` +
      `<div class="rd-tip-meta">` +
      `<span class="rd-tip-author" style="color:${authorColor(tip.author)}">${escapeHtml(tip.author)}</span>` +
      `<span class="rd-tip-age" title="${escapeHtml(absoluteTime(tip.date))}">${escapeHtml(timeAgo(tip.date))}</span>` +
      `<span class="rd-tip-sha">${escapeHtml(tip.shortSha)}</span>` +
      `</div>`;
    pop.appendChild(card);
  } else {
    const miss = el('div', 'rd-tip-missing');
    miss.textContent = 'Tip commit is outside the loaded history window.';
    pop.appendChild(miss);
  }

  // Actions.
  const actionsRow = el('div', 'rd-actions');
  const filterBtn = el('button', 'rd-action');
  filterBtn.innerHTML = `<span class="rd-ico">${icons.search}</span><span>Filter graph</span>`;
  filterBtn.addEventListener('click', () => {
    closeRefDetail();
    actions.onFilter(ref);
  });
  actionsRow.appendChild(filterBtn);

  if (insight.tip) {
    const tipSha = insight.tip.sha;
    const openBtn = el('button', 'rd-action');
    openBtn.innerHTML = `<span class="rd-ico">${icons.graph}</span><span>Open tip</span>`;
    openBtn.addEventListener('click', () => {
      closeRefDetail();
      actions.onOpenTip(tipSha);
    });
    actionsRow.appendChild(openBtn);
  }

  if (!ref.isHead) {
    const cmpBtn = el('button', 'rd-action');
    cmpBtn.innerHTML = `<span class="rd-ico">${icons.gitCompare}</span><span>Compare to HEAD</span>`;
    cmpBtn.addEventListener('click', () => {
      closeRefDetail();
      actions.onCompare(ref);
    });
    actionsRow.appendChild(cmpBtn);
  }
  pop.appendChild(actionsRow);

  // Position: to the right of the anchor, clamped into the viewport.
  pop.style.visibility = 'hidden';
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  const pad = 8;
  let left = a.right + 6;
  if (left + r.width > window.innerWidth - pad) left = Math.max(pad, a.left - r.width - 6);
  let top = a.top;
  if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = 'visible';
  pop.classList.add('show');
  popover = pop;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeRefDetail();
  };
  const onOutside = (e: PointerEvent) => {
    if (popover && !popover.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
      closeRefDetail();
    }
  };
  const onScroll = () => closeRefDetail();
  setTimeout(() => {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', onScroll);
  }, 0);
  cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onScroll);
  };
}
