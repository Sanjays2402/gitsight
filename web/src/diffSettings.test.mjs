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
