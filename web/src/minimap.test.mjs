/**
 * Graph-minimap pure-helper tests (W45).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  minimapMarkY,
  minimapMarkX,
  minimapViewport,
  minimapSeekScrollTop,
  buildMinimapMarks,
  markAtY,
  MINIMAP_MIN_VIEWPORT,
  MINIMAP_THRESHOLD,
  MINIMAP_WIDTH,
} from './minimap.ts';

// ── minimapMarkY ─────────────────────────────────────────────────────

test('minimapMarkY spreads rows evenly across the track', () => {
  // 5 rows over a 100px track: first at 0, last at 100, middle at 50.
  assert.equal(minimapMarkY(0, 5, 100), 0);
  assert.equal(minimapMarkY(4, 5, 100), 100);
  assert.equal(minimapMarkY(2, 5, 100), 50);
});

test('minimapMarkY handles single-row and clamps out-of-range', () => {
  assert.equal(minimapMarkY(0, 1, 100), 0);
  assert.equal(minimapMarkY(99, 5, 100), 100); // clamp high
  assert.equal(minimapMarkY(-3, 5, 100), 0); // clamp low
});

// ── minimapMarkX ─────────────────────────────────────────────────────

test('minimapMarkX packs lanes into the track width', () => {
  // 4 lanes over width 56: slot = 14, lane 0 centre = 7, lane 3 = 49.
  assert.equal(minimapMarkX(0, 4, 56), 7);
  assert.equal(minimapMarkX(3, 4, 56), 49);
});

test('minimapMarkX centres a single-lane graph and clamps', () => {
  assert.equal(minimapMarkX(0, 1, 56), 28);
  assert.equal(minimapMarkX(9, 4, 56), 49); // clamp to last lane
});

// ── minimapViewport ──────────────────────────────────────────────────

test('minimapViewport covers the whole track when content fits', () => {
  const v = minimapViewport(0, 1000, 800, 200);
  assert.equal(v.top, 0);
  assert.equal(v.height, 200);
});

test('minimapViewport scales the indicator and lands at the bottom at max scroll', () => {
  // content 1000, view 250 -> ratio 200/1000, height = 250*0.2 = 50.
  const top = minimapViewport(0, 250, 1000, 200);
  assert.equal(top.height, 50);
  assert.equal(top.top, 0);
  // Scrolled to the end (maxScroll = 750): top hits track - height = 150.
  const bottom = minimapViewport(750, 250, 1000, 200);
  assert.equal(bottom.height, 50);
  assert.equal(Math.round(bottom.top), 150);
});

test('minimapViewport enforces a minimum grabbable height', () => {
  // A tiny viewport over a huge content would shrink below the floor.
  const v = minimapViewport(0, 5, 100000, 200);
  assert.equal(v.height, MINIMAP_MIN_VIEWPORT);
});

// ── minimapSeekScrollTop ─────────────────────────────────────────────

test('minimapSeekScrollTop centres the viewport on the pointer', () => {
  // Click mid-track (100/200 = 0.5) over content 1000, view 200:
  // target = 0.5*1000 - 100 = 400.
  assert.equal(minimapSeekScrollTop(100, 200, 1000, 200), 400);
});

test('minimapSeekScrollTop clamps to the valid scroll range', () => {
  // Click at the very top -> 0 (can't go negative after centring).
  assert.equal(minimapSeekScrollTop(0, 200, 1000, 200), 0);
  // Click at the very bottom -> maxScroll = 800.
  assert.equal(minimapSeekScrollTop(200, 200, 1000, 200), 800);
  // No scroll range -> always 0.
  assert.equal(minimapSeekScrollTop(100, 200, 150, 200), 0);
});

// ── buildMinimapMarks ────────────────────────────────────────────────

test('buildMinimapMarks emits one mark per row at lane x + track y', () => {
  const marks = buildMinimapMarks([0, 1, 0], 2, 100, 56);
  assert.equal(marks.length, 3);
  assert.deepEqual(marks.map(m => m.index), [0, 1, 2]);
  // y spreads 0 -> 50 -> 100 across 3 rows.
  assert.deepEqual(marks.map(m => m.y), [0, 50, 100]);
  // 2 lanes over width 56: slot 28, lane0=14, lane1=42.
  assert.deepEqual(marks.map(m => m.x), [14, 42, 14]);
});

test('exported minimap constants are sane', () => {
  assert.ok(MINIMAP_THRESHOLD > 0);
  assert.ok(MINIMAP_WIDTH > 0);
  assert.ok(MINIMAP_MIN_VIEWPORT > 0);
});

// ── markAtY (W49 hover/jump) ─────────────────────────────────────────

test('markAtY returns the nearest mark to a pointer Y', () => {
  // 5 rows over a 100px track -> marks at y = 0,25,50,75,100.
  const marks = buildMinimapMarks([0, 0, 0, 0, 0], 1, 100, 56);
  assert.equal(markAtY(marks, 0).index, 0);
  assert.equal(markAtY(marks, 24).index, 1); // closest to 25
  assert.equal(markAtY(marks, 50).index, 2);
  assert.equal(markAtY(marks, 100).index, 4);
});

test('markAtY clamps a pointer beyond the track to the end marks', () => {
  const marks = buildMinimapMarks([0, 0, 0], 1, 100, 56); // y = 0,50,100
  assert.equal(markAtY(marks, -20).index, 0); // before the top -> first
  assert.equal(markAtY(marks, 240).index, 2); // past the bottom -> last
});

test('markAtY resolves a tie to the later (deeper) row', () => {
  // Many rows collapse onto the same pixel on a long history; a pointer at
  // an exact midpoint should pick the later index (<= keeps walking).
  const marks = buildMinimapMarks([0, 0, 0, 0, 0], 1, 100, 56); // 0,25,50,75,100
  // Exactly between mark 1 (25) and mark 2 (50) -> 37.5; closer to neither,
  // but 50 wins on the <= tie as the scan reaches it.
  assert.equal(markAtY(marks, 37.5).index, 2);
});

test('markAtY returns null for an empty mark list', () => {
  assert.equal(markAtY([], 50), null);
});
