/**
 * Diff-view pure-helper tests (W7).
 *
 * Imports the DOM-free helpers from diffFormat.ts (diffView.ts pulls DOM
 * deps Node can't resolve at test time).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { gutterFor, signFor, diffHeaderStat } from './diffFormat.ts';

test('gutterFor shows numbers and blanks the absent side', () => {
  assert.deepEqual(gutterFor({ kind: 'context', text: 'x', oldLine: 3, newLine: 5 }), { old: '3', new: '5' });
  assert.deepEqual(gutterFor({ kind: 'add', text: 'x', oldLine: null, newLine: 7 }), { old: '', new: '7' });
  assert.deepEqual(gutterFor({ kind: 'del', text: 'x', oldLine: 4, newLine: null }), { old: '4', new: '' });
});

test('signFor returns +/-/space by line kind', () => {
  assert.equal(signFor({ kind: 'add', text: '', oldLine: null, newLine: 1 }), '+');
  assert.equal(signFor({ kind: 'del', text: '', oldLine: 1, newLine: null }), '-');
  assert.equal(signFor({ kind: 'context', text: '', oldLine: 1, newLine: 1 }), ' ');
});

test('diffHeaderStat summarises additions/deletions/binary', () => {
  assert.equal(
    diffHeaderStat({ path: 'x', oldPath: 'x', status: 'modified', binary: false, hunks: [], additions: 3, deletions: 1 }),
    '+3 -1',
  );
  assert.equal(
    diffHeaderStat({ path: 'x', oldPath: 'x', status: 'added', binary: false, hunks: [], additions: 5, deletions: 0 }),
    '+5',
  );
  assert.equal(
    diffHeaderStat({ path: 'x', oldPath: 'x', status: 'added', binary: true, hunks: [], additions: 0, deletions: 0 }),
    'binary',
  );
  assert.equal(
    diffHeaderStat({ path: 'x', oldPath: 'x', status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 }),
    'no changes',
  );
});
