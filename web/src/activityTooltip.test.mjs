/**
 * Activity day hover popover pure-helper tests (W55).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  popoverPosition,
  tooltipSummary,
  truncateSubject,
} from './activityTooltip.ts';

const VIEWPORT = { width: 1000, height: 800 };

test('popoverPosition centres horizontally on the anchor', () => {
  const anchor = { left: 500, top: 400, right: 512, bottom: 412 };
  const p = popoverPosition(anchor, { width: 200, height: 80 }, VIEWPORT);
  // Centre of anchor is 506; popover left = 506 - 100 = 406.
  assert.equal(p.left, 406);
});

test('popoverPosition prefers above when there is room', () => {
  const anchor = { left: 500, top: 400, right: 512, bottom: 412 };
  const p = popoverPosition(anchor, { width: 200, height: 80 }, VIEWPORT, 8);
  assert.equal(p.side, 'above');
  // top = anchor.top - height - gap = 400 - 80 - 8 = 312.
  assert.equal(p.top, 312);
});

test('popoverPosition flips below when there is no room above', () => {
  // Anchor hugging the top edge -> not enough room above.
  const anchor = { left: 500, top: 10, right: 512, bottom: 22 };
  const p = popoverPosition(anchor, { width: 200, height: 80 }, VIEWPORT, 8);
  assert.equal(p.side, 'below');
  // top = anchor.bottom + gap = 22 + 8 = 30.
  assert.equal(p.top, 30);
});

test('popoverPosition clamps to the left and right viewport margins', () => {
  // Anchor near the left edge -> clamp to the margin (8).
  const leftAnchor = { left: 0, top: 400, right: 12, bottom: 412 };
  const pl = popoverPosition(leftAnchor, { width: 200, height: 80 }, VIEWPORT, 8, 8);
  assert.equal(pl.left, 8);
  // Anchor near the right edge -> clamp so the box stays on-screen.
  const rightAnchor = { left: 988, top: 400, right: 1000, bottom: 412 };
  const pr = popoverPosition(rightAnchor, { width: 200, height: 80 }, VIEWPORT, 8, 8);
  assert.equal(pr.left, 1000 - 200 - 8); // 792
});

test('popoverPosition falls back to the roomier side when neither fits', () => {
  const tall = { width: 200, height: 700 };
  // More room below than above -> below.
  const lowAnchor = { left: 500, top: 300, right: 512, bottom: 320 };
  assert.equal(popoverPosition(lowAnchor, tall, VIEWPORT).side, 'below');
  // More room above than below -> above.
  const highAnchor = { left: 500, top: 480, right: 512, bottom: 500 };
  assert.equal(popoverPosition(highAnchor, tall, VIEWPORT).side, 'above');
});

test('tooltipSummary returns the top N subjects + a remainder count', () => {
  const commits = [
    { subject: 'first' },
    { subject: 'second' },
    { subject: 'third' },
    { subject: 'fourth' },
  ];
  const s = tooltipSummary(commits, 2);
  assert.deepEqual(s.subjects, ['first', 'second']);
  assert.equal(s.more, 2);
});

test('tooltipSummary drops blank subjects and trims', () => {
  const commits = [{ subject: '  hello  ' }, { subject: '   ' }, { subject: 'world' }];
  const s = tooltipSummary(commits, 5);
  assert.deepEqual(s.subjects, ['hello', 'world']);
  // Two non-blank subjects, both shown -> no remainder. (The blank still
  // counted toward total, so more = 3 - 2 = 1.)
  assert.equal(s.more, 1);
});

test('tooltipSummary clamps max to at least 1 and handles empty input', () => {
  assert.deepEqual(tooltipSummary([{ subject: 'a' }, { subject: 'b' }], 0), {
    subjects: ['a'],
    more: 1,
  });
  assert.deepEqual(tooltipSummary([], 2), { subjects: [], more: 0 });
});

test('truncateSubject ellipsises long subjects only', () => {
  assert.equal(truncateSubject('short'), 'short');
  const long = 'x'.repeat(100);
  const t = truncateSubject(long, 20);
  assert.equal(t.length, 20);
  assert.ok(t.endsWith('\u2026'));
  // Exactly at the limit is untouched.
  assert.equal(truncateSubject('y'.repeat(20), 20), 'y'.repeat(20));
});
