/**
 * Responsive-layout pure-helper tests (W11).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  layoutFor,
  layoutChanged,
  RAIL_BREAKPOINT,
  COMPACT_BREAKPOINT,
} from './responsive.ts';

test('layoutFor is inline + roomy on a wide viewport', () => {
  const l = layoutFor(1280);
  assert.equal(l.railIsDrawer, false);
  assert.equal(l.compact, false);
  assert.equal(l.detailFullWidth, false);
});

test('layoutFor collapses the rail into a drawer at/below the rail breakpoint', () => {
  assert.equal(layoutFor(RAIL_BREAKPOINT).railIsDrawer, true);
  assert.equal(layoutFor(RAIL_BREAKPOINT + 1).railIsDrawer, false);
  // Still not compact between the two breakpoints.
  assert.equal(layoutFor(RAIL_BREAKPOINT).compact, false);
});

test('layoutFor goes compact + full-width detail at/below the compact breakpoint', () => {
  const l = layoutFor(COMPACT_BREAKPOINT);
  assert.equal(l.compact, true);
  assert.equal(l.railIsDrawer, true);
  assert.equal(l.detailFullWidth, true);
});

test('layoutFor tolerates a non-finite width (defaults to roomy)', () => {
  const l = layoutFor(NaN);
  assert.equal(l.railIsDrawer, false);
  assert.equal(l.compact, false);
});

test('layoutChanged only fires when a breakpoint is crossed', () => {
  // Same band -> no change.
  assert.equal(layoutChanged(1280, 1100), false);
  assert.equal(layoutChanged(700, 800), false);
  // Cross the rail breakpoint.
  assert.equal(layoutChanged(900, 800), true);
  // Cross the compact breakpoint.
  assert.equal(layoutChanged(700, 500), true);
});
