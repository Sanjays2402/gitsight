/**
 * Compare deep-link hash-routing tests (W24).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildHash, parseHash, isRouteView, hashChanged } from './hashRoute.ts';

// ── buildHash ────────────────────────────────────────────────────────

test('buildHash emits compare?base=&head= for a valid ref pair', () => {
  assert.equal(buildHash({ view: 'compare', base: 'main', head: 'HEAD' }), 'compare?base=main&head=HEAD');
});

test('buildHash degrades to the bare tab when a ref is unsafe/empty', () => {
  assert.equal(buildHash({ view: 'compare', base: 'main', head: '' }), 'compare');
  assert.equal(buildHash({ view: 'compare', base: '-bad', head: 'HEAD' }), 'compare');
});

test('buildHash returns empty for the default graph view', () => {
  assert.equal(buildHash({ view: 'graph' }), '');
});

test('buildHash emits the bare name for other views', () => {
  assert.equal(buildHash({ view: 'stashes' }), 'stashes');
  assert.equal(buildHash({ view: 'blame' }), 'blame');
});

// ── parseHash ────────────────────────────────────────────────────────

test('parseHash round-trips a compare deep link', () => {
  const r = parseHash('#compare?base=main&head=feature/x');
  assert.deepEqual(r, { view: 'compare', base: 'main', head: 'feature/x' });
});

test('parseHash tolerates a missing leading hash + whitespace', () => {
  assert.deepEqual(parseHash('  compare?base=a&head=b  '), { view: 'compare', base: 'a', head: 'b' });
});

test('parseHash maps a bare view name', () => {
  assert.deepEqual(parseHash('#stashes'), { view: 'stashes' });
  assert.deepEqual(parseHash('#graph'), { view: 'graph' });
});

test('parseHash returns null for empty or unknown views', () => {
  assert.equal(parseHash(''), null);
  assert.equal(parseHash('#'), null);
  assert.equal(parseHash('#bogus'), null);
});

test('parseHash drops unsafe refs to the bare compare tab', () => {
  assert.deepEqual(parseHash('#compare?base=main&head=-rf'), { view: 'compare', base: '', head: '' });
  assert.deepEqual(parseHash('#compare'), { view: 'compare', base: '', head: '' });
});

test('parseHash decodes percent-encoded refs', () => {
  // A ref with a slash survives URLSearchParams encoding.
  const r = parseHash('#compare?base=release%2F1.0&head=HEAD');
  assert.deepEqual(r, { view: 'compare', base: 'release/1.0', head: 'HEAD' });
});

// ── isRouteView / hashChanged ────────────────────────────────────────

test('isRouteView recognises the six tabs', () => {
  for (const v of ['graph', 'activity', 'contributors', 'blame', 'compare', 'stashes']) {
    assert.equal(isRouteView(v), true);
  }
  assert.equal(isRouteView('nope'), false);
});

test('hashChanged ignores a leading hash difference', () => {
  assert.equal(hashChanged('#compare?base=a&head=b', 'compare?base=a&head=b'), false);
  assert.equal(hashChanged('#graph', 'stashes'), true);
  assert.equal(hashChanged('', ''), false);
});

// round-trip property: buildHash(parseHash(x)) is stable for compare links
test('buildHash(parseHash(x)) is stable for a compare link', () => {
  const original = 'compare?base=main&head=dev';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});
