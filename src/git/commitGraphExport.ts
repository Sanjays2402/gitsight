/**
 * Pure helpers for the Commit Graph PNG/SVG/PDF Export (F61 / F83 / F132).
 *
 * The stack-agnostic SVG-document builder + filename helper now live in
 * `src/shared/graphExport.ts` so the standalone web app (W15) reuses the
 * SAME renderer the webview export does — the export never forks. This
 * module RE-EXPORTS them (so every existing import site keeps working)
 * and keeps the webview-coupled PNG/PDF plumbing (data-URL parsing,
 * print-HTML, size gating) that the browser web app doesn't need.
 *
 * Pure — no vscode, no fs, no DOM. Tests in
 * test/git/commitGraphExport.test.ts.
 */

export {
  buildStandaloneSvg,
  buildExportFilename,
  type ExportRow,
  type BuildSvgArgs,
  type BuiltSvg,
} from '../shared/graphExport';

import { escapeXml } from '../shared/graphExport';

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

/**
 * F132 - Build the inline HTML body for the print-on-demand PDF
 * export. Uses the standalone SVG (same one F61 + F83 produce) and
 * wraps it in a minimal HTML document with print-only stylesheet.
 *
 * The webview side opens this in a new window, calls window.print(),
 * and the user picks "Save as PDF" from the print dialog. We can't
 * write the PDF bytes ourselves from a webview (no Chromium PDF API
 * exposed), but the print-to-PDF path is universally available across
 * macOS, Linux, and Windows.
 *
 * Why a separate function (not just `buildStandaloneSvg`)? PDF print
 * needs:
 *   1. A surrounding `<html>` with media:print rules so the SVG fills
 *      the page (default browsers add margins + scaling).
 *   2. A page size declaration in the @page rule so multi-page graphs
 *      flow naturally.
 *   3. The toolbar / chrome from the webview HIDDEN during print so
 *      the PDF doesn't include "Export PNG" buttons.
 *
 * The caller passes the standalone SVG (built once via
 * buildStandaloneSvg with the same args used by the SVG export). We
 * embed it verbatim - the inner SVG already has its own background
 * + sizing so there's no double-paint.
 *
 * Pure - the webview side wraps this in a document.write() + print()
 * sequence. Test coverage validates the @page + media:print rules
 * land in the output so regressions surface here.
 */
export interface BuildPrintHtmlArgs {
  /** The standalone SVG (output of buildStandaloneSvg.svg). Embedded verbatim. */
  svg: string;
  /** Logical width of the SVG in pixels. Used to size the @page rule. */
  svgWidth: number;
  /** Logical height of the SVG. */
  svgHeight: number;
  /** Optional document title (shows in the print dialog + PDF metadata). */
  title?: string;
}

export function buildPrintHtml(args: BuildPrintHtmlArgs): string {
  const title = (args.title ?? 'GitSight Commit Graph').trim() || 'GitSight Commit Graph';
  // Convert px to inches at 96dpi (the CSS standard) so the @page size
  // matches the SVG's natural pixel dimensions when printing to PDF.
  // Cap minimum to half an inch so a tiny graph still gets a sensible page.
  const widthIn = Math.max(0.5, args.svgWidth / 96);
  const heightIn = Math.max(0.5, args.svgHeight / 96);
  // Sanitise via fixed-precision so floating-point drift doesn't leak
  // into the stylesheet.
  const wStr = widthIn.toFixed(2);
  const hStr = heightIn.toFixed(2);

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8"/>`,
    `<title>${escapeXml(title)}</title>`,
    `<style>`,
    `  @page { size: ${wStr}in ${hStr}in; margin: 0; }`,
    `  html, body { margin: 0; padding: 0; background: white; }`,
    `  body { display: block; }`,
    `  svg { display: block; width: ${args.svgWidth}px; height: ${args.svgHeight}px; }`,
    `  @media print {`,
    `    /* Hide anything that isn't the graph itself. */`,
    `    .no-print { display: none !important; }`,
    `    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
    `  }`,
    `</style>`,
    `</head>`,
    `<body>`,
    args.svg,
    `</body>`,
    `</html>`,
  ].join('\n');
}

/**
 * F132 - Classify the PDF export request from the webview. Two phases:
 *   1. 'prepare' (extension side): build standalone SVG + print HTML
 *   2. 'print' (webview side): open the HTML in a hidden iframe and
 *      invoke window.print()
 *
 * Wins a fast-fail when there's no graph to export.
 */
export type PdfExportVerdict = 'ready' | 'no-graph' | 'too-large';

export interface ClassifyPdfArgs {
  rowCount: number;
  estimatedBytes: number;
  /** Default 50 MB. Anything larger refuses to avoid OOM in the webview. */
  maxBytes?: number;
}

export function classifyPdfExport(args: ClassifyPdfArgs): PdfExportVerdict {
  if (args.rowCount <= 0) return 'no-graph';
  const max = args.maxBytes ?? 50 * 1024 * 1024;
  if (args.estimatedBytes > max) return 'too-large';
  return 'ready';
}

/**
 * F132 - Estimate the SVG payload size before building it. Cheap
 * heuristic: per-row markup is ~400 bytes when fully decorated, plus
 * fixed overhead for the document wrapper. Used by the gate so we
 * never try to print a million-commit graph and crash the webview.
 */
export function estimateSvgBytes(rowCount: number): number {
  const perRowBytes = 400;
  const fixedOverhead = 2048;
  return Math.max(fixedOverhead, fixedOverhead + rowCount * perRowBytes);
}
