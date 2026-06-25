/**
 * Compare-view pure-helper tests (W18).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  compareGlyph,
  compareLabel,
  compareChurn,
  splitComparePath,
  sanitizeRef,
} from './compareFormat.ts';

test('compareGlyph maps each status to a single letter', () => {
  assert.equal(compareGlyph('added'), 'A');
  assert.equal(compareGlyph('modified'), 'M');
  assert.equal(compareGlyph('deleted'), 'D');
  assert.equal(compareGlyph('renamed'), 'R');
  assert.equal(compareGlyph('copied'), 'C');
  assert.equal(compareGlyph('typechange'), 'T');
  assert.equal(compareGlyph('unknown'), '?');
});

test('compareLabel expands typechange but passes others through', () => {
  assert.equal(compareLabel('typechange'), 'type change');
  assert.equal(compareLabel('added'), 'added');
});

test('compareChurn formats +/-, binary, and mode-only', () => {
  assert.deepEqual(compareChurn({ insertions: 5, deletions: 2, binary: false }), {
    binary: false,
    insertions: 5,
    deletions: 2,
    text: '+5 -2',
  });
  assert.equal(compareChurn({ insertions: -1, deletions: -1, binary: true }).text, 'binary');
  assert.equal(compareChurn({ insertions: 0, deletions: 0, binary: false }).text, '0');
  assert.equal(compareChurn({ insertions: 3, deletions: 0, binary: false }).text, '+3');
});

test('splitComparePath separates dir from basename', () => {
  assert.deepEqual(splitComparePath('src/web/main.ts'), { dir: 'src/web/', name: 'main.ts' });
  assert.deepEqual(splitComparePath('README.md'), { dir: '', name: 'README.md' });
});

test('sanitizeRef accepts valid refs and rejects unsafe input', () => {
  assert.equal(sanitizeRef('  main  '), 'main');
  assert.equal(sanitizeRef('feature/foo-bar'), 'feature/foo-bar');
  assert.equal(sanitizeRef('v1.2.0'), 'v1.2.0');
  assert.equal(sanitizeRef('HEAD~3'), 'HEAD~3');
  assert.equal(sanitizeRef(''), null);
  assert.equal(sanitizeRef('   '), null);
  assert.equal(sanitizeRef('--output=x'), null);
  assert.equal(sanitizeRef('a b'), null);
  assert.equal(sanitizeRef('x'.repeat(201)), null);
});
