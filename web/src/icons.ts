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
  repo: svg(
    '<path d="M4 2.5h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4.5A1.5 1.5 0 0 1 3 13V4a1.5 1.5 0 0 1 1.5-1.5Z"/>' +
      '<path d="M3 11.5A1.5 1.5 0 0 1 4.5 10H12"/>',
  ),
  chevron: svg('<path d="M5 6.5 8 9.5l3-3"/>'),
  help: svg(
    '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.5-.7 1v.4"/>' +
      '<circle cx="8" cy="11.4" r="0.2" fill="currentColor"/>',
  ),
  branch: svg(
    '<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/>' +
      '<circle cx="11" cy="5.5" r="1.6"/><path d="M5 5.6v4.8"/>' +
      '<path d="M11 7.1c0 2-1.4 2.6-3 3"/>',
  ),
  remote: svg(
    '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/>' +
      '<circle cx="8" cy="8" r="6.2"/>',
  ),
  tag: svg(
    '<path d="M2.5 7.3 7.3 2.5H13v5.7L8.2 13z"/><circle cx="10" cy="5.5" r="0.9" fill="currentColor"/>',
  ),
  sidebar: svg(
    '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M6.5 3v10"/>',
  ),
  download: svg('<path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 13h10"/>'),
  calendar: svg(
    '<rect x="2.5" y="3" width="11" height="10.5" rx="1.4"/>' +
      '<path d="M2.5 6h11M5.5 1.8v2.4M10.5 1.8v2.4"/>',
  ),
  users: svg(
    '<circle cx="6" cy="6" r="2.3"/><path d="M2.2 13a3.8 3.8 0 0 1 7.6 0"/>' +
      '<path d="M10.5 4.2a2.3 2.3 0 0 1 0 4.1"/><path d="M11.2 9.4A3.8 3.8 0 0 1 14 13"/>',
  ),
  blame: svg(
    '<rect x="2.5" y="2.5" width="11" height="11" rx="1.4"/>' +
      '<path d="M5 5.5h6M5 8h6M5 10.5h3.5"/>',
  ),
  // Compare / range-diff: two offset brackets meeting an arrow (W18).
  gitCompare: svg(
    '<circle cx="4" cy="12" r="1.7"/><circle cx="12" cy="4" r="1.7"/>' +
      '<path d="M4 10.3V6.5A2 2 0 0 1 6 4.5h3.4"/>' +
      '<path d="M12 5.7v3.8a2 2 0 0 1-2 2H6.6"/>' +
      '<path d="M8.2 2.7 9.9 4.5 8.2 6.3M7.8 9.7 6.1 11.5l1.7 1.8"/>',
  ),
  // Swap base/head: two vertical arrows pointing opposite ways (W18).
  swap: svg('<path d="M5 3v10M5 13 2.8 10.7M5 13l2.2-2.3M11 13V3M11 3 8.8 5.3M11 3l2.2 2.3"/>'),
};

export type IconName = keyof typeof icons;
