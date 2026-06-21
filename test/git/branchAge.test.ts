import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyAge,
  classifyBranches,
  ageDays,
  ageLabel,
  colorIdFor,
  DEFAULT_THRESHOLDS,
} from '../../src/git/branchAge';

const NOW = new Date('2026-06-20T00:00:00Z');
const branch = (lastDate?: Date) => ({
  name: 'b', current: false, remote: false, ahead: 0, behind: 0, sha: 'a', lastDate,
} as any);

test('classifyAge: buckets match default thresholds', () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  assert.equal(classifyAge(days(0), NOW), 'fresh');
  assert.equal(classifyAge(days(29), NOW), 'fresh');
  assert.equal(classifyAge(days(30), NOW), 'aging');
  assert.equal(classifyAge(days(89), NOW), 'aging');
  assert.equal(classifyAge(days(90), NOW), 'stale');
  assert.equal(classifyAge(days(364), NOW), 'stale');
  assert.equal(classifyAge(days(365), NOW), 'ancient');
});

test('classifyAge: missing date → ancient', () => {
  assert.equal(classifyAge(undefined, NOW), 'ancient');
});

test('classifyAge: future date treated as fresh', () => {
  const future = new Date(NOW.getTime() + 86_400_000);
  assert.equal(classifyAge(future, NOW), 'fresh');
});

test('classifyAge: respects custom thresholds', () => {
  const custom = { agingDays: 7, staleDays: 14, ancientDays: 60 };
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  assert.equal(classifyAge(days(6), NOW, custom), 'fresh');
  assert.equal(classifyAge(days(7), NOW, custom), 'aging');
  assert.equal(classifyAge(days(14), NOW, custom), 'stale');
  assert.equal(classifyAge(days(60), NOW, custom), 'ancient');
});

test('ageDays: integer days, ∞ for missing', () => {
  const d = new Date(NOW.getTime() - 5 * 86_400_000);
  assert.equal(ageDays(d, NOW), 5);
  assert.equal(ageDays(undefined, NOW), Infinity);
});

test('classifyBranches + ageLabel: fresh hides label, others show it', () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  const got = classifyBranches(
    [branch(days(2)), branch(days(40)), branch(days(120))],
    NOW,
  );
  assert.equal(got[0].status, 'fresh');
  assert.equal(ageLabel(got[0]), '');
  assert.equal(ageLabel(got[1]), 'aging · 40d');
  assert.equal(ageLabel(got[2]), 'stale · 120d');
});

test('colorIdFor maps each non-fresh status to a chart color', () => {
  assert.equal(colorIdFor('fresh'), undefined);
  assert.equal(colorIdFor('aging'), 'charts.yellow');
  assert.equal(colorIdFor('stale'), 'charts.orange');
  assert.equal(colorIdFor('ancient'), 'charts.red');
});

test('DEFAULT_THRESHOLDS match the documented 30/90/365 boundaries', () => {
  assert.equal(DEFAULT_THRESHOLDS.agingDays, 30);
  assert.equal(DEFAULT_THRESHOLDS.staleDays, 90);
  assert.equal(DEFAULT_THRESHOLDS.ancientDays, 365);
});
