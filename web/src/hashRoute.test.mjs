/**
 * Compare deep-link hash-routing tests (W24).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildHash, parseHash, isRouteView, hashChanged, sanitizeSha, sanitizeEmail, sanitizeYear, sanitizePath, sanitizeLine, sanitizeStashQuery, parseLineRange, formatLineParam, sanitizeContributorSort, sanitizeShaList, MAX_GRAPH_COMMITS, sanitizeBlameAuthor, sanitizeDayKey, sanitizeAuthorFilter, sanitizeRailSort, sanitizeOwnershipBand } from './hashRoute.ts';
import { contributorSortPaletteItems, isContributorSort } from '../../src/shared/contributors.ts';

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

// ── activity day-panel deep-link (W79) ───────────────────────────────

test('sanitizeDayKey accepts a YYYY-MM-DD key, rejects junk', () => {
  assert.equal(sanitizeDayKey('2026-06-27'), '2026-06-27');
  assert.equal(sanitizeDayKey('  2026-06-27  '), '2026-06-27'); // trimmed
  assert.equal(sanitizeDayKey('2026-6-7'), null); // not zero-padded
  assert.equal(sanitizeDayKey('2026/06/27'), null); // wrong separators
  assert.equal(sanitizeDayKey('nope'), null);
  assert.equal(sanitizeDayKey(''), null);
  assert.equal(sanitizeDayKey(null), null);
});

test('buildHash emits activity?day= for an open day panel', () => {
  assert.equal(buildHash({ view: 'activity', day: '2026-06-27' }), 'activity?day=2026-06-27');
  // A junk day degrades to the bare tab.
  assert.equal(buildHash({ view: 'activity', day: 'nope' }), 'activity');
});

test('buildHash composes day with year + metric', () => {
  assert.equal(
    buildHash({ view: 'activity', year: 2026, metric: 'churn', day: '2026-06-27' }),
    'activity?year=2026&metric=churn&day=2026-06-27',
  );
});

test('parseHash reads activity?day= into a day-scoped route', () => {
  assert.deepEqual(parseHash('#activity?day=2026-06-27'), { view: 'activity', day: '2026-06-27' });
  // A junk day drops to the bare activity tab.
  assert.deepEqual(parseHash('#activity?day=nope'), { view: 'activity' });
});

test('buildHash(parseHash(x)) round-trips a day-panel link', () => {
  const original = 'activity?day=2026-06-27';
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

// ── Contributor sort deep-link (W66) ─────────────────────────────────

test('sanitizeContributorSort accepts the real sort keys, rejects junk', () => {
  assert.equal(sanitizeContributorSort('churn'), 'churn');
  assert.equal(sanitizeContributorSort('Recent'), 'recent'); // case-insensitive
  assert.equal(sanitizeContributorSort('  name  '), 'name'); // trimmed
  assert.equal(sanitizeContributorSort('commits'), 'commits');
  assert.equal(sanitizeContributorSort('bogus'), null);
  assert.equal(sanitizeContributorSort(''), null);
  assert.equal(sanitizeContributorSort(null), null);
  assert.equal(sanitizeContributorSort(undefined), null);
});

test('buildHash emits a contributors sort link, omitting the default', () => {
  assert.equal(buildHash({ view: 'contributors', sort: 'churn' }), 'contributors?sort=churn');
  assert.equal(buildHash({ view: 'contributors', sort: 'recent' }), 'contributors?sort=recent');
  // The commits default stays the bare tab (no noisy param for the common case).
  assert.equal(buildHash({ view: 'contributors', sort: 'commits' }), 'contributors');
  // A junk sort degrades to the bare tab.
  assert.equal(buildHash({ view: 'contributors', sort: 'bogus' }), 'contributors');
});

test('a vs comparison link wins over a sort param', () => {
  // vs takes precedence; a sort alongside it is ignored (mutually exclusive).
  assert.equal(
    buildHash({ view: 'contributors', vs: ['a@x.com', 'b@x.com'] }),
    'contributors?vs=a%40x.com%2Cb%40x.com',
  );
});

test('parseHash reads a contributors sort link back', () => {
  assert.deepEqual(parseHash('#contributors?sort=churn'), { view: 'contributors', sort: 'churn' });
  assert.deepEqual(parseHash('#contributors?sort=name'), { view: 'contributors', sort: 'name' });
  // The commits default + a junk sort both degrade to the bare tab.
  assert.deepEqual(parseHash('#contributors?sort=commits'), { view: 'contributors' });
  assert.deepEqual(parseHash('#contributors?sort=bogus'), { view: 'contributors' });
  assert.deepEqual(parseHash('#contributors'), { view: 'contributors' });
});

test('a vs param is read in preference to a sort param', () => {
  assert.deepEqual(parseHash('#contributors?vs=a%40x.com%2Cb%40x.com&sort=churn'), {
    view: 'contributors',
    vs: ['a@x.com', 'b@x.com'],
  });
});

test('buildHash(parseHash(x)) round-trips a contributors sort link', () => {
  const original = 'contributors?sort=churn';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── "View these commits" graph deep-link (W72) ───────────────────────

test('sanitizeShaList keeps valid shas, drops junk, de-dupes, preserves order', () => {
  assert.deepEqual(sanitizeShaList('aaaa1111,BBBB2222,aaaa1111'), ['aaaa1111', 'bbbb2222']);
  // Junk entries (too short, non-hex, flag-shaped) drop; the rest survive.
  assert.deepEqual(sanitizeShaList('abc,deadbeef,-x,zzzz'), ['deadbeef']);
  // Array input works too (the route carries an array).
  assert.deepEqual(sanitizeShaList(['aaaa', 'bbbb']), ['aaaa', 'bbbb']);
  // Empty / nullish degrade to an empty list.
  assert.deepEqual(sanitizeShaList(''), []);
  assert.deepEqual(sanitizeShaList(null), []);
  assert.deepEqual(sanitizeShaList(undefined), []);
});

test('sanitizeShaList caps the list at MAX_GRAPH_COMMITS', () => {
  // Build more distinct shas than the cap and confirm it truncates.
  const many = Array.from({ length: MAX_GRAPH_COMMITS + 25 }, (_, i) =>
    (i + 0x100000).toString(16),
  );
  const out = sanitizeShaList(many.join(','));
  assert.equal(out.length, MAX_GRAPH_COMMITS);
  assert.equal(out[0], many[0]); // first-seen order kept
});

test('buildHash emits graph?commits= for a sha-restricted graph', () => {
  assert.equal(
    buildHash({ view: 'graph', commits: ['aaaa1111', 'bbbb2222'] }),
    'graph?commits=aaaa1111%2Cbbbb2222',
  );
  // An all-junk / empty list degrades to the bare graph (empty hash).
  assert.equal(buildHash({ view: 'graph', commits: ['nothex'] }), '');
  assert.equal(buildHash({ view: 'graph', commits: [] }), '');
});

test('a commit permalink still wins over a commits list shape', () => {
  // A graph route carrying a sha is the W27 permalink; commits is undefined.
  assert.equal(buildHash({ view: 'graph', sha: 'a1b2c3d4' }), 'commit/a1b2c3d4');
});

test('parseHash reads a graph?commits= link back', () => {
  assert.deepEqual(parseHash('#graph?commits=aaaa1111%2Cbbbb2222'), {
    view: 'graph',
    commits: ['aaaa1111', 'bbbb2222'],
  });
  // A blank/garbage commits param degrades to the bare graph.
  assert.deepEqual(parseHash('#graph?commits='), { view: 'graph' });
  assert.deepEqual(parseHash('#graph?commits=zzzz'), { view: 'graph' });
  // A bare #graph stays the plain graph route.
  assert.deepEqual(parseHash('#graph'), { view: 'graph' });
});

test('buildHash(parseHash(x)) round-trips a graph commits link', () => {
  const original = 'graph?commits=aaaa1111%2Cbbbb2222';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── Blame author-isolate deep-link (W76) ─────────────────────────────

test('sanitizeBlameAuthor cleans control chars + whitespace, bounds length', () => {
  assert.equal(sanitizeBlameAuthor('Ada Lovelace'), 'Ada Lovelace');
  assert.equal(sanitizeBlameAuthor('  Grace  Hopper  '), 'Grace Hopper'); // collapse + trim
  assert.equal(sanitizeBlameAuthor('Bjarne\tStroustrup'), 'Bjarne Stroustrup'); // tab -> space
  // Empty / nullish -> null (degrades to a non-isolated view).
  assert.equal(sanitizeBlameAuthor(''), null);
  assert.equal(sanitizeBlameAuthor('   '), null);
  assert.equal(sanitizeBlameAuthor(null), null);
  assert.equal(sanitizeBlameAuthor(undefined), null);
  // Length is bounded.
  assert.equal(sanitizeBlameAuthor('x'.repeat(200)).length, 160);
});

test('buildHash emits an author= param on a blame link when isolated', () => {
  assert.equal(
    buildHash({ view: 'blame', path: 'src/main.ts', author: 'Ada Lovelace' }),
    'blame?path=src%2Fmain.ts&author=Ada+Lovelace',
  );
  // No author -> the bare blame path link (no author param).
  assert.equal(buildHash({ view: 'blame', path: 'src/main.ts' }), 'blame?path=src%2Fmain.ts');
  // An empty author degrades to no param.
  assert.equal(buildHash({ view: 'blame', path: 'src/main.ts', author: '  ' }), 'blame?path=src%2Fmain.ts');
});

test('buildHash combines a line range with an isolated author', () => {
  assert.equal(
    buildHash({ view: 'blame', path: 'a.ts', line: 10, lineEnd: 20, author: 'Ada' }),
    'blame?path=a.ts&line=10-20&author=Ada',
  );
});

test('parseHash reads a blame author= param back', () => {
  assert.deepEqual(parseHash('#blame?path=src%2Fmain.ts&author=Ada+Lovelace'), {
    view: 'blame',
    path: 'src/main.ts',
    author: 'Ada Lovelace',
  });
  // A blank author param is dropped (non-isolated view).
  assert.deepEqual(parseHash('#blame?path=a.ts&author='), { view: 'blame', path: 'a.ts' });
});

test('buildHash(parseHash(x)) round-trips a blame author link', () => {
  const original = 'blame?path=src%2Fmain.ts&author=Ada+Lovelace';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── Blame ownership-band deep-link (W118) ────────────────────────────

test('sanitizeOwnershipBand accepts only the two W116 bands', () => {
  assert.equal(sanitizeOwnershipBand('concentrated'), 'concentrated');
  assert.equal(sanitizeOwnershipBand('spread-thin'), 'spread-thin');
  assert.equal(sanitizeOwnershipBand('  Concentrated  '), 'concentrated'); // trim + lowercase
  // Anything else degrades to the full legend.
  assert.equal(sanitizeOwnershipBand('spread thin'), null); // space form not accepted
  assert.equal(sanitizeOwnershipBand('balanced'), null);
  assert.equal(sanitizeOwnershipBand(''), null);
  assert.equal(sanitizeOwnershipBand(null), null);
  assert.equal(sanitizeOwnershipBand(undefined), null);
});

test('buildHash emits an own= param on a blame link when a band is set', () => {
  assert.equal(
    buildHash({ view: 'blame', path: 'src/main.ts', own: 'concentrated' }),
    'blame?path=src%2Fmain.ts&own=concentrated',
  );
  // No band -> no own param.
  assert.equal(buildHash({ view: 'blame', path: 'src/main.ts' }), 'blame?path=src%2Fmain.ts');
  // own combines with the W76 author isolate.
  assert.equal(
    buildHash({ view: 'blame', path: 'a.ts', author: 'Ada', own: 'spread-thin' }),
    'blame?path=a.ts&author=Ada&own=spread-thin',
  );
});

test('parseHash reads a blame own= param back', () => {
  assert.deepEqual(parseHash('#blame?path=a.ts&own=concentrated'), {
    view: 'blame',
    path: 'a.ts',
    own: 'concentrated',
  });
  // A junk band is dropped (full legend).
  assert.deepEqual(parseHash('#blame?path=a.ts&own=bogus'), { view: 'blame', path: 'a.ts' });
});

test('buildHash(parseHash(x)) round-trips a blame ownership link', () => {
  const original = 'blame?path=a.ts&author=Ada&own=spread-thin';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── Author-week graph deep-link (W85) ────────────────────────────────

test('sanitizeAuthorFilter cleans control chars + bounds, keeps spaces', () => {
  assert.equal(sanitizeAuthorFilter('Ada Lovelace'), 'Ada Lovelace');
  assert.equal(sanitizeAuthorFilter('  ada@x.io  '), 'ada@x.io');
  // eslint-disable-next-line no-control-regex
  assert.equal(sanitizeAuthorFilter('Ada\u0000\tLovelace'), 'Ada Lovelace');
  assert.equal(sanitizeAuthorFilter('   '), null);
  assert.equal(sanitizeAuthorFilter(''), null);
  assert.equal(sanitizeAuthorFilter('x'.repeat(200))?.length, 160);
});

test('buildHash emits graph?author=&since=&until= for a week scope', () => {
  assert.equal(
    buildHash({ view: 'graph', author: 'ada@x.io', since: '2026-06-01', until: '2026-06-07' }),
    'graph?author=ada%40x.io&since=2026-06-01&until=2026-06-07',
  );
});

test('buildHash degrades a week scope to bare graph when a part is unsafe', () => {
  // Empty author.
  assert.equal(buildHash({ view: 'graph', author: '  ', since: '2026-06-01', until: '2026-06-07' }), '');
  // Shape-invalid day keys (sanitizeDayKey validates the YYYY-MM-DD shape, the
  // same contract as the W79 day panel).
  assert.equal(buildHash({ view: 'graph', author: 'Ada', since: 'nope', until: '2026-06-07' }), '');
  assert.equal(buildHash({ view: 'graph', author: 'Ada', since: '2026-06-01', until: '2026-6-7' }), '');
});

test('parseHash reads a graph author-week link back', () => {
  assert.deepEqual(parseHash('#graph?author=Ada+Lovelace&since=2026-06-01&until=2026-06-07'), {
    view: 'graph',
    author: 'Ada Lovelace',
    since: '2026-06-01',
    until: '2026-06-07',
  });
});

test('parseHash drops a graph author-week scope with a junk day', () => {
  // Missing until -> not a week scope; no commits either -> bare graph.
  assert.deepEqual(parseHash('#graph?author=Ada&since=2026-06-01'), { view: 'graph' });
  assert.deepEqual(parseHash('#graph?author=Ada&since=bad&until=2026-06-07'), { view: 'graph' });
});

test('author-week wins over a commits= list on the same graph hash', () => {
  // Both present -> the author-week scope is read (mutually exclusive design).
  assert.deepEqual(
    parseHash('#graph?author=Ada&since=2026-06-01&until=2026-06-07&commits=abcd1234'),
    { view: 'graph', author: 'Ada', since: '2026-06-01', until: '2026-06-07' },
  );
});

test('buildHash(parseHash(x)) round-trips a graph author-week link', () => {
  const original = 'graph?author=Ada+Lovelace&since=2026-06-01&until=2026-06-07';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

// ── rail divergence sort deep-link (W113) ────────────────────────────

test('sanitizeRailSort accepts divergence (case/space-tolerant), rejects rest', () => {
  assert.equal(sanitizeRailSort('divergence'), 'divergence');
  assert.equal(sanitizeRailSort('  DIVERGENCE '), 'divergence');
  assert.equal(sanitizeRailSort('name'), null);
  assert.equal(sanitizeRailSort(''), null);
  assert.equal(sanitizeRailSort(null), null);
});

test('buildHash emits graph?railsort=divergence only when the sort is on', () => {
  assert.equal(buildHash({ view: 'graph', railSort: 'divergence' }), 'graph?railsort=divergence');
  // No railSort -> bare graph clears the hash; a junk value degrades too.
  assert.equal(buildHash({ view: 'graph' }), '');
  assert.equal(buildHash({ view: 'graph', railSort: 'bogus' }), '');
});

test('parseHash reads a rail divergence sort into a graph route', () => {
  assert.deepEqual(parseHash('#graph?railsort=divergence'), { view: 'graph', railSort: 'divergence' });
  // A junk railsort degrades to the bare graph (natural sections).
  assert.deepEqual(parseHash('#graph?railsort=lol'), { view: 'graph' });
});

test('buildHash(parseHash(x)) round-trips the rail divergence sort', () => {
  const original = 'graph?railsort=divergence';
  const parsed = parseHash(original);
  assert.ok(parsed);
  assert.equal(buildHash(parsed), original);
});

test('a sha permalink wins over a rail sort param on the same graph hash', () => {
  // commit/<sha> takes the permalink path before any ?railsort.
  assert.deepEqual(parseHash('#commit/abcd1234'), { view: 'graph', sha: 'abcd1234' });
});

// ── Contributor sort deep-link / palette agreement (W129) ────────────
//
// The W123 command palette emits one `contrib-sort:<key>` per supported sort
// (via contributorSortPaletteItems, gated by isContributorSort on run); the W66
// deep link encodes/restores the sort via sanitizeContributorSort. These two
// surfaces must agree on the key set, or a palette-switched sort could fail to
// survive a reload. This audit locks that agreement (mirrors W101/W106/W111).

test('every key the W123 palette can emit survives the W66 deep-link sanitiser', () => {
  // The palette source emits an entry per supported sort except the active one;
  // unioning across all four actives covers the full key set it can ever run.
  const emitted = new Set();
  for (const active of ['commits', 'churn', 'recent', 'name']) {
    for (const item of contributorSortPaletteItems(active)) emitted.add(item.sort);
  }
  // Every emitted key is a real sort the deep-link accepts (no orphan key).
  for (const key of emitted) {
    assert.ok(isContributorSort(key), `${key} must be a real ContributorSort`);
    assert.equal(sanitizeContributorSort(key), key, `${key} must round-trip the deep-link sanitiser`);
  }
});

test('a palette-switched sort round-trips through the contributors deep link', () => {
  // Run-path keys other than the default (commits) encode + parse back intact;
  // commits is the default so it correctly degrades to the bare tab.
  for (const sort of ['churn', 'recent', 'name']) {
    const hash = buildHash({ view: 'contributors', sort });
    assert.equal(hash, `contributors?sort=${sort}`);
    assert.deepEqual(parseHash(`#${hash}`), { view: 'contributors', sort });
  }
  // The default sort stays the bare tab (no junk param), and parses back to it.
  assert.equal(buildHash({ view: 'contributors', sort: 'commits' }), 'contributors');
  assert.deepEqual(parseHash('#contributors'), { view: 'contributors' });
});
