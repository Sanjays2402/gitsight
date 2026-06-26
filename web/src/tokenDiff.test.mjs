/**
 * Word-level intra-line diff tests (W34).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  tokenize,
  inlineDiff,
  pairSimilarity,
  shouldInlineDiff,
  INLINE_DIFF_THRESHOLD,
} from './tokenDiff.ts';

// ── tokenize ─────────────────────────────────────────────────────────

test('tokenize round-trips: joined tokens equal the input', () => {
  for (const s of ['const x = 1;', '  spaced  out ', 'a.b.c()', '', 'café_$id']) {
    assert.equal(tokenize(s).join(''), s);
  }
});

test('tokenize keeps identifiers (with _ and $) whole', () => {
  assert.deepEqual(tokenize('foo_bar $x'), ['foo_bar', ' ', '$x']);
});

test('tokenize splits punctuation into single tokens', () => {
  assert.deepEqual(tokenize('a.b'), ['a', '.', 'b']);
  assert.deepEqual(tokenize('x=1'), ['x', '=', '1']);
});

// ── inlineDiff ───────────────────────────────────────────────────────

test('inlineDiff marks only the changed token in a one-word edit', () => {
  const d = inlineDiff('const x = 1;', 'const x = 2;');
  // The shared prefix/suffix is unchanged; only "1" vs "2" changed.
  const oldChanged = d.old.filter(s => s.changed).map(s => s.text);
  const newChanged = d.new.filter(s => s.changed).map(s => s.text);
  assert.deepEqual(oldChanged, ['1']);
  assert.deepEqual(newChanged, ['2']);
});

test('inlineDiff segments round-trip to the original lines', () => {
  const a = 'return foo(bar, baz);';
  const b = 'return foo(qux, baz);';
  const d = inlineDiff(a, b);
  assert.equal(d.old.map(s => s.text).join(''), a);
  assert.equal(d.new.map(s => s.text).join(''), b);
});

test('inlineDiff coalesces adjacent same-state tokens', () => {
  const d = inlineDiff('aaa bbb ccc', 'aaa zzz ccc');
  // Unchanged "aaa " ... " ccc" should each be a single segment.
  assert.equal(d.old.filter(s => !s.changed).length, 2);
  // The changed middle is one segment per side.
  assert.deepEqual(d.old.filter(s => s.changed).map(s => s.text), ['bbb']);
  assert.deepEqual(d.new.filter(s => s.changed).map(s => s.text), ['zzz']);
});

test('inlineDiff handles a pure insertion (old is a subset)', () => {
  const d = inlineDiff('foo()', 'foo(bar)');
  // Everything in old is shared, so nothing on the old side is changed.
  assert.equal(d.old.every(s => !s.changed), true);
  // "bar" is the only added token on the new side.
  assert.deepEqual(d.new.filter(s => s.changed).map(s => s.text), ['bar']);
});

test('inlineDiff on empty lines yields empty segment lists', () => {
  const d = inlineDiff('', '');
  assert.deepEqual(d.old, []);
  assert.deepEqual(d.new, []);
});

// ── pairSimilarity + shouldInlineDiff ────────────────────────────────

test('pairSimilarity is 1 for identical content and high for small edits', () => {
  assert.equal(pairSimilarity('a b c', 'a b c'), 1);
  assert.ok(pairSimilarity('const x = 1;', 'const x = 2;') > 0.7);
});

test('pairSimilarity is 0 when one side has no word tokens', () => {
  assert.equal(pairSimilarity('   ', 'hello'), 0);
});

test('pairSimilarity ignores whitespace-only differences in the denominator', () => {
  // Same words, different spacing -> all words shared -> similarity 1.
  assert.equal(pairSimilarity('a  b', 'a b'), 1);
});

test('shouldInlineDiff is true for a close pair, false for unrelated lines', () => {
  assert.equal(shouldInlineDiff('const x = 1;', 'const x = 2;'), true);
  assert.equal(shouldInlineDiff('import a from "a";', 'export const z = 9;'), false);
});

test('shouldInlineDiff is false for identical or blank-vs-text pairs', () => {
  assert.equal(shouldInlineDiff('same', 'same'), false);
  assert.equal(shouldInlineDiff('', 'text'), false);
  assert.equal(shouldInlineDiff('text', '   '), false);
});

test('INLINE_DIFF_THRESHOLD is a sane fraction', () => {
  assert.ok(INLINE_DIFF_THRESHOLD > 0 && INLINE_DIFF_THRESHOLD < 1);
});
