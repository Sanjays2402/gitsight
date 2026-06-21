import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseFile,
  formatReportMarkdown,
  hasCrlf,
  hasLfOnly,
  looksBinary,
  parseCheckAttrZ,
  summariseDiagnostics,
  FileAttrs,
} from '../../src/git/gitattributesDiag';

const buf = (s: string) => Buffer.from(s, 'utf8');
const nul = (): Buffer => Buffer.from([0x66, 0x6f, 0x00, 0x6f]); // "fo\0o"

test('looksBinary: NUL within first 8KB triggers true', () => {
  assert.equal(looksBinary(buf('hello')), false);
  assert.equal(looksBinary(nul()), true);
});

test('looksBinary: NUL beyond 8KB returns false', () => {
  const big = Buffer.alloc(8500, 0x61); // 'a' * 8500
  big[8400] = 0;
  assert.equal(looksBinary(big), false);
});

test('hasCrlf / hasLfOnly: discriminate line endings', () => {
  assert.equal(hasCrlf(buf('line1\r\nline2')), true);
  assert.equal(hasCrlf(buf('line1\nline2')), false);
  assert.equal(hasLfOnly(buf('line1\nline2')), true);
  // CRLF-only: contains LF but every LF is preceded by CR — so hasLfOnly is false.
  assert.equal(hasLfOnly(buf('line1\r\nline2\r\nline3')), false);
  assert.equal(hasLfOnly(buf('one\r\nblock\nback')), true); // mixed
});

test('parseCheckAttrZ: NUL-separated triples, one file two attrs', () => {
  // path\0attr\0value\0 repeated
  const raw = ['src/foo.png', 'text', 'unset', 'src/foo.png', 'binary', 'set'].join('\0') + '\0';
  const out = parseCheckAttrZ(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'src/foo.png');
  assert.equal(out[0].attrs.text, 'unset');
  assert.equal(out[0].attrs.binary, 'set');
});

test('parseCheckAttrZ: multiple files', () => {
  const raw = [
    'a.ts', 'text', 'auto',
    'b.png', 'binary', 'set',
    'b.png', 'text', 'unset',
    'c.md', 'eol', 'lf',
  ].join('\0') + '\0';
  const out = parseCheckAttrZ(raw);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(x => x.path).sort(), ['a.ts', 'b.png', 'c.md']);
});

test('parseCheckAttrZ: empty / malformed input safe', () => {
  assert.deepEqual(parseCheckAttrZ(''), []);
  assert.deepEqual(parseCheckAttrZ('garbage'), []);
});

test('diagnoseFile: text declared but binary content → diagnostic', () => {
  const out = diagnoseFile({
    attrs: { path: 'foo.png', attrs: { text: 'set' } },
    content: nul(),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'attr-text-but-binary');
});

test('diagnoseFile: text=auto + binary content → diagnostic mentioning text=auto', () => {
  const out = diagnoseFile({
    attrs: { path: 'foo.bin', attrs: { text: 'auto' } },
    content: nul(),
  });
  assert.equal(out.length, 1);
  assert.match(out[0].message, /text=auto/);
});

test('diagnoseFile: binary declared but text content → diagnostic', () => {
  const out = diagnoseFile({
    attrs: { path: 'README.md', attrs: { binary: 'set' } },
    content: buf('hello world'),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'attr-binary-but-text');
});

test('diagnoseFile: eol=lf but CRLF content → diagnostic', () => {
  const out = diagnoseFile({
    attrs: { path: 'foo.sh', attrs: { eol: 'lf' } },
    content: buf('one\r\ntwo\r\n'),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'attr-eol-lf-but-crlf');
});

test('diagnoseFile: eol=crlf but LF-only content → diagnostic', () => {
  const out = diagnoseFile({
    attrs: { path: 'foo.bat', attrs: { eol: 'crlf' } },
    content: buf('echo hi\necho bye\n'),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'attr-eol-crlf-but-lf');
});

test('diagnoseFile: eol checks skipped on binary content', () => {
  const out = diagnoseFile({
    attrs: { path: 'foo.png', attrs: { eol: 'lf', text: 'unset' } },
    content: nul(),
  });
  // text=unset means binary declared — but content IS binary so no "binary but text" miss.
  // The eol=lf rule must NOT fire on binary content, even if hasCrlf were true.
  assert.equal(out.length, 0);
});

test('diagnoseFile: matching content/attrs returns empty list', () => {
  const out = diagnoseFile({
    attrs: { path: 'foo.ts', attrs: { text: 'set', eol: 'lf' } },
    content: buf('hello\nworld\n'),
  });
  assert.deepEqual(out, []);
});

test('summariseDiagnostics: counts files and issues separately', () => {
  assert.match(summariseDiagnostics([]), /No \.gitattributes issues/);
  const diags = [
    { code: 'attr-text-but-binary' as const, path: 'a.png', message: 'x' },
    { code: 'attr-eol-lf-but-crlf' as const, path: 'a.png', message: 'y' },
    { code: 'attr-binary-but-text' as const, path: 'b.md', message: 'z' },
  ];
  // 3 issues across 2 files (a.png twice, b.md once).
  assert.match(summariseDiagnostics(diags), /3 \.gitattributes issues across 2 files/);
});

test('summariseDiagnostics: singular wording for exactly one of each', () => {
  const diags = [{ code: 'attr-text-but-binary' as const, path: 'a.png', message: 'x' }];
  assert.match(summariseDiagnostics(diags), /1 \.gitattributes issue across 1 file$/);
});

test('formatReportMarkdown: empty list shows reassuring message', () => {
  assert.match(formatReportMarkdown([]), /No issues detected/);
});

test('formatReportMarkdown: groups by file, sorted by insertion order', () => {
  const md = formatReportMarkdown([
    { code: 'attr-text-but-binary', path: 'src/a.png', message: 'one' },
    { code: 'attr-text-but-binary', path: 'src/b.png', message: 'two' },
    { code: 'attr-eol-lf-but-crlf', path: 'src/a.png', message: 'three' },
  ]);
  assert.match(md, /## `src\/a\.png`/);
  assert.match(md, /## `src\/b\.png`/);
  // Both diagnostics for a.png should appear under its section.
  const aIdx = md.indexOf('## `src/a.png`');
  const bIdx = md.indexOf('## `src/b.png`');
  assert.ok(aIdx >= 0 && bIdx > aIdx);
  // "one" + "three" are both for a.png — they should appear before bIdx.
  assert.ok(md.indexOf('one') < bIdx);
  assert.ok(md.indexOf('three') < bIdx);
});
