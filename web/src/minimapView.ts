/**
 * Graph minimap strip (W45).
 *
 * A condensed overview of the whole commit history down the right edge of
 * the graph: one thin mark per commit at its lane's x, in its lane colour,
 * plus a draggable viewport indicator. Click or drag anywhere on the strip
 * to scroll the graph to that region — fast navigation on long histories.
 *
 * Pure geometry (mark positions, viewport box, pointer -> scrollTop) lives
 * in minimap.ts (tested); this module owns the SVG + the pointer wiring +
 * keeping the indicator in sync with the scroll container. The strip is an
 * SVG drawn once; only the lightweight indicator rect moves on scroll, so it
 * stays cheap even alongside the W16 windowed row list.
 */

import { el } from './format';
import {
  buildMinimapMarks,
  minimapViewport,
  minimapSeekScrollTop,
  MINIMAP_WIDTH,
  type MinimapMark,
} from './minimap';

export interface MinimapRow {
  lane: number;
  color: string;
}

export interface MinimapOptions {
  /** Per-row lane + colour, in display order (newest first). */
  rows: MinimapRow[];
  /** The graph's scroll container (the surface). */
  scrollContainer: HTMLElement;
  /** Full scrollable content height in px (total rows * row height). */
  contentHeight: number;
  /** Lane columns the graph spans, for x packing. */
  maxLanes: number;
}

/** Fixed track height the strip is drawn in (px). Marks spread across it. */
const TRACK_HEIGHT = 600;

/**
 * Mounts a minimap strip and keeps its viewport indicator synced to the
 * container's scroll. Returns a controller with the node to mount + a
 * dispose() that drops the scroll listener (call before swapping graphs).
 */
export class GraphMinimap {
  readonly node: HTMLElement;
  private indicator: HTMLElement;
  private svg: SVGSVGElement;
  private scrollContainer: HTMLElement;
  private contentHeight: number;
  private onScroll: (() => void) | null = null;
  private dragging = false;
  private onPointerMove: ((e: PointerEvent) => void) | null = null;
  private onPointerUp: ((e: PointerEvent) => void) | null = null;

  constructor(opts: MinimapOptions) {
    this.scrollContainer = opts.scrollContainer;
    this.contentHeight = opts.contentHeight;

    this.node = el('div', 'graph-minimap');
    this.node.setAttribute('aria-hidden', 'true'); // decorative nav aid
    this.node.style.setProperty('--minimap-w', `${MINIMAP_WIDTH}px`);

    const marks = buildMinimapMarks(
      opts.rows.map(r => r.lane),
      opts.maxLanes,
      TRACK_HEIGHT,
      MINIMAP_WIDTH,
    );
    this.svg = this.buildSvg(marks, opts.rows);
    this.node.appendChild(this.svg);

    this.indicator = el('div', 'graph-minimap-viewport');
    this.node.appendChild(this.indicator);

    this.wirePointer();
    this.onScroll = () => this.syncViewport();
    this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
    // First paint after layout so clientHeight is real.
    requestAnimationFrame(() => this.syncViewport());
  }

  /** Drop listeners. Call before swapping in a fresh graph. */
  dispose(): void {
    if (this.onScroll) this.scrollContainer.removeEventListener('scroll', this.onScroll);
    this.onScroll = null;
    if (this.onPointerMove) window.removeEventListener('pointermove', this.onPointerMove);
    if (this.onPointerUp) window.removeEventListener('pointerup', this.onPointerUp);
    this.onPointerMove = null;
    this.onPointerUp = null;
  }

  /** Position + size the viewport indicator from the current scroll state. */
  private syncViewport(): void {
    const sc = this.scrollContainer;
    // The strip stretches to the viewport height (its SVG uses
    // preserveAspectRatio=none, so marks scale to fill). Size the strip, then
    // compute the indicator in that SAME real-px space so the box lines up
    // with the marks regardless of how tall the viewport is.
    const stripH = sc.clientHeight;
    this.node.style.height = `${stripH}px`;
    const v = minimapViewport(sc.scrollTop, sc.clientHeight, this.contentHeight, stripH);
    this.indicator.style.top = `${v.top}px`;
    this.indicator.style.height = `${v.height}px`;
  }

  /** Map a pointer Y on the track to a scrollTop and apply it. */
  private seek(clientY: number): void {
    const rect = this.svg.getBoundingClientRect();
    const pointerY = ((clientY - rect.top) / Math.max(1, rect.height)) * TRACK_HEIGHT;
    this.scrollContainer.scrollTop = minimapSeekScrollTop(
      pointerY,
      TRACK_HEIGHT,
      this.contentHeight,
      this.scrollContainer.clientHeight,
    );
  }

  private wirePointer(): void {
    this.node.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.dragging = true;
      this.node.classList.add('dragging');
      this.seek(e.clientY);
    });
    this.onPointerMove = (e: PointerEvent) => {
      if (this.dragging) this.seek(e.clientY);
    };
    this.onPointerUp = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.node.classList.remove('dragging');
    };
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  private buildSvg(marks: MinimapMark[], rows: MinimapRow[]): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'graph-minimap-svg');
    svg.setAttribute('viewBox', `0 0 ${MINIMAP_WIDTH} ${TRACK_HEIGHT}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('width', String(MINIMAP_WIDTH));
    svg.setAttribute('height', String(TRACK_HEIGHT));
    // One short horizontal tick per commit at its lane x, in its lane colour.
    // Thin enough that a long history reads as a soft branch-shape texture.
    const parts: string[] = [];
    for (const m of marks) {
      const color = rows[m.index]?.color ?? 'currentColor';
      const x = m.x.toFixed(1);
      const y = m.y.toFixed(1);
      parts.push(
        `<circle cx="${x}" cy="${y}" r="1.4" fill="${escapeAttr(color)}"/>`,
      );
    }
    svg.innerHTML = parts.join('');
    return svg;
  }
}

/** Escape a colour string for safe attribute interpolation. */
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
