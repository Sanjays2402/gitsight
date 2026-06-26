/**
 * Blame-window pure-helper tests (W21).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  BLAME_ROW_H,
  BLAME_VIRTUAL_THRESHOLD,
  shouldVirtualizeBlame,
  blameContentHeight,
  blameWindow,
  revealBlameLine,
  parseBlameTarget,
} from './blameWindow.ts';

// ── thresholds + geometry ────────────────────────────────────────────

test('shouldVirtualizeBlame trips at the threshold', () => {
  assert.equal(shouldVirtualizeBlame(BLAME_VIRTUAL_THRESHOLD - 1), false);
  assert.equal(shouldVirtualizeBlame(BLAME_VIRTUAL_THRESHOLD), true);
  assert.equal(shouldVirtualizeBlame(50000), true);
  assert.equal(shouldVirtualizeBlame(0), false);
});

test('blameContentHeight is total * row height, floored at 0', () => {
  assert.equal(blameContentHeight(100), 100 * BLAME_ROW_H);
  assert.equal(blameContentHeight(0), 0);
  assert.equal(blameContentHeight(-5), 0);
});

// ── blameWindow ──────────────────────────────────────────────────────

test('blameWindow mounts the visible slice plus overscan at the top', () => {
  const w = blameWindow(0, 400, 5000);
  assert.equal(w.start, 0);
  // 400/20 = 20 visible + 1 partial + 12 overscan = 33.
  assert.equal(w.end, 33);
  assert.equal(w.totalHeight, 5000 * BLAME_ROW_H);
});

test('blameWindow centres mid-scroll and clamps at the bottom', () => {
  const mid = blameWindow(2000, 400, 5000); // firstVisible = 100
  assert.equal(mid.start, 100 - 12);
  assert.equal(mid.offsetTop, (100 - 12) * BLAME_ROW_H);

  const bottom = blameWindow(5000 * BLAME_ROW_H, 400, 5000);
  assert.equal(bottom.end, 5000);
  assert.ok(bottom.start < bottom.end);
});

// ── revealBlameLine ──────────────────────────────────────────────────

test('revealBlameLine scrolls a far line into view (1-based)', () => {
  // Line 500 -> index 499, top = 499*20 = 9980; viewport 400 -> 9980-... 
  // it's below the viewport so scrollTop = bottom - viewport = (500*20) - 400.
  const top = revealBlameLine(500, 0, 400, 5000);
  assert.equal(top, 500 * BLAME_ROW_H - 400);
});

test('revealBlameLine leaves an already-visible line put', () => {
  // Line 6 -> index 5 (100..120) inside viewport 0..400 -> unchanged.
  assert.equal(revealBlameLine(6, 0, 400, 5000), 0);
});

test('revealBlameLine clamps out-of-range + bad input', () => {
  assert.equal(revealBlameLine(99999, 0, 400, 10), Math.max(0, 10 * BLAME_ROW_H - 400));
  assert.equal(revealBlameLine(0, 80, 400, 10), 0); // floored to line 1 -> index 0
});

// ── parseBlameTarget ─────────────────────────────────────────────────

test('parseBlameTarget reads a bare path', () => {
  assert.deepEqual(parseBlameTarget('src/main.ts'), { path: 'src/main.ts', line: null });
  assert.deepEqual(parseBlameTarget('  src/a.ts  '), { path: 'src/a.ts', line: null });
});

test('parseBlameTarget reads the GitHub #L anchor', () => {
  assert.deepEqual(parseBlameTarget('src/main.ts#L42'), { path: 'src/main.ts', line: 42 });
});

test('parseBlameTarget reads the path:line form', () => {
  assert.deepEqual(parseBlameTarget('web/server/index.mjs:120'), {
    path: 'web/server/index.mjs',
    line: 120,
  });
});

test('parseBlameTarget ignores a non-positive / non-integer line', () => {
  assert.deepEqual(parseBlameTarget('a.ts:0'), { path: 'a.ts:0', line: null });
  assert.deepEqual(parseBlameTarget(''), { path: '', line: null });
});

test('parseBlameTarget prefers #L over a trailing colon group', () => {
  // The anchor form is unambiguous even when a colon precedes it.
  assert.deepEqual(parseBlameTarget('weird:name.ts#L7'), { path: 'weird:name.ts', line: 7 });
});
