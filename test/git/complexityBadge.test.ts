import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  computeComplexity,
  classifyBucket,
  badgeFor,
  describeComplexity,
  buildComplexityTooltip,
  stripCommentsAndStrings,
  isAnalysableFile,
} from '../../src/git/complexityBadge';

// ── computeComplexity basic shape ─────────────────────────────────

test('computeComplexity: empty body returns zero score', () => {
  const s = computeComplexity('');
  assert.equal(s.score, 0);
  assert.equal(s.bucket, 'low');
  assert.equal(s.decisions, 0);
  assert.equal(s.maxNesting, 0);
  assert.equal(s.logicalLines, 0);
  assert.equal(s.functions, 0);
});

test('computeComplexity: trivial file is low', () => {
  const s = computeComplexity('const x = 1;\nexport default x;');
  assert.equal(s.bucket, 'low');
});

test('computeComplexity: branchy file scores higher', () => {
  const body = `
function f(x) {
  if (x === 1) return 1;
  if (x === 2) return 2;
  if (x === 3) return 3;
  if (x === 4) return 4;
  if (x === 5) return 5;
  if (x === 6) return 6;
  if (x === 7) return 7;
  if (x === 8) return 8;
  if (x === 9) return 9;
  if (x === 10) return 10;
  return 0;
}`;
  const s = computeComplexity(body);
  assert.ok(s.decisions >= 10, `expected >= 10 decisions got ${s.decisions}`);
  assert.notEqual(s.bucket, 'low', `branchy file should not be low, got ${s.bucket}`);
});

test('computeComplexity: deeply nested file lifts the score via nesting axis', () => {
  // Build a body with 8 nested blocks but only 1 decision -- the nesting
  // axis should still push it past low.
  const inner = 'console.log(1);';
  const wrapped = 'if (a) { if (b) { if (c) { if (d) { if (e) { if (f) { if (g) { if (h) { ' + inner + ' } } } } } } } }';
  const s = computeComplexity(wrapped);
  assert.ok(s.maxNesting >= 8, `expected nesting >= 8 got ${s.maxNesting}`);
  assert.notEqual(s.bucket, 'low');
});

test('computeComplexity: comments + strings do NOT inflate the score', () => {
  const noisy = `
// if (a) { if (b) { if (c) {
/* if (d) for (;;) while (true) */
const msg = "if (x) for (y) while (z) && || ?? ?:";
const tmpl = \`if (a) for (b) while (c)\`;
export const x = 1;
`;
  const s = computeComplexity(noisy);
  assert.equal(s.decisions, 0, `expected 0 decisions from a noisy comment file, got ${s.decisions}`);
});

test('computeComplexity: counts function declarations + arrows', () => {
  const body = `
function a() {}
function b(x) {}
const c = function() {};
const d = (x) => x;
const e = x => x;
class K {
  method() {}
  static other() {}
}
`;
  const s = computeComplexity(body);
  assert.ok(s.functions >= 4, `expected >= 4 functions detected, got ${s.functions}`);
});

test('computeComplexity: logicalLines excludes blank lines', () => {
  const body = `line1\n\n\nline2\n\n\nline3\n\n`;
  const s = computeComplexity(body);
  assert.equal(s.logicalLines, 3);
});

// ── classifyBucket ────────────────────────────────────────────────

test('classifyBucket: thresholds', () => {
  assert.equal(classifyBucket(0), 'low');
  assert.equal(classifyBucket(19), 'low');
  assert.equal(classifyBucket(20), 'medium');
  assert.equal(classifyBucket(59), 'medium');
  assert.equal(classifyBucket(60), 'high');
  assert.equal(classifyBucket(149), 'high');
  assert.equal(classifyBucket(150), 'extreme');
  assert.equal(classifyBucket(1000), 'extreme');
});

// ── badgeFor ──────────────────────────────────────────────────────

test('badgeFor: low has empty badge', () => {
  assert.equal(badgeFor('low'), '');
});

test('badgeFor: medium / high / extreme have single letter badges', () => {
  assert.equal(badgeFor('medium'), 'M');
  assert.equal(badgeFor('high'), 'H');
  assert.equal(badgeFor('extreme'), 'X');
});

// ── describeComplexity ────────────────────────────────────────────

