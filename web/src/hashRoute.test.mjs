/**
 * Compare deep-link hash-routing tests (W24).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildHash, parseHash, isRouteView, hashChanged, sanitizeSha, sanitizeEmail, sanitizeYear, sanitizePath, sanitizeLine, sanitizeStashQuery, parseLineRange, formatLineParam } from './hashRoute.ts';

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

// ── activity scoped-calendar deep-link (W48) ─────────────────────────

test('sanitizeYear accepts a plausible 4-digit year and rejects the rest', () => {
  assert.equal(sanitizeYear('2026'), 2026);
  assert.equal(sanitizeYear(2024), 2024);
  assert.equal(sanitizeYear('  2020 '), 2020);
  assert.equal(sanitizeYear('1969'), null); // before the epoch floor
  assert.equal(sanitizeYear('10000'), null); // too big
  assert.equal(sanitizeYear('20xx'), null); // non-numeric
  assert.equal(sanitizeYear('2026.5'), null); // non-integer
  assert.equal(sanitizeYear(''), null);
  assert.equal(sanitizeYear(null), null);
  assert.equal(sanitizeYear(undefined), null);
});

test('buildHash emits the bare activity tab when scoped to defaults', () => {
  assert.equal(buildHash({ view: 'activity' }), 'activity');
  assert.equal(buildHash({ view: 'activity', year: null, metric: 'commits' }), 'activity');
});

test('buildHash emits activity?year= for a scoped year', () => {
  assert.equal(buildHash({ view: 'activity', year: 2026 }), 'activity?year=2026');
});

test('buildHash emits activity?metric=churn for the churn metric', () => {
  assert.equal(buildHash({ view: 'activity', metric: 'churn' }), 'activity?metric=churn');
});

test('buildHash emits both year and metric when both diverge', () => {
  assert.equal(
    buildHash({ view: 'activity', year: 2025, metric: 'churn' }),
    'activity?year=2025&metric=churn',
  );
});

test('buildHash drops a junk year to the bare activity tab', () => {
  assert.equal(buildHash({ view: 'activity', year: 99999 }), 'activity');
});

test('parseHash reads a bare activity tab into an activity route', () => {
  assert.deepEqual(parseHash('#activity'), { view: 'activity' });
});

test('parseHash reads activity?year=&metric= into a scoped route', () => {
  assert.deepEqual(parseHash('#activity?year=2026'), { view: 'activity', year: 2026 });
  assert.deepEqual(parseHash('#activity?metric=churn'), { view: 'activity', metric: 'churn' });
  assert.deepEqual(parseHash('#activity?year=2025&metric=churn'), {
    view: 'activity',
    year: 2025,
    metric: 'churn',
  });
});

test('parseHash drops a junk year + unknown metric to defaults', () => {
  // Junk year -> rolling window (no year key); odd metric -> commits default.
  assert.deepEqual(parseHash('#activity?year=nope&metric=bogus'), { view: 'activity' });
});

test('buildHash(parseHash(x)) round-trips a scoped activity link', () => {
  const original = 'activity?year=2026&metric=churn';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── Blame deep-link (W57) ────────────────────────────────────────────

test('sanitizePath accepts repo-relative paths, rejects unsafe ones', () => {
  assert.equal(sanitizePath('src/web/main.ts'), 'src/web/main.ts');
  assert.equal(sanitizePath('  README.md  '), 'README.md');
  assert.equal(sanitizePath(''), null);
  assert.equal(sanitizePath('   '), null);
  assert.equal(sanitizePath('-rf'), null); // option-shaped
  assert.equal(sanitizePath('/etc/passwd'), null); // absolute
  assert.equal(sanitizePath('../secret'), null); // parent traversal
  assert.equal(sanitizePath('a/../b'), null); // mid-path traversal
  assert.equal(sanitizePath('a/b..c/d'), 'a/b..c/d'); // .. inside a segment is fine
  assert.equal(sanitizePath('a\u0000b'), null); // control char
  assert.equal(sanitizePath('x'.repeat(1025)), null); // too long
});

test('sanitizeLine accepts a positive int, rejects junk', () => {
  assert.equal(sanitizeLine('42'), 42);
  assert.equal(sanitizeLine(7), 7);
  assert.equal(sanitizeLine('0'), null);
  assert.equal(sanitizeLine('-3'), null);
  assert.equal(sanitizeLine('1.5'), null);
  assert.equal(sanitizeLine('nope'), null);
  assert.equal(sanitizeLine(''), null);
  assert.equal(sanitizeLine(null), null);
});

test('buildHash emits a blame link with path, optional rev + line', () => {
  assert.equal(buildHash({ view: 'blame', path: 'src/main.ts' }), 'blame?path=src%2Fmain.ts');
  assert.equal(
    buildHash({ view: 'blame', path: 'src/main.ts', line: 42 }),
    'blame?path=src%2Fmain.ts&line=42',
  );
  assert.equal(
    buildHash({ view: 'blame', path: 'src/main.ts', rev: 'abc1234', line: 9 }),
    'blame?path=src%2Fmain.ts&rev=abc1234&line=9',
  );
  // HEAD rev is omitted (it's the default).
  assert.equal(buildHash({ view: 'blame', path: 'src/main.ts', rev: 'HEAD' }), 'blame?path=src%2Fmain.ts');
  // An unsafe path degrades to the bare blame tab.
  assert.equal(buildHash({ view: 'blame', path: '../x' }), 'blame');
  assert.equal(buildHash({ view: 'blame', path: '' }), 'blame');
});

test('parseHash reads a blame link back, dropping junk rev/line', () => {
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts'), { view: 'blame', path: 'src/main.ts' });
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts&line=42'), {
    view: 'blame',
    path: 'src/main.ts',
    line: 42,
  });
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts&rev=abc1234&line=9'), {
    view: 'blame',
    path: 'src/main.ts',
    rev: 'abc1234',
    line: 9,
  });
  // Junk line drops the jump; an unsafe path drops to the bare tab.
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts&line=nope'), { view: 'blame', path: 'src/main.ts' });
  assert.deepEqual(parseHash('#blame?path=..%2Fsecret'), { view: 'blame' });
  assert.deepEqual(parseHash('#blame'), { view: 'blame' });
});

test('buildHash(parseHash(x)) round-trips a blame line link', () => {
  const original = 'blame?path=src%2Fweb%2Fmain.ts&rev=abc1234&line=128';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── Blame line range (W65) ───────────────────────────────────────────

test('parseLineRange reads a single line or an inclusive range', () => {
  assert.deepEqual(parseLineRange('42'), { start: 42, end: 42 });
  assert.deepEqual(parseLineRange('42-58'), { start: 42, end: 58 });
  assert.deepEqual(parseLineRange(' 10-12 '), { start: 10, end: 12 });
  // A reversed range normalises to ascending.
  assert.deepEqual(parseLineRange('58-42'), { start: 42, end: 58 });
  // Junk / empty -> null.
  assert.equal(parseLineRange('nope'), null);
  assert.equal(parseLineRange('1-'), null);
  assert.equal(parseLineRange('0-5'), null);
  assert.equal(parseLineRange(''), null);
  assert.equal(parseLineRange(null), null);
});

test('formatLineParam emits N or N-M, degrading a bad end', () => {
  assert.equal(formatLineParam(42), '42');
  assert.equal(formatLineParam(42, 58), '42-58');
  // end <= start -> single line.
  assert.equal(formatLineParam(42, 42), '42');
  assert.equal(formatLineParam(42, 10), '42');
  assert.equal(formatLineParam(42, null), '42');
});

test('buildHash emits a blame range link with line=N-M', () => {
  assert.equal(
    buildHash({ view: 'blame', path: 'src/main.ts', line: 10, lineEnd: 20 }),
    'blame?path=src%2Fmain.ts&line=10-20',
  );
  // lineEnd not greater than line collapses to the single line.
  assert.equal(
    buildHash({ view: 'blame', path: 'src/main.ts', line: 10, lineEnd: 10 }),
    'blame?path=src%2Fmain.ts&line=10',
  );
});

test('parseHash reads a blame range link back', () => {
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts&line=10-20'), {
    view: 'blame',
    path: 'src/main.ts',
    line: 10,
    lineEnd: 20,
  });
  // A degenerate range (N-N) parses as a single line, no lineEnd.
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts&line=10-10'), {
    view: 'blame',
    path: 'src/main.ts',
    line: 10,
  });
});

test('buildHash(parseHash(x)) round-trips a blame range link', () => {
  const original = 'blame?path=src%2Fweb%2Fmain.ts&rev=abc1234&line=128-140';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── Stash filter deep-link (W63) ─────────────────────────────────────

test('sanitizeStashQuery trims, strips control chars, bounds length', () => {
  assert.equal(sanitizeStashQuery('  refactor  '), 'refactor');
  assert.equal(sanitizeStashQuery('fix\u0000bug'), 'fix bug');
  assert.equal(sanitizeStashQuery(''), null);
  assert.equal(sanitizeStashQuery('   '), null);
  assert.equal(sanitizeStashQuery(null), null);
  assert.equal(sanitizeStashQuery('x'.repeat(250)).length, 200);
});

test('buildHash emits a stashes filter link, degrading a blank query', () => {
  assert.equal(buildHash({ view: 'stashes', q: 'wip auth' }), 'stashes?q=wip+auth');
  assert.equal(buildHash({ view: 'stashes', q: '   ' }), 'stashes');
  assert.equal(buildHash({ view: 'stashes' }), 'stashes');
});

test('parseHash reads a stashes filter link back', () => {
  assert.deepEqual(parseHash('#stashes?q=wip+auth'), { view: 'stashes', q: 'wip auth' });
  assert.deepEqual(parseHash('#stashes?q=feature%2Fx'), { view: 'stashes', q: 'feature/x' });
  // A blank/absent query degrades to the bare stashes tab.
  assert.deepEqual(parseHash('#stashes?q='), { view: 'stashes' });
  assert.deepEqual(parseHash('#stashes'), { view: 'stashes' });
});

test('buildHash(parseHash(x)) round-trips a stash filter link', () => {
  const original = 'stashes?q=wip+auth';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});
