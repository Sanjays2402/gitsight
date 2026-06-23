import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildPrintHtml,
  classifyPdfExport,
  estimateSvgBytes,
  buildExportFilename,
  buildStandaloneSvg,
} from '../../src/git/commitGraphExport';

// ── buildExportFilename: PDF extension ────────────────────────────────

test('buildExportFilename: pdf extension stamp', () => {
  const ts = new Date(2026, 5, 23, 11, 30); // 2026-06-23 11:30
  assert.equal(buildExportFilename(ts, 'pdf'), 'gitsight-graph-2026-06-23-1130.pdf');
});

test('buildExportFilename: pdf has same pattern as svg/png', () => {
  const ts = new Date(2026, 5, 23, 11, 30);
  const svg = buildExportFilename(ts, 'svg');
  const pdf = buildExportFilename(ts, 'pdf');
  // Same prefix + timestamp, only extension differs.
  assert.equal(svg.replace(/\.svg$/, ''), pdf.replace(/\.pdf$/, ''));
});

// ── buildPrintHtml ────────────────────────────────────────────────────

function fakeSvg(): { svg: string; width: number; height: number } {
  return buildStandaloneSvg({
    rowsSvg: '<circle cx="10" cy="10" r="5" fill="#fff"/>',
    graphWidth: 200,
    rowHeight: 28,
    rowCount: 3,
    rows: [
      { shortSha: 'abc1234', subject: 'test commit 1', author: 'Sanjay', relativeDate: '1h ago', y: 0 },
      { shortSha: 'def5678', subject: 'test commit 2', author: 'Sanjay', relativeDate: '2h ago', y: 28 },
      { shortSha: '9012345', subject: 'test commit 3', author: 'Cake',   relativeDate: '3h ago', y: 56 },
    ],
  });
}

test('buildPrintHtml: contains doctype + html + body', () => {
  const inner = fakeSvg();
  const html = buildPrintHtml({ svg: inner.svg, svgWidth: inner.width, svgHeight: inner.height });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<body>[\s\S]*<\/body>/);
});

test('buildPrintHtml: embeds the SVG verbatim', () => {
  const inner = fakeSvg();
  const html = buildPrintHtml({ svg: inner.svg, svgWidth: inner.width, svgHeight: inner.height });
  assert.ok(html.includes(inner.svg));
});

test('buildPrintHtml: includes @page size in inches at 96dpi', () => {
  // 960px wide -> 10in, 280px tall -> 2.92in
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 960, svgHeight: 280 });
  assert.match(html, /@page\s*\{\s*size:\s*10\.00in\s+2\.92in;\s*margin:\s*0;/);
});

test('buildPrintHtml: @page uses 0.50in minimum for tiny dimensions', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 10, svgHeight: 5 });
  assert.match(html, /@page\s*\{\s*size:\s*0\.50in\s+0\.50in;/);
});

test('buildPrintHtml: @media print rules present (hide chrome + print colours)', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 100, svgHeight: 100 });
  assert.match(html, /@media print/);
  assert.match(html, /\.no-print\s*\{\s*display:\s*none\s*!important;/);
  assert.match(html, /print-color-adjust:\s*exact/);
});

test('buildPrintHtml: title falls back to default when blank', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 100, svgHeight: 100, title: '' });
  assert.match(html, /<title>GitSight Commit Graph<\/title>/);
});

test('buildPrintHtml: title customised when provided', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 100, svgHeight: 100, title: 'My Repo' });
  assert.match(html, /<title>My Repo<\/title>/);
});

test('buildPrintHtml: title is HTML-escaped (no script injection)', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 100, svgHeight: 100, title: '<script>alert(1)</script>' });
  // Must NOT contain raw `<script>`; should contain escaped form.
  assert.ok(!html.includes('<title><script>'), 'title leaks raw script');
  assert.match(html, /<title>&lt;script&gt;/);
});

test('buildPrintHtml: html/body margins zeroed for print fidelity', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 100, svgHeight: 100 });
  assert.match(html, /html,\s*body\s*\{[^}]*margin:\s*0;/);
});

test('buildPrintHtml: svg element sized to logical pixels', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 500, svgHeight: 250 });
  assert.match(html, /svg\s*\{[^}]*width:\s*500px;/);
  assert.match(html, /svg\s*\{[^}]*height:\s*250px;/);
});

test('buildPrintHtml: title trimmed before use', () => {
  const html = buildPrintHtml({ svg: '<svg/>', svgWidth: 100, svgHeight: 100, title: '   Padded   ' });
  assert.match(html, /<title>Padded<\/title>/);
});

// ── classifyPdfExport ─────────────────────────────────────────────────

test('classifyPdfExport: 0 rows -> no-graph', () => {
  assert.equal(classifyPdfExport({ rowCount: 0, estimatedBytes: 100 }), 'no-graph');
});

test('classifyPdfExport: negative rows -> no-graph', () => {
  assert.equal(classifyPdfExport({ rowCount: -5, estimatedBytes: 100 }), 'no-graph');
});

test('classifyPdfExport: 1 row + small payload -> ready', () => {
  assert.equal(classifyPdfExport({ rowCount: 1, estimatedBytes: 1024 }), 'ready');
});

test('classifyPdfExport: bytes over default 50MB cap -> too-large', () => {
  assert.equal(classifyPdfExport({ rowCount: 1000, estimatedBytes: 60 * 1024 * 1024 }), 'too-large');
});

test('classifyPdfExport: respects custom maxBytes', () => {
  assert.equal(classifyPdfExport({ rowCount: 100, estimatedBytes: 10_000, maxBytes: 1000 }), 'too-large');
  assert.equal(classifyPdfExport({ rowCount: 100, estimatedBytes: 500,    maxBytes: 1000 }), 'ready');
});

test('classifyPdfExport: rowCount precedence over bytes when row=0', () => {
  // Even if bytes is small, 0 rows is the gating constraint.
  assert.equal(classifyPdfExport({ rowCount: 0, estimatedBytes: 1, maxBytes: 1_000_000 }), 'no-graph');
});

// ── estimateSvgBytes ──────────────────────────────────────────────────

test('estimateSvgBytes: 0 rows still returns fixed overhead', () => {
  // Empty graph still has the document wrapper around it.
  assert.equal(estimateSvgBytes(0), 2048);
});

test('estimateSvgBytes: linear in row count (~400 bytes per row)', () => {
  const a = estimateSvgBytes(100);
  const b = estimateSvgBytes(200);
  // Each additional row should add ~400 bytes.
  assert.ok(b - a >= 100 * 400, `expected at least ${100*400}, got ${b-a}`);
});

test('estimateSvgBytes: returns >= fixedOverhead even for negative counts (defensive)', () => {
  assert.equal(estimateSvgBytes(-10), 2048);
});

test('estimateSvgBytes: integrates with classifyPdfExport for 1M rows -> too-large', () => {
  const rowCount = 1_000_000;
  const bytes = estimateSvgBytes(rowCount);
  assert.equal(classifyPdfExport({ rowCount, estimatedBytes: bytes }), 'too-large');
});

test('estimateSvgBytes: 5000 rows is comfortably under default cap', () => {
  const rowCount = 5000;
  const bytes = estimateSvgBytes(rowCount);
  assert.equal(classifyPdfExport({ rowCount, estimatedBytes: bytes }), 'ready');
});
