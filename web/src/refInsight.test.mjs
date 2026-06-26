/**
 * Ref-detail insight tests (W29).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  indexNodes,
  reachableFrom,
  aheadBehind,
  buildRefInsight,
  aheadBehindLabel,
} from './refInsight.ts';

// A small linear+branch graph (newest-first), shas as letters:
//   main:    m2 -> m1 -> r0
//   feature: f2 -> f1 -> r0  (diverged from r0)
const COMMITS = [
  { sha: 'm2', shortSha: 'm2', parents: ['m1'], author: 'A', date: '2026-06-03', subject: 'm2' },
  { sha: 'f2', shortSha: 'f2', parents: ['f1'], author: 'B', date: '2026-06-02', subject: 'f2' },
  { sha: 'm1', shortSha: 'm1', parents: ['r0'], author: 'A', date: '2026-06-01', subject: 'm1' },
  { sha: 'f1', shortSha: 'f1', parents: ['r0'], author: 'B', date: '2026-05-31', subject: 'f1' },
  { sha: 'r0', shortSha: 'r0', parents: [], author: 'A', date: '2026-05-30', subject: 'root' },
];

// ── reachableFrom ────────────────────────────────────────────────────

test('reachableFrom walks parents to the root', () => {
  const nodes = indexNodes(COMMITS);
  const { set, truncated } = reachableFrom('m2', nodes);
  assert.deepEqual([...set].sort(), ['m1', 'm2', 'r0']);
  assert.equal(truncated, false);
});

test('reachableFrom flags truncation when a parent is off the window', () => {
  const nodes = indexNodes([{ sha: 'x1', parents: ['gone'] }]);
  const { set, truncated } = reachableFrom('x1', nodes);
  assert.deepEqual([...set], ['x1']);
  assert.equal(truncated, true);
});

test('reachableFrom on a missing start sha is truncated + empty', () => {
  const nodes = indexNodes(COMMITS);
  const { set, truncated } = reachableFrom('nope', nodes);
  assert.equal(set.size, 0);
  assert.equal(truncated, true);
});

// ── aheadBehind ──────────────────────────────────────────────────────

test('aheadBehind counts the symmetric difference (feature vs main)', () => {
  const nodes = indexNodes(COMMITS);
  // feature (f2) ahead of main (m2): f2,f1 unique; behind: m2,m1 unique.
  const r = aheadBehind('f2', 'm2', nodes);
  assert.equal(r.ahead, 2);
  assert.equal(r.behind, 2);
  assert.equal(r.exact, true);
});

test('aheadBehind is zero for the same tip', () => {
  const nodes = indexNodes(COMMITS);
  assert.deepEqual(aheadBehind('m2', 'm2', nodes), { ahead: 0, behind: 0, exact: true });
});

test('aheadBehind: a fast-forward-only ref is ahead, zero behind', () => {
  const nodes = indexNodes(COMMITS);
  // m2 vs m1: m2 has m2 extra; m1 has nothing extra.
  const r = aheadBehind('m2', 'm1', nodes);
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 0);
});

test('aheadBehind marks inexact when a walk is truncated', () => {
  const nodes = indexNodes([
    { sha: 'a1', parents: ['missing'] },
    { sha: 'b1', parents: [] },
  ]);
  const r = aheadBehind('a1', 'b1', nodes);
  assert.equal(r.exact, false);
});

// ── buildRefInsight ──────────────────────────────────────────────────

test('buildRefInsight returns the tip commit identity + ahead/behind', () => {
  const insight = buildRefInsight(COMMITS, 'f2', 'm2');
  assert.equal(insight.tip.subject, 'f2');
  assert.equal(insight.tip.author, 'B');
  assert.equal(insight.ahead, 2);
  assert.equal(insight.behind, 2);
  assert.equal(insight.exact, true);
});

test('buildRefInsight yields a null tip when the sha is off the window', () => {
  const insight = buildRefInsight(COMMITS, 'ghost', 'm2');
  assert.equal(insight.tip, null);
});

// ── aheadBehindLabel ─────────────────────────────────────────────────

test('aheadBehindLabel summarises both sides, trimming zeros', () => {
  assert.equal(aheadBehindLabel({ tip: null, ahead: 2, behind: 3, exact: true }), '2 ahead, 3 behind');
  assert.equal(aheadBehindLabel({ tip: null, ahead: 1, behind: 0, exact: true }), '1 ahead');
  assert.equal(aheadBehindLabel({ tip: null, ahead: 0, behind: 0, exact: true }), 'up to date with HEAD');
});

test('aheadBehindLabel marks an inexact count with ~', () => {
  assert.equal(aheadBehindLabel({ tip: null, ahead: 5, behind: 0, exact: false }), '~5 ahead');
});
