/**
 * Pure helpers for the Commit Graph PNG/SVG Export (F61).
 *
 * Given the SVG-only `<g>` row markup that the F1 CommitGraphPanel
 * generates, this module wraps it into a STANDALONE `<svg>` document
 * that opens correctly outside the webview (browser, image viewer,
 * Sketch, Figma) and computes a stable timestamped filename.
 *
 * The webview's in-DOM `<svg>` only has graph rows; the commit list is
 * separate HTML. We mirror that structure into a wider SVG that
 * includes:
 *
 *   - The graph lanes (verbatim, no recolouring — caller passes the
 *     same SVG fragment the webview already rendered).
 *   - Per-row text labels (subject + author + relative date + shortSha)
 *     to the right of the graph so the export is self-explanatory.
 *
 * Pure — no vscode, no fs, no DOM. Tests in
 * test/git/commitGraphExport.test.ts.
 */

export interface ExportRow {
  shortSha: string;
  subject: string;
  author: string;
  relativeDate: string;
  /** Y-position of the row in the existing SVG (multiple of rowHeight). */
  y: number;
}

export interface BuildSvgArgs {
  /** The `<g transform="translate(0,N)">…</g>` fragments the webview
   *  already generated for each row. Caller passes them verbatim so the
   *  export visual matches the webview pixel-for-pixel. */
  rowsSvg: string;
  /** Width of the graph portion in pixels (the webview's `graphW`). */
  graphWidth: number;
  /** Height of one row in pixels (default 28). */
  rowHeight: number;
  /** Number of rows. */
  rowCount: number;
  /** Per-row metadata used to render the labels alongside the graph. */
  rows: ExportRow[];
  /** Optional title to embed at the top. */
  title?: string;
  /** Background colour for the SVG; default '#0d1117' (a sensible dark). */
  background?: string;
  /** Foreground (text) colour; default '#e6edf3' for the dark background. */
  foreground?: string;
  /** Optional muted colour for the metadata columns; default '#7d8590'. */
  muted?: string;
}

export interface BuiltSvg {
  svg: string;
  /** Final width including the label column. */
  width: number;
  /** Final height (just the row stack + header padding). */
  height: number;
}

const LABEL_GAP_PX = 16;
const LABEL_COL_WIDTH_PX = 720;
const HEADER_HEIGHT_PX = 36;

export function buildStandaloneSvg(args: BuildSvgArgs): BuiltSvg {
  const rowHeight = Math.max(12, Math.floor(args.rowHeight || 28));
  const rowCount = Math.max(0, args.rowCount | 0);
  const graphWidth = Math.max(40, args.graphWidth | 0);
  const width = graphWidth + LABEL_GAP_PX + LABEL_COL_WIDTH_PX;
  const height = HEADER_HEIGHT_PX + Math.max(rowHeight, rowCount * rowHeight);
  const bg = sanitiseColour(args.background) ?? '#0d1117';
  const fg = sanitiseColour(args.foreground) ?? '#e6edf3';
  const muted = sanitiseColour(args.muted) ?? '#7d8590';
  const title = (args.title ?? 'GitSight Commit Graph').trim() || 'GitSight Commit Graph';

  const labelRows = args.rows.slice(0, rowCount).map((r, i) => {
    const y = HEADER_HEIGHT_PX + i * rowHeight + Math.floor(rowHeight * 0.65);
    const subject = escapeXml(truncate(r.subject, 80));
    const author = escapeXml(truncate(r.author, 24));
    const date = escapeXml(truncate(r.relativeDate, 16));
    const sha = escapeXml(r.shortSha);
    // Three columns: subject (flex), author (right-aligned within label
    // column), date (right of author), sha (rightmost).
    const subjectX = graphWidth + LABEL_GAP_PX;
    const shaX = width - 8;
    const dateX = shaX - 80;
    const authorX = dateX - 100;
    return [
      `<text x="${subjectX}" y="${y}" fill="${fg}" font-family="sans-serif" font-size="13">${subject}</text>`,
      `<text x="${authorX}" y="${y}" fill="${muted}" font-family="sans-serif" font-size="11" text-anchor="end">${author}</text>`,
      `<text x="${dateX}" y="${y}" fill="${muted}" font-family="sans-serif" font-size="11" text-anchor="end">${date}</text>`,
      `<text x="${shaX}" y="${y}" fill="${muted}" font-family="monospace" font-size="11" text-anchor="end">${sha}</text>`,
    ].join('');
  }).join('');

  const titleX = 12;
  const titleY = 22;
  const subtitle = `${rowCount} commit${rowCount === 1 ? '' : 's'}`;
  const subtitleX = width - 12;

  // The rowsSvg fragments use y-coords from 0..rowCount*rowHeight; wrap
  // them in a group that's pushed down by HEADER_HEIGHT_PX so the header
  // sits above without overlap.
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${bg}"/>`,
    `<text x="${titleX}" y="${titleY}" fill="${fg}" font-family="sans-serif" font-size="14" font-weight="600">${escapeXml(title)}</text>`,
    `<text x="${subtitleX}" y="${titleY}" fill="${muted}" font-family="sans-serif" font-size="12" text-anchor="end">${subtitle}</text>`,
    `<g transform="translate(0,${HEADER_HEIGHT_PX})">${args.rowsSvg}</g>`,
    labelRows,
    `</svg>`,
  ].join('');
  return { svg, width, height };
}

