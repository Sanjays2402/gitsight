import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckoutReflog, isDetachedSha, ageLabel } from '../../src/git/recentBranches';

const FIXTURE = [
  'abc1234 HEAD@{2026-06-20T12:30:45-07:00}: checkout: moving from feature/x to main',
  'def5678 HEAD@{2026-06-20T12:25:10-07:00}: checkout: moving from main to feature/x',
  '9876543 HEAD@{2026-06-20T11:55:00-07:00}: checkout: moving from feature/x to feature/y',
  '1234567 HEAD@{2026-06-20T10:00:00-07:00}: checkout: moving from feature/y to main',
  // Detached-HEAD landing — should be filtered out
  'aaaaaaa HEAD@{2026-06-20T09:50:00-07:00}: checkout: moving from main to 0123456789abcdef0123456789abcdef01234567',
  // Non-matching line
  'zzzzzzz HEAD@{2026-06-20T09:00:00-07:00}: rebase finished: returning to refs/heads/main',
  // Another to main (will bump main's count)
  '2222222 HEAD@{2026-06-20T08:00:00-07:00}: checkout: moving from feature/z to main',
].join('\n');

test('parseCheckoutReflog: dedupes, preserves order, counts hits', () => {
  const out = parseCheckoutReflog(FIXTURE);
  // Newest-first order, deduped: main, feature/x, feature/y
  assert.deepEqual(out.map(e => e.name), ['main', 'feature/x', 'feature/y']);
  assert.equal(out[0].count, 3); // main: 12:30, 10:00, 08:00
  assert.equal(out[1].count, 1);
  assert.equal(out[2].count, 1);
  // Newest timestamp wins for `main`
  assert.equal(out[0].lastCheckoutIso, '2026-06-20T12:30:45-07:00');
});

test('parseCheckoutReflog: excludeCurrent omits the active branch', () => {
  const out = parseCheckoutReflog(FIXTURE, { excludeCurrent: 'main' });
  assert.deepEqual(out.map(e => e.name), ['feature/x', 'feature/y']);
});

test('parseCheckoutReflog: limit caps unique entries', () => {
  // Reflog output is newest-first; the picker should honour that.
  const wide = [
    'e HEAD@{2026-06-20T05:00:00-07:00}: checkout: moving from d to e',
    'd HEAD@{2026-06-20T04:00:00-07:00}: checkout: moving from c to d',
    'c HEAD@{2026-06-20T03:00:00-07:00}: checkout: moving from b to c',
    'b HEAD@{2026-06-20T02:00:00-07:00}: checkout: moving from a to b',
    'a HEAD@{2026-06-20T01:00:00-07:00}: checkout: moving from x to a',
  ].join('\n');
  const out = parseCheckoutReflog(wide, { limit: 3 });
  assert.equal(out.length, 3);
  // Newest-first: e, d, c — `a` and `b` are older and capped out.
  assert.deepEqual(out.map(e => e.name), ['e', 'd', 'c']);
});

test('parseCheckoutReflog: empty input returns empty array', () => {
  assert.deepEqual(parseCheckoutReflog(''), []);
});

test('parseCheckoutReflog: handles branches with slashes, dots, dashes', () => {
  const fixture = [
    'b HEAD@{2026-06-20T02:00:00-07:00}: checkout: moving from release/v1.2.3-rc.1 to bugfix/SAN-1234_oops',
    'a HEAD@{2026-06-20T01:00:00-07:00}: checkout: moving from main to release/v1.2.3-rc.1',
  ].join('\n');
  const out = parseCheckoutReflog(fixture);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'bugfix/SAN-1234_oops');
  assert.equal(out[1].name, 'release/v1.2.3-rc.1');
});

test('isDetachedSha: 40-char hex only', () => {
  assert.equal(isDetachedSha('0123456789abcdef0123456789abcdef01234567'), true);
  assert.equal(isDetachedSha('0123456789abcdef'), false); // too short
  assert.equal(isDetachedSha('main'), false);
  assert.equal(isDetachedSha('feature/0123456789abcdef0123456789abcdef01234567'), false);
});

test('ageLabel: graduated units across thresholds', () => {
  const now = Date.parse('2026-06-20T12:00:00Z');
  assert.equal(ageLabel('2026-06-20T11:59:30Z', now), '30s');
  assert.equal(ageLabel('2026-06-20T11:55:00Z', now), '5m');
  assert.equal(ageLabel('2026-06-20T09:00:00Z', now), '3h');
  assert.equal(ageLabel('2026-06-17T12:00:00Z', now), '3d');
  assert.equal(ageLabel('2026-06-06T12:00:00Z', now), '2w');
  assert.equal(ageLabel('2026-04-20T12:00:00Z', now), '2mo');
  assert.equal(ageLabel('2024-06-20T12:00:00Z', now), '2y');
});

test('ageLabel: bad input returns empty string', () => {
  assert.equal(ageLabel('not-a-date'), '');
});
