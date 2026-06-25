/**
 * Blame-heatmap pure-helper tests (W12).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  heatColor,
  relativeAgeFromUnix,
  blameSummary,
} from './blameFormat.ts';

test('heatColor runs hot (red) for newest and cold (blue) for oldest', () => {
  assert.equal(heatColor(1), 'hsl(0, 70%, 50%)');
  assert.equal(heatColor(0), 'hsl(220, 70%, 50%)');
  assert.equal(heatColor(0.5), 'hsl(110, 70%, 50%)');
});

test('heatColor clamps out-of-range input', () => {
  assert.equal(heatColor(5), 'hsl(0, 70%, 50%)');
  assert.equal(heatColor(-2), 'hsl(220, 70%, 50%)');
});

test('relativeAgeFromUnix renders compact ages', () => {
  const now = 1_000_000_000_000; // fixed ms
  const nowSec = now / 1000;
  assert.equal(relativeAgeFromUnix(nowSec - 30, now), '30s');
  assert.equal(relativeAgeFromUnix(nowSec - 120, now), '2m');
  assert.equal(relativeAgeFromUnix(nowSec - 7200, now), '2h');
  assert.equal(relativeAgeFromUnix(nowSec - 3 * 86400, now), '3d');
  assert.equal(relativeAgeFromUnix(nowSec - 90 * 86400, now), '3mo');
  assert.equal(relativeAgeFromUnix(nowSec - 800 * 86400, now), '2y');
});

test('relativeAgeFromUnix handles zero / future', () => {
  assert.equal(relativeAgeFromUnix(0), '');
  assert.equal(relativeAgeFromUnix(2_000_000_000, 1_000_000_000_000 - 1), 'now');
});

test('blameSummary pluralises lines and authors', () => {
  assert.equal(blameSummary(1, 1), '1 line \u00b7 1 author');
  assert.equal(blameSummary(248, 4), '248 lines \u00b7 4 authors');
});