function sanitiseColour(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  // Accept hex (#rgb / #rrggbb / #rrggbbaa), rgb()/rgba(), and a couple
  // of bare named colours that are useful as defaults. Reject anything
  // weird to avoid an attacker-controlled style attribute breakout via
  // the colour input.
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) return trimmed;
  if (/^rgba?\([0-9, .]+\)$/i.test(trimmed)) return trimmed;
  if (/^(?:white|black|transparent|none)$/i.test(trimmed)) return trimmed;
  return undefined;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}\u2026`;
}

/**
 * Build a timestamped filename for the export. Shape:
 *
 *   gitsight-graph-2026-06-21-2247.svg
 *
 * Matches the project's `.cron-state/sessions/` filename convention.
 */
export function buildExportFilename(now: Date, extension: 'svg' | 'png'): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `gitsight-graph-${ts}.${extension}`;
}

/**
 * F83 - decode a `data:image/png;base64,...` data URL into a binary
 * buffer-ready string. Returns:
 *   - { ok: true, base64: '...' } on success
 *   - { ok: false, reason: '...' } when the input doesn't look like a
 *     PNG data URL (wrong prefix, missing comma, empty payload).
 *
 * Pure - no Buffer/Uint8Array allocation; the caller decodes the
 * base64 portion. Keeps this helper testable in Node + browser.
 */
export type PngDataUrlResult =
  | { ok: true; base64: string }
  | { ok: false; reason: string };

export function parsePngDataUrl(dataUrl: unknown): PngDataUrlResult {
  if (typeof dataUrl !== 'string') return { ok: false, reason: 'payload is not a string' };
  if (!dataUrl) return { ok: false, reason: 'empty payload' };
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) return { ok: false, reason: 'wrong data-URL prefix' };
  const base64 = dataUrl.slice(prefix.length);
  if (!base64) return { ok: false, reason: 'empty base64 payload' };
  // Quick shape check: base64 alphabet only.
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) return { ok: false, reason: 'payload contains non-base64 characters' };
  return { ok: true, base64 };
}

/**
 * F83 - build the `data:image/svg+xml;base64,...` URL the webview's
 * `new Image()` consumes. base64 encoding is mandatory (rather than
 * `;utf8`) so embedded angle brackets + quotes survive the data URL
 * parser even when the SVG has whitespace inside attribute values.
 */
export function buildSvgDataUrl(svg: string, base64Encoder: (s: string) => string): string {
  return `data:image/svg+xml;base64,${base64Encoder(svg)}`;
}
