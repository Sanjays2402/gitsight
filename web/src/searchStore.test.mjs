/**
 * Search history + saved filters store tests (W30).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizeQuery,
  recordQuery,
  togglePin,
  removeQuery,
  capUnpinned,
  sortEntries,
  coerceEntries,
  suggestEntries,
  DEFAULT_RECENT_LIMIT,
} from './searchStore.ts';

const pin = (query) => ({ query, pinned: true });
const recent = (query) => ({ query, pinned: false });

// ── normalizeQuery ───────────────────────────────────────────────────

test('normalizeQuery trims and collapses inner whitespace', () => {
  assert.equal(normalizeQuery('  author:ada   grep:fix  '), 'author:ada grep:fix');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery('   '), '');
});

// ── recordQuery ──────────────────────────────────────────────────────

test('recordQuery prepends a new query newest-first', () => {
  let s = [];
  s = recordQuery(s, 'a');
  s = recordQuery(s, 'b');
  assert.deepEqual(s.map(e => e.query), ['b', 'a']);
});

test('recordQuery dedupes + moves an existing query to the front', () => {
  let s = [recent('a'), recent('b'), recent('c')];
  s = recordQuery(s, 'c');
  assert.deepEqual(s.map(e => e.query), ['c', 'a', 'b']);
  assert.equal(s.length, 3);
});

test('recordQuery ignores an empty/whitespace query', () => {
  const s = [recent('a')];
  assert.deepEqual(recordQuery(s, '   '), s);
});

test('recordQuery preserves the pinned flag when re-recording', () => {
  let s = [pin('a'), recent('b')];
  s = recordQuery(s, 'a');
  const a = s.find(e => e.query === 'a');
  assert.equal(a.pinned, true);
});

test('recordQuery caps unpinned entries at the limit, evicting the oldest', () => {
  let s = [];
  for (let i = 0; i < DEFAULT_RECENT_LIMIT + 3; i++) s = recordQuery(s, `q${i}`);
  const unpinned = s.filter(e => !e.pinned);
  assert.equal(unpinned.length, DEFAULT_RECENT_LIMIT);
  // Newest kept, oldest dropped.
  assert.equal(s[0].query, `q${DEFAULT_RECENT_LIMIT + 2}`);
  assert.ok(!s.some(e => e.query === 'q0'));
});

test('recordQuery never evicts pinned entries past the cap', () => {
  let s = [pin('keep')];
  for (let i = 0; i < DEFAULT_RECENT_LIMIT + 5; i++) s = recordQuery(s, `q${i}`);
  assert.ok(s.some(e => e.query === 'keep' && e.pinned));
  assert.equal(s.filter(e => !e.pinned).length, DEFAULT_RECENT_LIMIT);
});

// ── togglePin / removeQuery ──────────────────────────────────────────

test('togglePin flips the pinned flag', () => {
  let s = [recent('a')];
  s = togglePin(s, 'a');
  assert.equal(s[0].pinned, true);
  s = togglePin(s, 'a');
  assert.equal(s[0].pinned, false);
});

test('togglePin is a no-op for an unknown query', () => {
  const s = [recent('a')];
  assert.deepEqual(togglePin(s, 'zzz'), s);
});

test('removeQuery drops an entry', () => {
  const s = [recent('a'), pin('b')];
  assert.deepEqual(removeQuery(s, 'a').map(e => e.query), ['b']);
});

// ── sortEntries / capUnpinned ────────────────────────────────────────

test('sortEntries puts pinned first, preserving in-group order', () => {
  const s = [recent('a'), pin('b'), recent('c'), pin('d')];
  assert.deepEqual(sortEntries(s).map(e => e.query), ['b', 'd', 'a', 'c']);
});

test('capUnpinned keeps all pinned + the first N unpinned', () => {
  const s = [pin('p1'), recent('a'), pin('p2'), recent('b'), recent('c')];
  const capped = capUnpinned(s, 2);
  assert.deepEqual(capped.map(e => e.query), ['p1', 'a', 'p2', 'b']);
});

// ── coerceEntries ────────────────────────────────────────────────────

test('coerceEntries drops malformed rows + dedupes', () => {
  const raw = [
    { query: 'a', pinned: true },
    { query: '  a  ', pinned: false }, // dup of a after normalize
    { query: '', pinned: false }, // empty
    { nope: 1 }, // malformed
    'string', // malformed
    { query: 'b' }, // pinned defaults false
  ];
  assert.deepEqual(coerceEntries(raw), [
    { query: 'a', pinned: true },
    { query: 'b', pinned: false },
  ]);
});

test('coerceEntries returns [] for non-array input', () => {
  assert.deepEqual(coerceEntries(null), []);
  assert.deepEqual(coerceEntries({ query: 'a' }), []);
});

// ── suggestEntries ───────────────────────────────────────────────────

test('suggestEntries returns prefix matches, excluding the exact current', () => {
  const s = [recent('author:ada'), recent('author:bob'), recent('grep:fix')];
  const out = suggestEntries(s, 'author:');
  assert.deepEqual(out.map(e => e.query), ['author:ada', 'author:bob']);
  // Exact current is excluded as a useless self-suggestion.
  assert.deepEqual(suggestEntries(s, 'author:ada').map(e => e.query), []);
});

test('suggestEntries with empty current returns all, pinned first', () => {
  const s = [recent('a'), pin('b')];
  assert.deepEqual(suggestEntries(s, '').map(e => e.query), ['b', 'a']);
});

test('suggestEntries caps the result', () => {
  const s = Array.from({ length: 10 }, (_, i) => recent(`q${i}`));
  assert.equal(suggestEntries(s, '', 3).length, 3);
});
