/**
 * Keyboard-shortcut catalog tests (W37).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  modKeyLabel,
  buildShortcutCatalog,
  shortcutsForView,
  appliesTo,
  countShortcuts,
} from './shortcutCatalog.ts';

// ── modKeyLabel ──────────────────────────────────────────────────────

test('modKeyLabel swaps Cmd glyph / Ctrl by platform', () => {
  assert.equal(modKeyLabel(true), '\u2318');
  assert.equal(modKeyLabel(false), 'Ctrl');
});

// ── buildShortcutCatalog ─────────────────────────────────────────────

test('buildShortcutCatalog uses the platform modifier in the palette chip', () => {
  const mac = buildShortcutCatalog(true);
  const win = buildShortcutCatalog(false);
  const macK = mac[0].shortcuts.find(s => s.description.includes('command palette'));
  const winK = win[0].shortcuts.find(s => s.description.includes('command palette'));
  assert.deepEqual(macK.keys, ['\u2318', 'K']);
  assert.deepEqual(winK.keys, ['Ctrl', 'K']);
});

test('buildShortcutCatalog groups carry titles + non-empty shortcut lists', () => {
  const cat = buildShortcutCatalog(false);
  assert.ok(cat.length >= 3);
  for (const g of cat) {
    assert.equal(typeof g.title, 'string');
    assert.ok(g.shortcuts.length > 0);
  }
});

// ── appliesTo ────────────────────────────────────────────────────────

test('appliesTo treats missing/empty views as global', () => {
  assert.equal(appliesTo({ keys: ['?'], description: 'x' }, 'blame'), true);
  assert.equal(appliesTo({ keys: ['?'], description: 'x', views: [] }, 'compare'), true);
});

test('appliesTo scopes a view-specific shortcut', () => {
  const s = { keys: ['j'], description: 'next', views: ['graph'] };
  assert.equal(appliesTo(s, 'graph'), true);
  assert.equal(appliesTo(s, 'blame'), false);
});

// ── shortcutsForView ─────────────────────────────────────────────────

test('shortcutsForView keeps global + matching shortcuts and drops empties', () => {
  const cat = buildShortcutCatalog(false);
  const blame = shortcutsForView(cat, 'blame');
  // Global group survives.
  assert.ok(blame.some(g => g.title === 'Global'));
  // The graph-only group is dropped entirely on the blame view.
  assert.ok(!blame.some(g => g.title === 'Graph'));
  // Every surviving shortcut applies to blame.
  for (const g of blame) {
    for (const s of g.shortcuts) assert.equal(appliesTo(s, 'blame'), true);
  }
});

test('shortcutsForView on the graph view includes the j/k navigation group', () => {
  const graph = shortcutsForView(buildShortcutCatalog(false), 'graph');
  const navGroup = graph.find(g => g.title === 'Graph');
  assert.ok(navGroup);
  assert.ok(navGroup.shortcuts.some(s => s.keys.includes('j')));
});

// ── countShortcuts ───────────────────────────────────────────────────

test('countShortcuts sums across groups', () => {
  const cat = buildShortcutCatalog(false);
  const total = countShortcuts(cat);
  const manual = cat.reduce((n, g) => n + g.shortcuts.length, 0);
  assert.equal(total, manual);
  // Filtering to a view never increases the count.
  assert.ok(countShortcuts(shortcutsForView(cat, 'stashes')) <= total);
});
