/**
 * Activity day drill-down pure-helper tests (W22).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { formatDayHeading, commitCountLabel, dayAuthorTally } from './dayFormat.ts';

test('formatDayHeading renders a full human date (UTC-stable)', () => {
  assert.equal(formatDayHeading('2026-06-25'), 'Thursday, June 25, 2026');
  assert.equal(formatDayHeading('2026-01-01'), 'Thursday, January 1, 2026');
  assert.equal(formatDayHeading('2025-12-31'), 'Wednesday, December 31, 2025');
});

test('formatDayHeading passes through malformed keys', () => {
  assert.equal(formatDayHeading('nope'), 'nope');
  assert.equal(formatDayHeading(''), '');
  assert.equal(formatDayHeading('2026-13-40'), '2026-13-40');
});

test('commitCountLabel pluralises', () => {
  assert.equal(commitCountLabel(0), '0 commits');
  assert.equal(commitCountLabel(1), '1 commit');
  assert.equal(commitCountLabel(7), '7 commits');
  assert.equal(commitCountLabel(-3), '0 commits');
});

test('dayAuthorTally folds by email, busiest first (first-seen name wins)', () => {
  // Git emits newest-first, so the first spelling seen is the newest.
  const tally = dayAuthorTally([
    { author: 'Ada', email: 'ada@x.io' },
    { author: 'Ada Lovelace', email: 'ada@x.io' },
    { author: 'Bjarne', email: 'b@y.io' },
    { author: 'Ada', email: 'ada@x.io' },
  ]);
  assert.equal(tally.length, 2);
  assert.deepEqual(tally[0], { name: 'Ada', count: 3 });
  assert.deepEqual(tally[1], { name: 'Bjarne', count: 1 });
});

test('dayAuthorTally falls back to name when email is missing', () => {
  const tally = dayAuthorTally([{ author: 'Solo' }, { author: 'Solo' }]);
  assert.deepEqual(tally, [{ name: 'Solo', count: 2 }]);
});

test('dayAuthorTally breaks ties alphabetically', () => {
  const tally = dayAuthorTally([
    { author: 'Zed', email: 'z@x' },
    { author: 'Amy', email: 'a@x' },
  ]);
  assert.deepEqual(tally.map(t => t.name), ['Amy', 'Zed']);
});
