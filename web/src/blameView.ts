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
import { buildAgeRamp, isAuthorDimmed, authorEmailFromLines } from './blameLegend';
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
  /**
   * The revision being blamed (W28). Shown as a badge when it isn't HEAD so
   * "Blame at this commit" reads clearly; omitted/`HEAD` shows no badge.
   */
  rev?: string;
  /**
   * The currently-isolated author (W40). When set, lines by other authors
   * fade so one person's contribution stands out. Null = no filter.
   */
  activeAuthor?: string | null;
  /** Fired when a legend author is clicked (W40); host toggles the filter. */
  onToggleAuthor?: (author: string) => void;
  /**
   * Fired when a legend author's "view contributor" affordance is clicked
   * (W51) with the author's name + resolved email — the host opens that
   * author's W23 detail panel. Absent = no contributor link.
   */
  onOpenAuthor?: (author: string, email: string) => void;
  /**
   * Commits to ignore when blaming (W44) — a mass reformat / rename whose
   * lines should be reattributed to their real author. Shown as a chip list.
   */
  ignoreRevs?: string[];
  /** Fired when the user adds an ignore-rev (W44). */
  onAddIgnoreRev?: (rev: string) => void;
  /** Fired when the user removes an ignore-rev chip (W44). */
  onRemoveIgnoreRev?: (rev: string) => void;
  /**
   * Fired when a blame line's number is clicked (W57) with the 1-based line.
   * The host copies a `#blame?path=&rev=&line=N` deep link so a specific
   * blamed line is shareable. Absent = the line numbers stay inert.
   */
  onCopyLine?: (line: number) => void;
  /**
   * Fired when a blame line number is SHIFT-clicked (W65) with the 1-based
   * anchor + the shift-clicked line. The host copies a `line=N-M` range
   * permalink. Requires onCopyLine to be wired too (the line numbers are only
   * interactive when single-line copy is enabled).
   */
  onCopyLineRange?: (start: number, end: number) => void;
  /**
   * The currently-highlighted line range (W65), inclusive + 1-based, or null.
   * Rows whose line falls inside it get an `in-range` class so a copied range
   * is visible. The single revealed line (W57) still uses `revealLine`.
   */
  range?: { start: number; end: number } | null;
}