test('describeComplexity: capitalises bucket and includes score', () => {
  const out = describeComplexity({
    score: 42, bucket: 'medium', decisions: 5, maxNesting: 2, logicalLines: 30, functions: 4,
  });
  assert.ok(out.includes('Medium'));
  assert.ok(out.includes('42'));
});

// ── buildComplexityTooltip ────────────────────────────────────────

test('buildComplexityTooltip: includes per-axis breakdown', () => {
  const out = buildComplexityTooltip({
    score: 42, bucket: 'medium', decisions: 5, maxNesting: 2, logicalLines: 30, functions: 4,
  });
  assert.ok(out.includes('5 decision points'));
  assert.ok(out.includes('max nesting depth: 2'));
  assert.ok(out.includes('30 logical lines'));
  assert.ok(out.includes('4 functions'));
});

test('buildComplexityTooltip: high/extreme suggests splitting', () => {
  const high = buildComplexityTooltip({
    score: 200, bucket: 'extreme', decisions: 80, maxNesting: 10, logicalLines: 500, functions: 30,
  });
  assert.ok(high.toLowerCase().includes('split'));
});

test('buildComplexityTooltip: low/medium do not suggest splitting', () => {
  const low = buildComplexityTooltip({
    score: 5, bucket: 'low', decisions: 1, maxNesting: 1, logicalLines: 5, functions: 1,
  });
  assert.ok(!low.toLowerCase().includes('split'));
});

// ── stripCommentsAndStrings ───────────────────────────────────────

test('stripCommentsAndStrings: removes // line comments', () => {
  const out = stripCommentsAndStrings('// keep nothing\nkeep this');
  assert.ok(!out.includes('keep nothing'));
  assert.ok(out.includes('keep this'));
});

test('stripCommentsAndStrings: removes /* block */ comments', () => {
  const out = stripCommentsAndStrings('/* hidden */ visible');
  assert.ok(!out.includes('hidden'));
  assert.ok(out.includes('visible'));
});

test('stripCommentsAndStrings: removes single-quote strings', () => {
  const out = stripCommentsAndStrings("const x = 'remove me'; export {};");
  assert.ok(!out.includes('remove me'));
  assert.ok(out.includes('const x'));
});

test('stripCommentsAndStrings: removes double-quote strings', () => {
  const out = stripCommentsAndStrings('const x = "remove me"; export {};');
  assert.ok(!out.includes('remove me'));
});

test('stripCommentsAndStrings: removes backtick template literals', () => {
  const out = stripCommentsAndStrings('const x = `remove me too`; export {};');
  assert.ok(!out.includes('remove me too'));
});

test('stripCommentsAndStrings: preserves line numbers (newlines kept)', () => {
  const body = 'line1\n/* multi\nline */\nline4';
  const out = stripCommentsAndStrings(body);
  assert.equal(out.split('\n').length, body.split('\n').length);
});

test('stripCommentsAndStrings: handles escape sequences in strings', () => {
  const out = stripCommentsAndStrings('const x = "ab\\"cd"; export {};');
  // The string body should be blanked; the export should remain.
  assert.ok(!out.includes('cd'));
  assert.ok(out.includes('const x'));
  assert.ok(out.includes('export'));
});

// ── isAnalysableFile ──────────────────────────────────────────────

test('isAnalysableFile: accepts common source extensions', () => {
  ['x.ts', 'a/b.tsx', 'x.js', 'a/b.py', 'lib/x.go', 'x.rs', 'x.java'].forEach(p =>
    assert.equal(isAnalysableFile(p), true, p),
  );
});

test('isAnalysableFile: rejects non-source files', () => {
  ['x.json', 'x.md', 'x.png', 'x.lock', 'x.yml'].forEach(p =>
    assert.equal(isAnalysableFile(p), false, p),
  );
});

test('isAnalysableFile: rejects build / vendor paths', () => {
  [
    'node_modules/foo/bar.ts',
    'dist/out.js',
    'build/main.js',
    'out/extension.js',
    'coverage/lcov.info',
    '.git/HEAD',
  ].forEach(p => assert.equal(isAnalysableFile(p), false, p));
});

test('isAnalysableFile: empty input is rejected', () => {
  assert.equal(isAnalysableFile(''), false);
});
