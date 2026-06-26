/**
 * Command-palette fuzzy-search tests (W26).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  fuzzyMatch,
  rankItems,
  isWordStart,
  highlightRuns,
} from './paletteSearch.ts';

// ── fuzzyMatch ───────────────────────────────────────────────────────

test('fuzzyMatch returns positions for a subsequence match', () => {
  const m = fuzzyMatch('grp', 'Graph');
  assert.ok(m);
  // g(0) r(1) ... p(3)
  assert.deepEqual(m.positions, [0, 1, 3]);
});

test('fuzzyMatch is case-insensitive', () => {
  assert.ok(fuzzyMatch('GIT', 'gitsight'));
  assert.ok(fuzzyMatch('git', 'GITSIGHT'));
});

test('fuzzyMatch returns null when not a subsequence', () => {
  assert.equal(fuzzyMatch('xyz', 'Graph'), null);
  assert.equal(fuzzyMatch('zz', 'z'), null); // too long
});

test('fuzzyMatch on empty query is a zero-score match', () => {
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
});

test('fuzzyMatch scores a contiguous prefix higher than a scattered hit', () => {
  const tight = fuzzyMatch('com', 'Compare');
  const loose = fuzzyMatch('com', 'Contributors menu'); // C..o..m scattered
  assert.ok(tight);
  assert.ok(loose);
  assert.ok(tight.score > loose.score, `tight ${tight.score} > loose ${loose.score}`);
});

test('fuzzyMatch rewards word-start matches', () => {
  // "gg" should match the two word-starts in "Go to Graph"
  const m = fuzzyMatch('gg', 'Go to Graph');
  assert.ok(m);
  assert.deepEqual(m.positions, [0, 6]);
});

// ── isWordStart ──────────────────────────────────────────────────────

test('isWordStart flags index 0, post-separator, and camelCase boundaries', () => {
  assert.equal(isWordStart('Graph', 0), true);
  assert.equal(isWordStart('origin/main', 7), true); // after '/'
  assert.equal(isWordStart('open_remote', 5), true); // after '_'
  assert.equal(isWordStart('camelCase', 5), true); // l->C
  assert.equal(isWordStart('Graph', 2), false); // mid-word
});

// ── rankItems ────────────────────────────────────────────────────────

const ITEMS = [
  { id: 'v-graph', kind: 'view', label: 'Graph', value: 'graph' },
  { id: 'v-compare', kind: 'view', label: 'Compare', value: 'compare' },
  { id: 'v-contrib', kind: 'view', label: 'Contributors', value: 'contributors' },
  { id: 'r-main', kind: 'ref', label: 'main', value: 'ref:main' },
];

test('rankItems returns every item for an empty query in natural order', () => {
  const r = rankItems(ITEMS, '');
  assert.equal(r.length, 4);
  assert.deepEqual(r.map(x => x.item.id), ['v-graph', 'v-compare', 'v-contrib', 'r-main']);
});

test('rankItems drops non-matches and orders by score', () => {
  const r = rankItems(ITEMS, 'co');
  // Compare + Contributors match "co"; Graph + main do not.
  assert.deepEqual(r.map(x => x.item.label).sort(), ['Compare', 'Contributors']);
  // Compare (shorter, same prefix) should outrank Contributors.
  assert.equal(r[0].item.label, 'Compare');
});

test('rankItems uses weight then label length as tie-breakers', () => {
  const items = [
    { id: 'a', kind: 'action', label: 'Reload', value: 'a', weight: 5 },
    { id: 'b', kind: 'action', label: 'Reload', value: 'b', weight: 1 },
  ];
  const r = rankItems(items, 'reload');
  assert.deepEqual(r.map(x => x.item.id), ['b', 'a']); // lower weight first
});

test('rankItems matches a ref by its slashed name', () => {
  const items = [{ id: 'r', kind: 'ref', label: 'origin/feature', value: 'ref:origin/feature' }];
  assert.equal(rankItems(items, 'feat').length, 1);
  assert.equal(rankItems(items, 'origin').length, 1);
});

// ── highlightRuns ────────────────────────────────────────────────────

test('highlightRuns splits a label into matched + plain runs', () => {
  const runs = highlightRuns('Graph', [0, 1]);
  assert.deepEqual(runs, [
    { text: 'Gr', match: true },
    { text: 'aph', match: false },
  ]);
});

test('highlightRuns coalesces non-adjacent matches into separate runs', () => {
  const runs = highlightRuns('Compare', [0, 3]);
  assert.deepEqual(runs, [
    { text: 'C', match: true },
    { text: 'om', match: false },
    { text: 'p', match: true },
    { text: 'are', match: false },
  ]);
});

test('highlightRuns with no positions returns one plain run', () => {
  assert.deepEqual(highlightRuns('Graph', []), [{ text: 'Graph', match: false }]);
  assert.deepEqual(highlightRuns('', []), []);
});