/** Render the blame surface (form + heatmap) into a detached node. */
export function renderBlame(model: BlameModel | null, opts: BlameViewOptions): HTMLElement {
  const wrap = el('div', 'blame');

  // Path entry form — always present so the user can switch files.
  wrap.appendChild(buildForm(opts));

  // Ignore-revs control (W44) — only when a file is loaded + the host wires
  // the handlers, since it re-blames the current path.
  if (opts.path && opts.onAddIgnoreRev) {
    wrap.appendChild(buildIgnoreRevs(opts));
  }

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

  // Author legend (W40: clickable to isolate one author; active one marked).
  const active = opts.activeAuthor ?? null;
  const legend = el('div', 'blame-legend');
  const summary = el('span', 'blame-summary');
  summary.textContent = blameSummary(model.totalLines, model.authors.length);
  legend.appendChild(summary);
  for (const a of model.authors.slice(0, 10)) {
    const isActive = active !== null && active.trim().toLowerCase() === a.author.trim().toLowerCase();
    const email = opts.onOpenAuthor ? authorEmailFromLines(model.lines, a.author) : '';
    // A chip wraps the isolate button (W40) and an optional "view
    // contributor" affordance (W51) so both actions share one row without
    // nesting interactive elements.
    const chip = el('div', 'blame-legend-item' + (isActive ? ' active' : ''));

    const isolate = el(
      opts.onToggleAuthor ? 'button' : 'span',
      'blame-legend-isolate' + (opts.onToggleAuthor ? ' clickable' : ''),
    );
    const pct = Math.round(a.share * 100);
    isolate.innerHTML =
      `<span class="dot" style="background:${authorDot(a.author)}"></span>` +
      `<span class="who">${escapeHtml(a.author)}</span>` +
      `<span class="n">${a.lines} (${pct}%)</span>`;
    if (opts.onToggleAuthor) {
      (isolate as HTMLButtonElement).type = 'button';
      isolate.title = isActive ? `Show all authors` : `Isolate ${a.author}`;
      isolate.setAttribute('aria-pressed', String(isActive));
      isolate.addEventListener('click', () => opts.onToggleAuthor!(a.author));
    }
    chip.appendChild(isolate);

    // "View contributor" (W51): opens the author's W23 detail panel. Only
    // shown when wired AND we resolved an email (the panel is email-keyed).
    if (opts.onOpenAuthor && email) {
      const open = el('button', 'blame-legend-open');
      open.type = 'button';
      open.title = `View ${a.author}'s contributions`;
      open.setAttribute('aria-label', `View ${a.author}'s contributions`);
      open.innerHTML = icons.users;
      open.addEventListener('click', () => opts.onOpenAuthor!(a.author, email));
      chip.appendChild(open);
    }
    legend.appendChild(chip);
  }
  // A clear-filter affordance when an author is isolated (W40).
  if (active && opts.onToggleAuthor) {
    const clear = el('button', 'blame-legend-clear');
    clear.type = 'button';
    clear.textContent = 'Show all';
    clear.title = 'Clear author filter';
    clear.addEventListener('click', () => opts.onToggleAuthor!(active));
    legend.appendChild(clear);
  }
  wrap.appendChild(legend);

  // Age-ramp legend (W40): a key for what the heat strip's colours mean,
  // oldest (cold) -> newest (hot), with relative-age tick labels.
  wrap.appendChild(buildAgeLegend(model));

  // Rows: windowed for big files, plain for small ones.
  const rows = el('div', 'blame-rows');
  // Delegated click for the line-number copy buttons (W57) — works for both
  // the plain and windowed renderers since rows are (re)mounted into here.
  // W65: a SHIFT-click copies the range from the last plain-clicked anchor to
  // the shift-clicked line; a plain click copies the single line + sets the
  // anchor. The anchor is local to this render (a fresh load resets it).
  const copyable = !!opts.onCopyLine;
  const range = opts.range ?? null;
  if (copyable) {
    let anchor: number | null = range ? range.start : null;
    rows.addEventListener('click', e => {
      const target = (e.target as HTMLElement)?.closest<HTMLElement>('[data-copy-line]');
      if (!target) return;
      const line = Number(target.dataset.copyLine);
      if (!Number.isInteger(line) || line <= 0) return;
      if ((e as MouseEvent).shiftKey && anchor !== null && opts.onCopyLineRange) {
        const start = Math.min(anchor, line);
        const end = Math.max(anchor, line);
        if (end > start) {
          opts.onCopyLineRange(start, end);
          return;
        }
      }
      anchor = line;
      opts.onCopyLine!(line);
    });
  }
  wrap.appendChild(rows);
  if (shouldVirtualizeBlame(model.lines.length)) {
    new BlameWindowController(rows, model, opts.revealLine ?? null, active, copyable, range);
  } else {
    renderAllRows(rows, model, opts.revealLine ?? null, active, copyable, range);
  }

  return wrap;
}

/**
 * Build the age-ramp legend (W40): a gradient strip from oldest to newest
 * with a handful of relative-age ticks, so the heat colours have a key.
 */
function buildAgeLegend(model: BlameModel): HTMLElement {
  const wrap = el('div', 'blame-age-legend');
  if (!model.oldest || !model.newest) return wrap;
  const ramp = buildAgeRamp(model.oldest, model.newest, 5);
  const label = el('span', 'blame-age-label', 'Age');
  const strip = el('span', 'blame-age-strip');
  // A left-to-right cold->hot gradient built from the ramp's heat stops.
  const stops = ramp.map(s => heatColor(s.heat)).join(', ');
  strip.style.background = `linear-gradient(to right, ${stops})`;
  const ticks = el('span', 'blame-age-ticks');
  ticks.innerHTML =
    `<span>older</span>` +
    ramp
      .slice(1, -1)
      .map(s => `<span>${escapeHtml(relativeAgeFromUnix(s.unixSec))}</span>`)
      .join('') +
    `<span>newer</span>`;
  wrap.append(label, strip, ticks);
  return wrap;
}

/** Build one blame row element for a line. */
function blameRow(
  line: BlameLineInfo,
  model: BlameModel,
  positioned: boolean,
  index: number,
  activeAuthor: string | null,
  copyable: boolean,
  range: { start: number; end: number } | null,
): HTMLElement {
  const heat = blameHeat(line.authorTime, model.oldest, model.newest);
  const dimmed = isAuthorDimmed(line.author, activeAuthor);
  // W65: a copied multi-line range tints the rows it spans.
  const inRange = !!range && line.line >= range.start && line.line <= range.end;
  const row = el('div', 'blame-row' + (dimmed ? ' dim' : '') + (inRange ? ' in-range' : ''));
  row.dataset.line = String(line.line);
  if (positioned) row.style.top = `${index * BLAME_ROW_H}px`;
  row.title = `${line.author} \u00b7 ${line.summary}`;
  // The line number is a copy-permalink affordance (W57) when wired: a button
  // that copies a shareable #blame?...&line=N link. Shift-click copies a range
  // from the last-clicked line (W65). Inert otherwise.
  const lnCell = copyable
    ? `<button class="blame-ln link" data-copy-line="${line.line}" title="Copy a link to line ${line.line} (shift-click for a range)" aria-label="Copy link to line ${line.line}">${line.line}</button>`
    : `<span class="blame-ln">${line.line}</span>`;
  row.innerHTML =
    `<span class="blame-heat" style="background:${heatColor(heat)}"></span>` +
    `<span class="blame-dot" style="background:${authorDot(line.author)}" title="${escapeHtml(line.author)}"></span>` +
    `<span class="blame-sha">${escapeHtml(line.shortSha)}</span>` +
    `<span class="blame-author">${escapeHtml(line.author)}</span>` +
    `<span class="blame-age">${escapeHtml(relativeAgeFromUnix(line.authorTime))}</span>` +
    lnCell +
    `<span class="blame-src">${escapeHtml(line.code) || '&nbsp;'}</span>`;
  return row;
}

