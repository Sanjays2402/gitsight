/**
 * Theme-resolution tests (W5).
 *
 * Runs under `node --test` (web test glob). themeResolve.ts imports the
 * shared palette via a relative .ts path so Node resolves it without the
 * Vite alias.
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveInitialChrome,
  nextChrome,
  resolveInitialPalette,
  cyclePalette,
} from './themeResolve.ts';
import { THEME_NAMES } from '../../src/shared/graphPalette.ts';

// ── chrome ───────────────────────────────────────────────────────────

test('resolveInitialChrome honours a valid stored value over the OS pref', () => {
  assert.equal(resolveInitialChrome('light', true), 'light');
  assert.equal(resolveInitialChrome('dark', false), 'dark');
});

test('resolveInitialChrome falls back to the OS pref for missing/garbage', () => {
  assert.equal(resolveInitialChrome(null, true), 'dark');
  assert.equal(resolveInitialChrome(null, false), 'light');
  assert.equal(resolveInitialChrome('purple', true), 'dark');
});

test('nextChrome flips between light and dark', () => {
  assert.equal(nextChrome('dark'), 'light');
  assert.equal(nextChrome('light'), 'dark');
});

// ── palette ──────────────────────────────────────────────────────────

test('resolveInitialPalette accepts a known theme and defaults otherwise', () => {
  assert.equal(resolveInitialPalette('nord'), 'nord');
  assert.equal(resolveInitialPalette('dracula'), 'dracula');
  assert.equal(resolveInitialPalette(null), 'default');
  assert.equal(resolveInitialPalette('not-a-theme'), 'default');
});

test('cyclePalette walks every theme exactly once and wraps', () => {
  const start = THEME_NAMES[0];
  const seen = [start];
  let cur = start;
  for (let i = 0; i < THEME_NAMES.length - 1; i++) {
    cur = cyclePalette(cur);
    seen.push(cur);
  }
  // Visited all distinct themes...
  assert.deepEqual(new Set(seen).size, THEME_NAMES.length);
  // ...and one more step wraps back to the first.
  assert.equal(cyclePalette(cur), start);
});

test('cyclePalette recovers to the first theme from an unknown current', () => {
  // @ts-expect-error intentionally passing an off-list value
  assert.equal(cyclePalette('bogus'), THEME_NAMES[0]);
});
