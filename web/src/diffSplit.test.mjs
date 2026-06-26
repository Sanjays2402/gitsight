/**
 * Side-by-side diff pairing tests (W38).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { splitHunkRows, splitRowCount } from './diffSplit.ts';

const ctx = (text, oldLine, newLine) => ({ kind: 'context', text, oldLine, newLine });
const del = (text, oldLine) => ({ kind: 'del', text, oldLine, newLine: null });
const add = (text, newLine) => ({ kind: 'add', text, oldLine: null, newLine });

test('context lines map to a both-sides row', () => {
  const rows = splitHunkRows([ctx('a', 1, 1), ctx('b', 2, 2)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].old.text, 'a');
  assert.equal(rows[0].new.text, 'a');
  assert.equal(rows[0].paired, false);
});

test('a balanced del/add run zips into paired rows', () => {
  const rows = splitHunkRows([del('old1', 1), del('old2', 2), add('new1', 1), add('new2', 2)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].old.text, 'old1');
  assert.equal(rows[0].new.text, 'new1');
  assert.equal(rows[0].paired, true);
  assert.equal(rows[1].old.text, 'old2');
  assert.equal(rows[1].new.text, 'new2');
  assert.equal(rows[1].paired, true);
});

test('more deletions than additions leaves old-only rows', () => {
  const rows = splitHunkRows([del('d1', 1), del('d2', 2), del('d3', 3), add('a1', 1)]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].paired, true);
  assert.equal(rows[1].old.text, 'd2');
  assert.equal(rows[1].new, null);
  assert.equal(rows[1].paired, false);
  assert.equal(rows[2].old.text, 'd3');
  assert.equal(rows[2].new, null);
});

test('more additions than deletions leaves new-only rows', () => {
  const rows = splitHunkRows([del('d1', 1), add('a1', 1), add('a2', 2)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].paired, true);
  assert.equal(rows[1].old, null);
  assert.equal(rows[1].new.text, 'a2');
});

test('a pure insertion (no preceding deletion) yields new-only rows', () => {
  const rows = splitHunkRows([ctx('a', 1, 1), add('a1', 2), add('a2', 3)]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].old, null);
  assert.equal(rows[1].new.text, 'a1');
  assert.equal(rows[2].old, null);
  assert.equal(rows[2].new.text, 'a2');
});

test('a pure deletion yields old-only rows', () => {
  const rows = splitHunkRows([del('d1', 1), del('d2', 2), ctx('c', 3, 1)]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].old.text, 'd1');
  assert.equal(rows[0].new, null);
  assert.equal(rows[2].paired, false);
  assert.equal(rows[2].old.text, 'c');
});

test('every input line appears exactly once across rows', () => {
  const lines = [ctx('a', 1, 1), del('d', 2), add('x', 2), add('y', 3), ctx('b', 3, 4)];
  const rows = splitHunkRows(lines);
  const seen = new Set();
  for (const r of rows) {
    if (r.old) seen.add(r.old);
    if (r.new) seen.add(r.new);
  }
  assert.equal(seen.size, lines.length);
});

test('splitRowCount matches splitHunkRows length', () => {
  const lines = [del('d1', 1), del('d2', 2), add('a1', 1), ctx('c', 3, 2)];
  assert.equal(splitRowCount(lines), splitHunkRows(lines).length);
});

test('empty input yields no rows', () => {
  assert.deepEqual(splitHunkRows([]), []);
  assert.equal(splitRowCount([]), 0);
});