/** Small-file path: mount every row, then optionally scroll to a line. */
function renderAllRows(rows: HTMLElement, model: BlameModel, revealLine: number | null, activeAuthor: string | null, copyable: boolean, range: { start: number; end: number } | null): void {
  const frag = document.createDocumentFragment();
  model.lines.forEach((line, i) => frag.appendChild(blameRow(line, model, false, i, activeAuthor, copyable, range)));
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
  private readonly activeAuthor: string | null;
  private readonly copyable: boolean;
  private readonly range: { start: number; end: number } | null;
  private win: WindowRange = { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };
  private pendingReveal: number | null;

  constructor(rows: HTMLElement, model: BlameModel, revealLine: number | null, activeAuthor: string | null, copyable: boolean, range: { start: number; end: number } | null) {
    this.rows = rows;
    this.model = model;
    this.activeAuthor = activeAuthor;
    this.copyable = copyable;
    this.range = range;
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
      frag.appendChild(blameRow(this.model.lines[i], this.model, true, i, this.activeAuthor, this.copyable, this.range));
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

  // Revision badge (W28): when blaming AT a commit (not HEAD), show the
  // short rev so the heatmap's scope is unambiguous.
  const rev = opts.rev && opts.rev !== 'HEAD' ? opts.rev : '';
  if (rev) {
    const badge = el('span', 'blame-rev');
    badge.innerHTML = `<span class="at">at</span><span class="rev">${escapeHtml(rev.slice(0, 12))}</span>`;
    badge.title = `Blaming at ${rev}`;
    form.appendChild(badge);
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const value = input.value.trim();
    if (value) opts.onLoad(value);
  });
  return form;
}

/**
 * Ignore-revs control (W44): an input to add a noise commit to skip, plus a
 * chip list of the currently-ignored revs (each removable). Adding/removing
 * re-blames the current file with the updated `--ignore-rev` set, so lines a
 * mass reformat last touched fall back to their real author. Monochrome
 * chrome, hairline borders, no emoji.
 */
function buildIgnoreRevs(opts: BlameViewOptions): HTMLElement {
  const wrap = el('div', 'blame-ignore');

  const form = el('form', 'blame-ignore-form');
  const label = el('span', 'blame-ignore-label', 'Ignore revs');
  label.title = 'Skip a noise commit (mass reformat / rename) so blame shows the real author';
  const input = el('input', 'blame-ignore-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'commit sha to ignore';
  input.setAttribute('aria-label', 'Commit to ignore when blaming');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  const add = el('button', 'btn');
  add.type = 'submit';
  add.textContent = 'Ignore';
  form.append(label, input, add);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const value = input.value.trim();
    if (value && opts.onAddIgnoreRev) {
      opts.onAddIgnoreRev(value);
      input.value = '';
    }
  });
  wrap.appendChild(form);

  const revs = opts.ignoreRevs ?? [];
  if (revs.length > 0) {
    const chips = el('div', 'blame-ignore-chips');
    for (const rev of revs) {
      const chip = el('span', 'blame-ignore-chip');
      const sha = el('code', 'rev', escapeHtml(rev.slice(0, 10)));
      chip.appendChild(sha);
      if (opts.onRemoveIgnoreRev) {
        const x = el('button', 'blame-ignore-x');
        x.type = 'button';
        x.innerHTML = icons.close;
        x.title = `Stop ignoring ${rev.slice(0, 10)}`;
        x.setAttribute('aria-label', `Stop ignoring ${rev.slice(0, 10)}`);
        x.addEventListener('click', () => opts.onRemoveIgnoreRev!(rev));
        chip.appendChild(x);
      }
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
  }

  return wrap;
}
