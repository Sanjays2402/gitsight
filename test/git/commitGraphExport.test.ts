import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildStandaloneSvg,
  buildExportFilename,
} from '../../src/git/commitGraphExport';

const sampleRows = [
  { shortSha: 'abc1234', subject: 'fix: foo', author: 'Alice', relativeDate: '2d ago', y: 0 },
  { shortSha: 'def5678', subject: 'refactor: bar', author: 'Bob', relativeDate: '3d ago', y: 28 },
];

const sampleRowsSvg =
  '<g transform="translate(0,0)"><circle cx="10" cy="14" r="5" fill="#60a5fa"/></g>' +
  '<g transform="translate(0,28)"><circle cx="10" cy="14" r="5" fill="#4ade80"/></g>';

test('buildStandaloneSvg wraps the rows fragment in a valid xml root', () => {
  const { svg, width, height } = buildStandaloneSvg({
    rowsSvg: sampleRowsSvg,
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 2,
    rows: sampleRows,
  });
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes(`width="${width}"`));
  assert.ok(svg.includes(`height="${height}"`));
  assert.ok(svg.includes(sampleRowsSvg));
});

test('buildStandaloneSvg embeds row labels for each commit', () => {
  const { svg } = buildStandaloneSvg({
    rowsSvg: sampleRowsSvg,
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 2,
    rows: sampleRows,
  });
  assert.ok(svg.includes('fix: foo'));
  assert.ok(svg.includes('refactor: bar'));
  assert.ok(svg.includes('Alice'));
  assert.ok(svg.includes('Bob'));
  assert.ok(svg.includes('abc1234'));
  assert.ok(svg.includes('2d ago'));
});

test('buildStandaloneSvg escapes XML special characters in metadata', () => {
  const { svg } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 1,
    rows: [{ shortSha: 'a&b', subject: '<script>x</script>', author: '"Bob"', relativeDate: "today", y: 0 }],
  });
  assert.ok(svg.includes('&amp;b'));
  assert.ok(svg.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(svg.includes('&quot;Bob&quot;'));
  // The raw forbidden characters must not be in the label section.
  // Find the subject label position and assert escaping holds.
  assert.ok(!svg.includes('<script>'));
});

test('buildStandaloneSvg truncates long subjects with an ellipsis', () => {
  const longSubject = 'a'.repeat(200);
  const { svg } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 1,
    rows: [{ shortSha: 's', subject: longSubject, author: 'X', relativeDate: 'now', y: 0 }],
  });
  assert.ok(svg.includes('\u2026'), 'expected ellipsis');
  assert.ok(!svg.includes(longSubject), 'should not contain the full untruncated subject');
});

test('buildStandaloneSvg uses sensible defaults for missing colours', () => {
  const { svg } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 0,
    rows: [],
  });
  assert.ok(svg.includes('fill="#0d1117"'), 'default background');
  assert.ok(svg.includes('fill="#e6edf3"'), 'default foreground');
});

test('buildStandaloneSvg sanitises rogue colour inputs back to defaults', () => {
  const { svg } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 0,
    rows: [],
    background: 'javascript:alert(1)',
    foreground: 'expression(eval())',
  });
  // The bad strings should never appear in the output — sanitiser
  // demoted them to undefined → default applied.
  assert.ok(!svg.includes('javascript:'));
  assert.ok(!svg.includes('expression('));
  assert.ok(svg.includes('fill="#0d1117"'));
  assert.ok(svg.includes('fill="#e6edf3"'));
});

test('buildStandaloneSvg accepts valid hex/rgb/named colours', () => {
  const { svg } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 0,
    rows: [],
    background: '#ffffff',
    foreground: 'rgb(0, 0, 0)',
    muted: 'black',
  });
  assert.ok(svg.includes('fill="#ffffff"'));
  assert.ok(svg.includes('fill="rgb(0, 0, 0)"'));
});

test('buildStandaloneSvg subtitle singularises for 1 commit', () => {
  const { svg } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 1,
    rows: [{ shortSha: 's', subject: 'x', author: 'a', relativeDate: 'now', y: 0 }],
  });
  assert.ok(svg.includes('>1 commit<'));
  assert.ok(!svg.includes('>1 commits<'));
});

test('buildStandaloneSvg width includes the label column', () => {
  const { width } = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 100,
    rowHeight: 28,
    rowCount: 0,
    rows: [],
  });
  // graphWidth=100 + gap(16) + label-col(720) = 836.
  assert.equal(width, 836);
});

test('buildStandaloneSvg height grows with row count', () => {
  const a = buildStandaloneSvg({ rowsSvg: '', graphWidth: 40, rowHeight: 28, rowCount: 0, rows: [] });
  const b = buildStandaloneSvg({ rowsSvg: '', graphWidth: 40, rowHeight: 28, rowCount: 10, rows: [] });
  assert.ok(b.height > a.height);
});

test('buildExportFilename uses a stable timestamp pattern', () => {
  const ts = new Date('2026-06-21T22:47:00');
  // Local time is used.
  assert.equal(buildExportFilename(ts, 'svg'), 'gitsight-graph-2026-06-21-2247.svg');
  assert.equal(buildExportFilename(ts, 'png'), 'gitsight-graph-2026-06-21-2247.png');
});

test('buildExportFilename zero-pads single-digit fields', () => {
  const ts = new Date('2026-01-05T03:09:00');
  assert.equal(buildExportFilename(ts, 'svg'), 'gitsight-graph-2026-01-05-0309.svg');
});
