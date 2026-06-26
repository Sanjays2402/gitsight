/**
 * Blame heatmap view (W12; windowed in W21).
 *
 * Renders a shared BlameModel as a per-line age heatmap: a heat strip
 * (newest=hot, oldest=cold), an author dot, the short sha, a compact age,
 * the line number, and the source. An author legend sits above. Mirrors
 * the extension's blameHeatmap webview in the web app's design language.
 *
 * Blame is per-file, so the view also renders a path-entry form when no
 * file is loaded. Pure colour/age maths live in blameFormat.ts (tested);
 * the slice/scroll maths in blameWindow.ts (tested); this module owns the
 * DOM.
 *
 * W21 drops the old 4000-line soft cap: above BLAME_VIRTUAL_THRESHOLD the
 * rows region mounts ONLY the visible window (+overscan) and recycles on
 * scroll, so a 50k-line file blames at 60fps with a bounded DOM. A full-
 * height spacer keeps the scrollbar honest. The path form also accepts a
 * `path:line` / `path#L42` target and jumps straight to that line.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { blameHeat, type BlameModel, type BlameLineInfo } from '@shared/blame';
import { heatColor, authorDot, relativeAgeFromUnix, blameSummary } from './blameFormat';
import {
  shouldVirtualizeBlame,
  blameWindow,
  blameContentHeight,
  revealBlameLine,
  windowChanged,
  BLAME_ROW_H,
  type WindowRange,
} from './blameWindow';

export interface BlameViewOptions {
  /** Current file path, if one is loaded. */
  path?: string;
  /** Fired when the user submits a path to blame. */
  onLoad: (path: string) => void;
  /** 1-based line to reveal once the heatmap is rendered (W21 jump-to-line). */
  revealLine?: number | null;
}

/** Render the blame surface (form + heatmap) into a detached node. */
export function renderBlame(model: BlameModel | null, opts: BlameViewOptions): HTMLElement {
  const wrap = el('div', 'blame');

  // Path entry form — always present so the user can switch files.
  wrap.appendChild(buildForm(opts));

  if (!model) {
    const hint = el('div', 'blame-hint');
    hint.innerHTML =
      `<span class="glyph">${icons.blame}</span>` +
      `<p>Enter a file path to see its line-by-line age heatmap. ` +
      `Append <code>:42</code> or <code>#L42</code> to jump to a line.</p>`;
    wrap.appendChild(hint);
    return wrap;
  }

  if (model.totalLines === 0) {
    const hint = el('div', 'blame-hint');
    hint.innerHTML = `<p>No blame data for <code>${escapeHtml(opts.path ?? '')}</code>.</p>`;
    wrap.appendChild(hint);
    return wrap;
  }

  // Author legend.
  const legend = el('div', 'blame-legend');
  const summary = el('span', 'blame-summary');
  summary.textContent = blameSummary(model.totalLines, model.authors.length);
  legend.appendChild(summary);
  for (const a of model.authors.slice(0, 10)) {
    const item = el('span', 'blame-legend-item');
    const pct = Math.round(a.share * 100);
    item.innerHTML =
      `<span class="dot" style="background:${authorDot(a.author)}"></span>` +
      `<span class="who">${escapeHtml(a.author)}</span>` +
      `<span class="n">${a.lines} (${pct}%)</span>`;
    legend.appendChild(item);
  }
  wrap.appendChild(legend);

  // Rows: windowed for big files, plain for small ones.
  const rows = el('div', 'blame-rows');
  wrap.appendChild(rows);
  if (shouldVirtualizeBlame(model.lines.length)) {
    new BlameWindowController(rows, model, opts.revealLine ?? null);
  } else {
    renderAllRows(rows, model, opts.revealLine ?? null);
  }

  return wrap;
}

