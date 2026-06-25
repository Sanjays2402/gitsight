/**
 * Virtual-window pure-helper tests (W16).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  computeWindow,
  windowChanged,
  scrollToReveal,
  VIRTUAL_THRESHOLD,
  DEFAULT_OVERSCAN,
} from './virtual.ts';

test('computeWindow at the top mounts the first rows plus overscan', () => {
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 30, total: 500 });
  assert.equal(w.start, 0);
  // 300/30 = 10 visible + 1 partial + 6 overscan = 17.
  assert.equal(w.end, 17);
  assert.equal(w.offsetTop, 0);
  assert.equal(w.totalHeight, 500 * 30);
});

test('computeWindow mid-scroll centres the window with overscan on both edges', () => {
  const w = computeWindow({ scrollTop: 3000, viewportHeight: 300, rowHeight: 30, total: 500 });
  // firstVisible = 3000/30 = 100; start = 100 - 6 = 94.
  assert.equal(w.start, 94);
  // end = 100 + (10+1) + 6 = 117.
  assert.equal(w.end, 117);
  assert.equal(w.offsetTop, 94 * 30);
});

test('computeWindow clamps the end to the list length near the bottom', () => {
  const w = computeWindow({ scrollTop: 14700, viewportHeight: 300, rowHeight: 30, total: 500 });
  // firstVisible = 490; end would be 490+11+6 = 507 -> clamped to 500.
  assert.equal(w.end, 500);
  assert.ok(w.start < w.end);
});

test('computeWindow handles an empty list', () => {
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 30, total: 0 });
  assert.deepEqual(w, { start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
});

test('computeWindow clamps an over-scrolled offset to the list height', () => {
  const w = computeWindow({ scrollTop: 999999, viewportHeight: 300, rowHeight: 30, total: 40 });
  // scrollTop clamps to total*rowHeight; end never exceeds total.
  assert.equal(w.end, 40);
  assert.ok(w.start <= 40);
});

test('computeWindow coerces a zero/garbage rowHeight to a safe minimum', () => {
  const w = computeWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 0, total: 10 });
  assert.equal(w.totalHeight, 10); // rowHeight coerced to 1
  assert.ok(w.end >= 1);
});

test('computeWindow respects a custom overscan', () => {
  const w = computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 30, total: 500, overscan: 0 });
  assert.equal(w.start, 0);
  assert.equal(w.end, 11); // 10 visible + 1 partial, no overscan
});

test('windowChanged detects a start/end shift but ignores offset-only changes', () => {
  const a = { start: 10, end: 30, offsetTop: 300, totalHeight: 9000 };
  assert.equal(windowChanged(a, { ...a }), false);
  assert.equal(windowChanged(a, { ...a, start: 11 }), true);
  assert.equal(windowChanged(a, { ...a, end: 31 }), true);
});

test('scrollToReveal scrolls up to a row above the viewport', () => {
  // Row 2 at top=60; viewport starts at 300 -> scroll to 60.
  assert.equal(scrollToReveal(2, 300, 300, 30, 500), 60);
});

test('scrollToReveal scrolls down the minimum to reveal a row below', () => {
  // Row 20 bottom = 21*30 = 630; viewport 300 tall -> scrollTop = 630-300 = 330.
  assert.equal(scrollToReveal(20, 0, 300, 30, 500), 330);
});

test('scrollToReveal leaves an already-visible row untouched', () => {
  // Row 5 (150..180) inside viewport 100..400 -> unchanged.
  assert.equal(scrollToReveal(5, 100, 300, 30, 500), 100);
});

test('scrollToReveal clamps an out-of-range index', () => {
  assert.equal(scrollToReveal(9999, 0, 300, 30, 10), Math.max(0, 10 * 30 - 300));
  assert.equal(scrollToReveal(-5, 120, 300, 30, 10), 0);
});

test('exported tuning constants are sane', () => {
  assert.ok(VIRTUAL_THRESHOLD > 0);
  assert.ok(DEFAULT_OVERSCAN >= 0);
});
