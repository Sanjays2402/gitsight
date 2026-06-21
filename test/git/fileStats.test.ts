import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { summariseFileStats, spanBetween, formatStats } from '../../src/git/fileStats';

test('summariseFileStats: counts commits, contributors, first/last dates', () => {
  const out = [
    '2026-06-19T10:00:00Z\tAlice',
    '2026-06-15T10:00:00Z\tBob',
    '2026-01-01T10:00:00Z\tAlice',
    '2025-06-01T10:00:00Z\tAlice',
  ].join('\n');
  const s = summariseFileStats(out);
  assert.equal(s.totalCommits, 4);
  assert.equal(s.contributors, 2);
  assert.equal(s.topContributor, 'Alice');
  assert.equal(s.firstCommit?.toISOString(), '2025-06-01T10:00:00.000Z');
  assert.equal(s.lastCommit?.toISOString(), '2026-06-19T10:00:00.000Z');
});

test('summariseFileStats: empty output → zeros', () => {
  const s = summariseFileStats('');
  assert.equal(s.totalCommits, 0);
  assert.equal(s.contributors, 0);
  assert.equal(s.firstCommit, undefined);
  assert.equal(s.spanText, '');
});

test('summariseFileStats: skips malformed lines', () => {
  const out = [
    'not-a-date\tnobody',
    '2026-06-19T10:00:00Z\tAlice',
    'orphan-without-tab',
  ].join('\n');
  const s = summariseFileStats(out);
  assert.equal(s.totalCommits, 1);
  assert.equal(s.topContributor, 'Alice');
});

test('spanBetween: human-readable span buckets', () => {
  const day = 86_400_000;
  assert.equal(spanBetween(new Date(0), new Date(0)), '<1d');
  assert.equal(spanBetween(new Date(0), new Date(day * 5)), '5d');
  assert.equal(spanBetween(new Date(0), new Date(day * 60)), '2mo');
  assert.equal(spanBetween(new Date(0), new Date(day * 365 * 3)), '3y');
});

test('spanBetween: undefined inputs → empty string', () => {
  assert.equal(spanBetween(undefined, new Date()), '');
  assert.equal(spanBetween(new Date(), undefined), '');
});

test('formatStats: composes labels correctly', () => {
  const single = formatStats({
    totalCommits: 1, contributors: 1, spanText: '<1d', topContributor: 'Cake',
  });
  assert.equal(single, '1 commit  ·  <1d of history  ·  by Cake');

  const many = formatStats({
    totalCommits: 42, contributors: 3, spanText: '18mo', topContributor: 'Alice',
  });
  assert.equal(many, '42 commits  ·  18mo of history  ·  3 contributors');

  const noSpan = formatStats({ totalCommits: 0, contributors: 0, spanText: '' });
  assert.equal(noSpan, '0 commits');
});
