import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildStandaloneSvg,
  buildExportFilename,
  sanitiseColour,
  escapeXml,
  truncate,
} from '../../src/shared/graphExport';

// The stack-agnostic export is also covered (via the git re-export) by
// commitGraphExport.test.ts; these assert the shared module directly and
// the helpers the re-export doesn't surface.

test('buildStandaloneSvg wraps rows in a sized document with a header', () => {
  const built = buildStandaloneSvg({
    rowsSvg: '<g transform="translate(0,0)"><circle/></g>',
    graphWidth: 60,
    rowHeight: 30,
    rowCount: 1,
    rows: [{ shortSha: 'abc1234', subject: 'fix: x', author: 'Ada', relativeDate: '2d ago', y: 0 }],
    title: 'GitSight \u2014 demo',
  });
  assert.ok(built.svg.startsWith('<?xml'));
  assert.ok(built.svg.includes('<svg'));
  assert.ok(built.svg.includes('GitSight \u2014 demo'));
  assert.ok(built.svg.includes('1 commit'));
  assert.ok(built.svg.includes('abc1234'));
  assert.equal(built.width, 60 + 16 + 720);
  assert.ok(built.height > 30);
});

test('buildStandaloneSvg escapes XML in labels', () => {
  const built = buildStandaloneSvg({
    rowsSvg: '',
    graphWidth: 40,
    rowHeight: 28,
    rowCount: 1,
    rows: [{ shortSha: 'a', subject: '<script>&"', author: 'b', relativeDate: 'c', y: 0 }],
  });
  assert.ok(!built.svg.includes('<script>'));
  assert.ok(built.svg.includes('&lt;script&gt;'));
});

test('sanitiseColour accepts safe colours and rejects junk', () => {
  assert.equal(sanitiseColour('#0d1117'), '#0d1117');
  assert.equal(sanitiseColour('#abc'), '#abc');
  assert.equal(sanitiseColour('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(sanitiseColour('white'), 'white');
  assert.equal(sanitiseColour('url(javascript:alert(1))'), undefined);
  assert.equal(sanitiseColour(undefined), undefined);
});

test('escapeXml + truncate behave', () => {
  assert.equal(escapeXml(`<a> & "b" 'c'`), '&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos;');
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 5), 'hell\u2026');
});

test('buildExportFilename stamps the timestamp + extension', () => {
  const name = buildExportFilename(new Date('2026-06-25T22:47:00'), 'svg');
  assert.match(name, /^gitsight-graph-2026-06-25-2247\.svg$/);
  assert.match(buildExportFilename(new Date('2026-01-02T03:04:00'), 'png'), /^gitsight-graph-2026-01-02-0304\.png$/);
});
