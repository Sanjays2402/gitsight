/**
 * Monochrome inline SVG glyphs for the app chrome (W2).
 *
 * Hand-drawn 16x16 line icons — no emoji, no icon-font dependency. Each
 * returns an `<svg>` string sized to inherit `currentColor`. Keeps the
 * bundle tiny and the chrome crisp at any DPI.
 */

function svg(path: string, opts: { fill?: boolean } = {}): string {
  const stroke = opts.fill ? 'none' : 'currentColor';
  const fill = opts.fill ? 'currentColor' : 'none';
  return (
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="${fill}" ` +
    `stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${path}</svg>`
  );
}

export const icons = {
  // A minimal branch/commit glyph for the brand mark.
  mark: svg(
    '<circle cx="4" cy="4" r="1.7"/><circle cx="4" cy="12" r="1.7"/>' +
      '<circle cx="12" cy="8" r="1.7"/><path d="M4 5.7v4.6"/>' +
      '<path d="M5.6 4h2.2a2.6 2.6 0 0 1 2.6 2.6v0"/>',
  ),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.5 10.5 14 14"/>'),
  refresh: svg(
    '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5V5H11"/>',
  ),
  sun: svg(
    '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15' +
      'M3 3l1.1 1.1M11.9 11.9 13 13M13 3l-1.1 1.1M4.1 11.9 3 13"/>',
  ),
  moon: svg('<path d="M13.4 9.5A5.5 5.5 0 1 1 6.5 2.6 4.3 4.3 0 0 0 13.4 9.5Z"/>'),
  graph: svg(
    '<circle cx="4" cy="12" r="1.6"/><circle cx="4" cy="4" r="1.6"/>' +
      '<circle cx="12" cy="8" r="1.6"/><path d="M4 5.6v4.8"/>' +
      '<path d="M5.5 4.2h3A3 3 0 0 1 11.4 7"/>',
  ),
  warn: svg(
    '<path d="M8 2.5 14.5 13.5H1.5L8 2.5Z"/><path d="M8 6.5v3"/>' +
      '<circle cx="8" cy="11.6" r="0.2" fill="currentColor"/>',
  ),
  empty: svg(
    '<rect x="2" y="3" width="12" height="10" rx="1.6"/>' +
      '<path d="M2 6h12M5 3v3"/>',
  ),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  arrowRight: svg('<path d="M3 8h10M9 4l4 4-4 4"/>'),
};

export type IconName = keyof typeof icons;
