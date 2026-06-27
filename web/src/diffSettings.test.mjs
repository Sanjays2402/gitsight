/**
 * Diff display-settings tests (W31).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  defaultDiffSettings,
  toggleWrap,
  toggleIgnoreWhitespace,
  toggleSplit,
  diffViewMode,
  wsParam,
  coerceDiffSettings,
  diffSettingsEqual,
  layoutForSurface,
  toggleSurfaceLayout,
  coerceSurfaceLayouts,
  DIFF_SURFACES,
} from './diffSettings.ts';

test('defaultDiffSettings is scroll + show-whitespace + unified', () => {
  assert.deepEqual(defaultDiffSettings(), { wrap: false, ignoreWhitespace: false, split: false });
});

test('toggleWrap flips only wrap and returns a new object', () => {
  const a = defaultDiffSettings();
  const b = toggleWrap(a);
  assert.equal(b.wrap, true);
  assert.equal(b.ignoreWhitespace, false);
  assert.equal(b.split, false);
  assert.notEqual(a, b); // immutable
  assert.equal(a.wrap, false); // original untouched
});

test('toggleIgnoreWhitespace flips only ignoreWhitespace', () => {
  const b = toggleIgnoreWhitespace(defaultDiffSettings());
  assert.equal(b.ignoreWhitespace, true);
  assert.equal(b.wrap, false);
  assert.equal(b.split, false);
});

test('toggleSplit flips only split and returns a new object', () => {
  const a = defaultDiffSettings();
  const b = toggleSplit(a);
  assert.equal(b.split, true);
  assert.equal(b.wrap, false);
  assert.equal(b.ignoreWhitespace, false);
  assert.notEqual(a, b);
  assert.equal(a.split, false);
});

test('diffViewMode maps split flag to the renderer arg', () => {
  assert.equal(diffViewMode({ wrap: false, ignoreWhitespace: false, split: true }), 'split');
  assert.equal(diffViewMode({ wrap: false, ignoreWhitespace: false, split: false }), 'unified');
});

test('wsParam maps to the git -w request only when ignoring', () => {
  assert.equal(wsParam({ wrap: false, ignoreWhitespace: true, split: false }), 'ignore');
  assert.equal(wsParam({ wrap: false, ignoreWhitespace: false, split: false }), undefined);
});

test('coerceDiffSettings falls back to defaults for junk', () => {
  assert.deepEqual(coerceDiffSettings(null), defaultDiffSettings());
  assert.deepEqual(coerceDiffSettings('nope'), defaultDiffSettings());
  assert.deepEqual(coerceDiffSettings(42), defaultDiffSettings());
  assert.deepEqual(coerceDiffSettings([]), defaultDiffSettings());
});

test('coerceDiffSettings reads strict booleans', () => {
  assert.deepEqual(coerceDiffSettings({ wrap: true, ignoreWhitespace: true, split: true }), {
    wrap: true,
    ignoreWhitespace: true,
    split: true,
  });
  // Truthy-but-not-true values are not accepted.
  assert.deepEqual(coerceDiffSettings({ wrap: 1, ignoreWhitespace: 'yes', split: 1 }), {
    wrap: false,
    ignoreWhitespace: false,
    split: false,
  });
  // Missing keys default to false.
  assert.deepEqual(coerceDiffSettings({ wrap: true }), { wrap: true, ignoreWhitespace: false, split: false });
});

test('diffSettingsEqual compares by value', () => {
  assert.equal(
    diffSettingsEqual(
      { wrap: true, ignoreWhitespace: false, split: false },
      { wrap: true, ignoreWhitespace: false, split: false },
    ),
    true,
  );
  assert.equal(
    diffSettingsEqual(
      { wrap: true, ignoreWhitespace: false, split: false },
      { wrap: false, ignoreWhitespace: false, split: false },
    ),
    false,
  );
  // The split flag participates in equality.
  assert.equal(
    diffSettingsEqual(
      { wrap: true, ignoreWhitespace: false, split: true },
      { wrap: true, ignoreWhitespace: false, split: false },
    ),
    false,
  );
});

// ── Per-surface layout (W46) ─────────────────────────────────────────

test('layoutForSurface inherits the global split when no override is set', () => {
  const globalUnified = { wrap: false, ignoreWhitespace: false, split: false };
  const globalSplit = { wrap: false, ignoreWhitespace: false, split: true };
  assert.equal(layoutForSurface(globalUnified, {}, 'compare'), 'unified');
  assert.equal(layoutForSurface(globalSplit, {}, 'compare'), 'split');
  assert.equal(layoutForSurface(globalSplit, {}, 'detail'), 'split');
});

test('layoutForSurface prefers a surface override over the global flag', () => {
  const globalUnified = { wrap: false, ignoreWhitespace: false, split: false };
  // Compare overridden to split while detail still inherits unified.
  assert.equal(layoutForSurface(globalUnified, { compare: true }, 'compare'), 'split');
  assert.equal(layoutForSurface(globalUnified, { compare: true }, 'detail'), 'unified');
  // An explicit false override wins even when global is split.
  const globalSplit = { wrap: false, ignoreWhitespace: false, split: true };
  assert.equal(layoutForSurface(globalSplit, { compare: false }, 'compare'), 'unified');
});

test('toggleSurfaceLayout flips one surface from its resolved value', () => {
  const globalUnified = { wrap: false, ignoreWhitespace: false, split: false };
  // First toggle: inherit unified -> override split.
  const a = toggleSurfaceLayout(globalUnified, {}, 'compare');
  assert.equal(a.compare, true);
  // Toggling again flips back to unified, and doesn't touch detail.
  const b = toggleSurfaceLayout(globalUnified, a, 'compare');
  assert.equal(b.compare, false);
  assert.equal(b.detail, undefined);
});

test('coerceSurfaceLayouts keeps only known surfaces with boolean values', () => {
  assert.deepEqual(coerceSurfaceLayouts({ compare: true, detail: false }), {
    compare: true,
    detail: false,
  });
  assert.deepEqual(coerceSurfaceLayouts({ compare: 'yes', bogus: true }), {});
  assert.deepEqual(coerceSurfaceLayouts(null), {});
  assert.deepEqual(coerceSurfaceLayouts('nope'), {});
});

test('DIFF_SURFACES lists the three diff surfaces', () => {
  assert.deepEqual(DIFF_SURFACES, ['detail', 'compare', 'stash']);
});

test('layoutForSurface resolves the stash surface independently (W53)', () => {
  const globalSplit = { wrap: false, ignoreWhitespace: false, split: true };
  // Stash inherits the global split when it has no override.
  assert.equal(layoutForSurface(globalSplit, {}, 'stash'), 'split');
  // An explicit stash override wins and doesn't disturb the other surfaces.
  assert.equal(layoutForSurface(globalSplit, { stash: false }, 'stash'), 'unified');
  assert.equal(layoutForSurface(globalSplit, { stash: false }, 'compare'), 'split');
  // Toggling the stash surface flips only it.
  const a = toggleSurfaceLayout(globalSplit, {}, 'stash');
  assert.equal(a.stash, false);
  assert.equal(a.detail, undefined);
  assert.equal(a.compare, undefined);
  // A coerced blob keeps a boolean stash override.
  assert.deepEqual(coerceSurfaceLayouts({ stash: true }), { stash: true });
});
