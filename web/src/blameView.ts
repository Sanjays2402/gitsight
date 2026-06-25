/**
 * Blame heatmap view (W12).
 *
 * Renders a shared BlameModel as a per-line age heatmap: a heat strip
 * (newest=hot, oldest=cold), an author dot, the short sha, a compact age,
 * the line number, and the source. An author legend sits above. Mirrors
 * the extension's blameHeatmap webview in the web app's design language.
 *
 * Blame is per-file, so the view also renders a path-entry form when no
 * file is loaded. Pure colour/age maths live in blameFormat.ts (tested);
 * this module owns the DOM.
 */

import { el } from './format';
import { icons } from './icons';
import { escapeHtml } from '@shared/graphCore';
import { blameHeat, type BlameModel } from '@shared/blame';
import { heatColor, authorDot, relativeAgeFromUnix, blameSummary } from './blameFormat';

export interface BlameViewOptions {
  /** Current file path, if one is loaded. */
  path?: string;
  /** Fired when the user submits a path to blame. */
  onLoad: (path: string) => void;
  /** Soft cap on rendered lines (huge files). Default 4000. */
  maxLines?: number;
}

const DEFAULT_MAX = 4000;

/** Render the blame surface (form + heatmap) into a detached node. */
export function renderBlame(model: BlameModel | null, opts: BlameViewOptions): HTMLElement {
  const wrap = el('div', 'blame');

  // Path entry form — always present so the user can switch files.
  wrap.appendChild(buildForm(opts));

  if (!model) {
    const hint = el('div', 'blame-hint');
    hint.innerHTML =
      `<span class="glyph">${icons.blame}</span>` +
      `<p>Enter a file path to see its line-by-line age heatmap.</p>`;
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

  // Lines.
  const max = opts.maxLines ?? DEFAULT_MAX;
  const rows = el('div', 'blame-rows');
  const shown = model.lines.slice(0, max);
  for (const line of shown) {
    const heat = blameHeat(line.authorTime, model.oldest, model.newest);
    const row = el('div', 'blame-row');
    row.title = `${line.author} \u00b7 ${line.summary}`;
    row.innerHTML =
      `<span class="blame-heat" style="background:${heatColor(heat)}"></span>` +
      `<span class="blame-dot" style="background:${authorDot(line.author)}" title="${escapeHtml(line.author)}"></span>` +
      `<span class="blame-sha">${escapeHtml(line.shortSha)}</span>` +
      `<span class="blame-author">${escapeHtml(line.author)}</span>` +
      `<span class="blame-age">${escapeHtml(relativeAgeFromUnix(line.authorTime))}</span>` +
      `<span class="blame-ln">${line.line}</span>` +
      `<span class="blame-src">${escapeHtml(line.code) || '&nbsp;'}</span>`;
    rows.appendChild(row);
  }
  wrap.appendChild(rows);

  if (model.lines.length > max) {
    const note = el('div', 'blame-hint');
    note.textContent = `Showing the first ${max} of ${model.lines.length} lines.`;
    wrap.appendChild(note);
  }

  return wrap;
}

function buildForm(opts: BlameViewOptions): HTMLElement {
  const form = el('form', 'blame-form');
  const input = el('input', 'blame-path');
  input.type = 'text';
  input.placeholder = 'path/to/file.ts';
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
    const path = input.value.trim();
    if (path) opts.onLoad(path);
  });
  return form;
}
