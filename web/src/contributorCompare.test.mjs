/**
 * Contributor-compare tests (W35).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  summariseAuthor,
  fileOverlap,
  buildContributorComparison,
  overlapPercent,
  swapComparePair,
  comparePanelKeyAction,
} from './contributorCompare.ts';

const file = (path, insertions, deletions, commits = 1) => ({ path, insertions, deletions, commits });

const detail = (over) => ({
  name: 'X',
  email: 'x@y.z',
  commits: 1,
  firstDate: '',
  lastDate: '',
  sparkline: { bins: [], max: 0, total: 0, weeks: 26 },
  files: [],
  filesTouched: 0,
  ...over,
});

test('summariseAuthor totals insertions/deletions/churn from files', () => {
  const d = detail({
    name: 'Ada',
    email: 'ada@x.io',
    commits: 12,
    files: [file('a.ts', 10, 2), file('b.ts', 3, 5)],
    filesTouched: 7,
  });
  const s = summariseAuthor(d);
  assert.equal(s.name, 'Ada');
  assert.equal(s.commits, 12);
  assert.equal(s.insertions, 13);
  assert.equal(s.deletions, 7);
  assert.equal(s.churn, 20);
  assert.equal(s.files, 7); // filesTouched, not the displayed subset length
});

test('summariseAuthor treats binary (-1) churn as zero', () => {
  // numstat binary rows arrive as -1 from the aggregator; never count them.
  const s = summariseAuthor(detail({ files: [file('img.png', -1, -1)] }));
  assert.equal(s.insertions, 0);
  assert.equal(s.deletions, 0);
  assert.equal(s.churn, 0);
});

test('fileOverlap finds shared files + exclusive counts', () => {
  const a = [file('shared1.ts', 5, 1), file('shared2.ts', 2, 0), file('onlyA.ts', 9, 9)];
  const b = [file('shared1.ts', 1, 1), file('shared2.ts', 8, 8), file('onlyB1.ts', 1, 0), file('onlyB2.ts', 1, 0)];
  const o = fileOverlap(a, b);
  assert.deepEqual(o.shared.sort(), ['shared1.ts', 'shared2.ts']);
  assert.equal(o.onlyA, 1);
  assert.equal(o.onlyB, 2);
  // union = 3 + 4 - 2 = 5; jaccard = 2/5 = 0.4
  assert.equal(o.jaccard, 0.4);
});

test('fileOverlap orders shared files by combined churn', () => {
  const a = [file('low.ts', 1, 0), file('high.ts', 20, 0)];
  const b = [file('low.ts', 1, 0), file('high.ts', 30, 0)];
  const o = fileOverlap(a, b);
  // high.ts combined churn (50) > low.ts (2) -> first.
  assert.deepEqual(o.shared, ['high.ts', 'low.ts']);
});

test('fileOverlap is empty + zero jaccard when nothing is shared', () => {
  const o = fileOverlap([file('a.ts', 1, 1)], [file('b.ts', 1, 1)]);
  assert.deepEqual(o.shared, []);
  assert.equal(o.onlyA, 1);
  assert.equal(o.onlyB, 1);
  assert.equal(o.jaccard, 0);
});

test('fileOverlap handles two empty authors', () => {
  const o = fileOverlap([], []);
  assert.deepEqual(o.shared, []);
  assert.equal(o.jaccard, 0);
});

test('buildContributorComparison assembles both summaries + overlap', () => {
  const a = detail({ name: 'Ada', files: [file('x.ts', 4, 0)], filesTouched: 1, commits: 3 });
  const b = detail({ name: 'Grace', files: [file('x.ts', 2, 0), file('y.ts', 1, 0)], filesTouched: 2, commits: 5 });
  const cmp = buildContributorComparison(a, b);
  assert.equal(cmp.a.name, 'Ada');
  assert.equal(cmp.b.name, 'Grace');
  assert.deepEqual(cmp.overlap.shared, ['x.ts']);
  // union = 1 + 2 - 1 = 2; jaccard = 1/2
  assert.equal(overlapPercent(cmp.overlap), 50);
});

test('swapComparePair reverses the pair without mutating the input (W89)', () => {
  const pair = ['ada@x.z', 'grace@x.z'];
  const swapped = swapComparePair(pair);
  assert.deepEqual(swapped, ['grace@x.z', 'ada@x.z']);
  // Original untouched (fresh tuple).
  assert.deepEqual(pair, ['ada@x.z', 'grace@x.z']);
  assert.notEqual(swapped, pair);
});

test('swapComparePair is an involution and works for object pairs (W89)', () => {
  const a = { email: 'a@x.z', name: 'A' };
  const b = { email: 'b@x.z', name: 'B' };
  const once = swapComparePair([a, b]);
  assert.equal(once[0], b);
  assert.equal(once[1], a);
  // Swapping twice restores the original order (and identities).
  const twice = swapComparePair(once);
  assert.equal(twice[0], a);
  assert.equal(twice[1], b);
});

// ── Compare panel keyboard (W93) ─────────────────────────────────────

test('comparePanelKeyAction maps s to swap (either case) (W93)', () => {
  assert.equal(comparePanelKeyAction('s'), 'swap');
  assert.equal(comparePanelKeyAction('S'), 'swap');
});

test('comparePanelKeyAction maps Escape to close (W93)', () => {
  assert.equal(comparePanelKeyAction('Escape'), 'close');
});

test('comparePanelKeyAction ignores other keys (W93)', () => {
  assert.equal(comparePanelKeyAction('a'), 'none');
  assert.equal(comparePanelKeyAction('Enter'), 'none');
  assert.equal(comparePanelKeyAction(''), 'none');
  assert.equal(comparePanelKeyAction('Esc'), 'none'); // not the DOM key name
});
