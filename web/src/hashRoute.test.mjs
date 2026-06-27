/**
 * Compare deep-link hash-routing tests (W24).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildHash, parseHash, isRouteView, hashChanged, sanitizeSha, sanitizeEmail } from './hashRoute.ts';

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

// ── commit permalink (W27) ───────────────────────────────────────────

test('buildHash emits commit/<sha> for a graph route with a sha', () => {
  assert.equal(buildHash({ view: 'graph', sha: 'a1b2c3d4' }), 'commit/a1b2c3d4');
});

test('buildHash lowercases + degrades an unsafe permalink sha', () => {
  assert.equal(buildHash({ view: 'graph', sha: 'ABCDEF12' }), 'commit/abcdef12');
  assert.equal(buildHash({ view: 'graph', sha: 'nothex!' }), '');
});

test('parseHash reads a commit permalink into a graph route + sha', () => {
  assert.deepEqual(parseHash('#commit/a1b2c3d4'), { view: 'graph', sha: 'a1b2c3d4' });
});

test('parseHash drops an unsafe permalink sha to the bare graph view', () => {
  assert.deepEqual(parseHash('#commit/..%2Fetc'), { view: 'graph' });
  assert.deepEqual(parseHash('#commit/-rf'), { view: 'graph' });
});

test('sanitizeSha accepts hex 4-64 chars and rejects the rest', () => {
  assert.equal(sanitizeSha('AbCd'), 'abcd');
  assert.equal(sanitizeSha('  deadbeef '), 'deadbeef');
  assert.equal(sanitizeSha('abc'), null); // too short
  assert.equal(sanitizeSha('xyz1'), null); // non-hex
  assert.equal(sanitizeSha('a'.repeat(65)), null); // too long
});

test('buildHash(parseHash(x)) round-trips a commit permalink', () => {
  const original = 'commit/0123abcd';
  assert.equal(buildHash(parseHash(original)), original);
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

// ── contributor comparison deep-link (W47) ───────────────────────────

test('sanitizeEmail lowercases + rejects flags, spaces, and overlong values', () => {
  assert.equal(sanitizeEmail('Ada@Example.com'), 'ada@example.com');
  assert.equal(sanitizeEmail('  bob@x.io  '), 'bob@x.io');
  // The GitHub noreply form (with a +) survives.
  assert.equal(sanitizeEmail('51058514+sanjay@users.noreply.github.com'), '51058514+sanjay@users.noreply.github.com');
  assert.equal(sanitizeEmail('-rf'), null); // flag-shaped
  assert.equal(sanitizeEmail('a b@x.com'), null); // whitespace
  assert.equal(sanitizeEmail(''), null);
  assert.equal(sanitizeEmail('a'.repeat(321)), null); // overlong
});

test('buildHash emits contributors?vs=a,b for a valid pair', () => {
  assert.equal(
    buildHash({ view: 'contributors', vs: ['ada@x.com', 'bob@y.io'] }),
    'contributors?vs=ada%40x.com%2Cbob%40y.io',
  );
});

test('buildHash degrades to the bare contributors tab on a bad email', () => {
  assert.equal(buildHash({ view: 'contributors', vs: ['ada@x.com', '-rf'] }), 'contributors');
  assert.equal(buildHash({ view: 'contributors' }), 'contributors');
});

test('parseHash reads contributors?vs=a,b into a two-email route', () => {
  assert.deepEqual(parseHash('#contributors?vs=ada%40x.com%2Cbob%40y.io'), {
    view: 'contributors',
    vs: ['ada@x.com', 'bob@y.io'],
  });
});

test('parseHash drops a malformed vs to the bare contributors tab', () => {
  // Only one email -> not a pair.
  assert.deepEqual(parseHash('#contributors?vs=ada%40x.com'), { view: 'contributors' });
  // A flag-shaped email is rejected.
  assert.deepEqual(parseHash('#contributors?vs=ada%40x.com%2C-rf'), { view: 'contributors' });
  // Bare tab with no params.
  assert.deepEqual(parseHash('#contributors'), { view: 'contributors' });
});

test('buildHash(parseHash(x)) round-trips a contributors comparison link', () => {
  const original = 'contributors?vs=ada%40x.com%2Cbob%40y.io';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});