/** Build one blame row element for a line. */
function blameRow(line: BlameLineInfo, model: BlameModel, positioned: boolean, index: number): HTMLElement {
  const heat = blameHeat(line.authorTime, model.oldest, model.newest);
  const row = el('div', 'blame-row');
  row.dataset.line = String(line.line);
  if (positioned) row.style.top = `${index * BLAME_ROW_H}px`;
  row.title = `${line.author} \u00b7 ${line.summary}`;
  row.innerHTML =
    `<span class="blame-heat" style="background:${heatColor(heat)}"></span>` +
    `<span class="blame-dot" style="background:${authorDot(line.author)}" title="${escapeHtml(line.author)}"></span>` +
    `<span class="blame-sha">${escapeHtml(line.shortSha)}</span>` +
    `<span class="blame-author">${escapeHtml(line.author)}</span>` +
    `<span class="blame-age">${escapeHtml(relativeAgeFromUnix(line.authorTime))}</span>` +
    `<span class="blame-ln">${line.line}</span>` +
    `<span class="blame-src">${escapeHtml(line.code) || '&nbsp;'}</span>`;
  return row;
}

/** Small-file path: mount every row, then optionally scroll to a line. */
function renderAllRows(rows: HTMLElement, model: BlameModel, revealLine: number | null): void {
  const frag = document.createDocumentFragment();
  model.lines.forEach((line, i) => frag.appendChild(blameRow(line, model, false, i)));
  rows.appendChild(frag);
  if (revealLine) {
    // Defer until the node is in the DOM with a measurable scroll height.
    requestAnimationFrame(() => {
      const target = rows.querySelector<HTMLElement>(`.blame-row[data-line="${revealLine}"]`);
      target?.scrollIntoView({ block: 'center' });
      flashLine(rows, revealLine);
    });
  }
}

/**
 * Windowed blame renderer for huge files (W21). Mirrors the graph's W16
 * GraphController: a full-height spacer reserves the scrollbar geometry,
 * mounted rows are absolutely positioned at their index offset, and the
 * visible window (+overscan) is re-mounted on scroll.
 */
class BlameWindowController {
  private readonly rows: HTMLElement;
  private readonly model: BlameModel;
  private win: WindowRange = { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  private pendingReveal: number | null;

  constructor(rows: HTMLElement, model: BlameModel, revealLine: number | null) {
    this.rows = rows;
    this.model = model;
    this.pendingReveal = revealLine;
    this.rows.classList.add('virtual');
    this.rows.style.height = `${blameContentHeight(model.lines.length)}px`;
    this.rows.addEventListener('scroll', () => this.renderWindow(false), { passive: true });
    // Wait for layout so clientHeight is real, then paint (and jump).
    requestAnimationFrame(() => {
      if (this.pendingReveal) {
        this.rows.scrollTop = revealBlameLine(
          this.pendingReveal,
          this.rows.scrollTop,
          this.rows.clientHeight,
          this.model.lines.length,
        );
      }
      this.renderWindow(true);
      if (this.pendingReveal) {
        flashLine(this.rows, this.pendingReveal);
        this.pendingReveal = null;
      }
    });
  }

  private renderWindow(force: boolean): void {
    const next = blameWindow(this.rows.scrollTop, this.rows.clientHeight, this.model.lines.length);
    if (!force && !windowChanged(this.win, next)) {
      this.win = next;
      return;
    }
    this.win = next;
    const frag = document.createDocumentFragment();
    for (let i = next.start; i < next.end; i++) {
      frag.appendChild(blameRow(this.model.lines[i], this.model, true, i));
    }
    this.rows.replaceChildren(frag);
  }
}

/** Briefly highlight a jumped-to line so the eye lands on it. */
function flashLine(rows: HTMLElement, line: number): void {
  const target = rows.querySelector<HTMLElement>(`.blame-row[data-line="${line}"]`);
  if (!target) return;
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1400);
}

function buildForm(opts: BlameViewOptions): HTMLElement {
  const form = el('form', 'blame-form');
  const input = el('input', 'blame-path');
  input.type = 'text';
  input.placeholder = 'path/to/file.ts  (or path/to/file.ts:42)';
  input.value = opts.path ?? '';
  input.setAttribute('aria-label', 'File path to blame');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');

  const btn = el('button', 'btn');
  btn.type = 'submit';
  btn.innerHTML = `${icons.blame}<span>Blame</span>`;

  form.append(input, btn);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const value = input.value.trim();
    if (value) opts.onLoad(value);
  });
  return form;
}
