/**
 * Blame age-legend + author-filter tests (W40).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildAgeRamp, isAuthorDimmed, toggleAuthorFilter } from './blameLegend.ts';

test('buildAgeRamp returns evenly-spaced stops cold -> hot', () => {
  const ramp = buildAgeRamp(1000, 2000, 5);
  assert.equal(ramp.length, 5);
  assert.equal(ramp[0].heat, 0);
  assert.equal(ramp[4].heat, 1);
  // Heat ascends; unix times ascend with it.
  assert.equal(ramp[0].unixSec, 1000);
  assert.equal(ramp[4].unixSec, 2000);
  assert.equal(ramp[2].unixSec, 1500); // midpoint
  for (let i = 1; i < ramp.length; i++) {
    assert.ok(ramp[i].heat > ramp[i - 1].heat);
    assert.ok(ramp[i].unixSec >= ramp[i - 1].unixSec);
  }
});

test('buildAgeRamp clamps the stop count to at least 2', () => {
  assert.equal(buildAgeRamp(1000, 2000, 1).length, 2);
  assert.equal(buildAgeRamp(1000, 2000, 0).length, 2);
});

test('buildAgeRamp collapses a degenerate span to a single hot stop', () => {
  assert.deepEqual(buildAgeRamp(0, 0), [{ heat: 1, unixSec: 0 }]);
  assert.deepEqual(buildAgeRamp(5000, 5000), [{ heat: 1, unixSec: 5000 }]);
  // newest before oldest is also degenerate.
  assert.deepEqual(buildAgeRamp(9000, 8000), [{ heat: 1, unixSec: 8000 }]);
});

test('isAuthorDimmed dims everyone but the active author', () => {
  assert.equal(isAuthorDimmed('Ada', null), false); // no filter -> nothing dims
  assert.equal(isAuthorDimmed('Ada', 'Ada'), false);
  assert.equal(isAuthorDimmed('Grace', 'Ada'), true);
});

test('isAuthorDimmed compares case-insensitively + trimmed', () => {
  assert.equal(isAuthorDimmed('  ada  ', 'ADA'), false);
  assert.equal(isAuthorDimmed('Ada Lovelace', 'ada'), true);
});

test('toggleAuthorFilter selects, switches, and clears', () => {
  assert.equal(toggleAuthorFilter(null, 'Ada'), 'Ada'); // select
  assert.equal(toggleAuthorFilter('Ada', 'Grace'), 'Grace'); // switch
  assert.equal(toggleAuthorFilter('Ada', 'Ada'), null); // clear (same)
  assert.equal(toggleAuthorFilter('ada', 'ADA'), null); // clear (case-insensitive)
});
