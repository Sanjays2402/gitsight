import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  tokenise,
  parseQuery,
  buildSearchArgs,
  parseHits,
  describeHits,
  describeQuery,
} from '../../src/git/commitSearch';

// ── tokenise ──────────────────────────────────────────────────────

test('tokenise: simple whitespace split', () => {
  assert.deepEqual(tokenise('foo bar baz'), ['foo', 'bar', 'baz']);
});

test('tokenise: quoted spans preserved', () => {
  assert.deepEqual(tokenise('fix "lex error"'), ['fix', 'lex error']);
});

test('tokenise: trailing-unclosed quote consumes remainder', () => {
  assert.deepEqual(tokenise('"unfinished'), ['unfinished']);
});

test('tokenise: empty input', () => {
  assert.deepEqual(tokenise(''), []);
  assert.deepEqual(tokenise('   '), []);
});

test('tokenise: key:value with quoted value', () => {
  assert.deepEqual(tokenise('author:"alice cooper"'), ['author:alice cooper']);
});

// ── parseQuery ────────────────────────────────────────────────────

test('parseQuery: bare tokens become grep terms', () => {
  const q = parseQuery('parser bug');
  assert.deepEqual(q.grep, ['parser', 'bug']);
  assert.equal(q.regex, false);
});

test('parseQuery: author: prefix', () => {
  const q = parseQuery('author:alice fix');
  assert.deepEqual(q.authors, ['alice']);
  assert.deepEqual(q.grep, ['fix']);
});

test('parseQuery: path: prefix collects paths', () => {
  const q = parseQuery('path:src/ path:test/');
  assert.deepEqual(q.paths, ['src/', 'test/']);
});

test('parseQuery: since/until', () => {
  const q = parseQuery('since:2026-01-01 until:2026-06-01');
  assert.equal(q.since, '2026-01-01');
  assert.equal(q.until, '2026-06-01');
});

test('parseQuery: before: alias for until', () => {
  const q = parseQuery('before:yesterday');
  assert.equal(q.until, 'yesterday');
});

test('parseQuery: case:off disables ignoreCase', () => {
  const q = parseQuery('case:off Fix');
  assert.equal(q.ignoreCase, false);
});

test('parseQuery: max: clamps to hard cap', () => {
  const q = parseQuery('max:99999 foo');
  assert.equal(q.maxCount, 5000);
});

test('parseQuery: max: floors to 1', () => {
  const q = parseQuery('max:0 foo');
  assert.equal(q.maxCount, 1);
});

test('parseQuery: max: ignores non-numeric', () => {
  const q = parseQuery('max:abc foo', { maxCount: 300 });
  assert.equal(q.maxCount, 300);
});

test('parseQuery: re: enables regex flag and adds grep', () => {
  const q = parseQuery('re:^WIP');
  assert.equal(q.regex, true);
  assert.deepEqual(q.grep, ['^WIP']);
});

test('parseQuery: regex: alias for re:', () => {
  const q = parseQuery('regex:^fix');
  assert.equal(q.regex, true);
  assert.deepEqual(q.grep, ['^fix']);
});

test('parseQuery: unknown prefix becomes literal grep', () => {
  const q = parseQuery('foo:bar baz');
  assert.deepEqual(q.grep, ['foo:bar', 'baz']);
});

test('parseQuery: empty query', () => {
  const q = parseQuery('');
  assert.deepEqual(q.grep, []);
  assert.deepEqual(q.authors, []);
  assert.equal(q.maxCount, 200);
  assert.equal(q.raw, '');
});

test('parseQuery: default maxCount honoured', () => {
  const q = parseQuery('foo', { maxCount: 50 });
  assert.equal(q.maxCount, 50);
});

// ── buildSearchArgs ───────────────────────────────────────────────

test('buildSearchArgs: bare grep + ignoreCase', () => {
  const args = buildSearchArgs(parseQuery('parser bug'));
  assert.ok(args.includes('--grep=parser'));
  assert.ok(args.includes('--grep=bug'));
  assert.ok(args.includes('--regexp-ignore-case'));
  assert.ok(args.includes('--max-count=200'));
});

test('buildSearchArgs: regex enables extended-regexp', () => {
  const args = buildSearchArgs(parseQuery('re:^fix'));
  assert.ok(args.includes('--grep=^fix'));
  assert.ok(args.includes('--extended-regexp'));
});

test('buildSearchArgs: author + path together', () => {
  const args = buildSearchArgs(parseQuery('author:alice path:src/'));
  assert.ok(args.includes('--author=alice'));
  assert.ok(args.includes('--'));
  const dashDashIdx = args.indexOf('--');
  assert.ok(dashDashIdx >= 0);
  assert.ok(args[dashDashIdx + 1] === 'src/');
});

test('buildSearchArgs: since/until included', () => {
  const args = buildSearchArgs(parseQuery('since:2026-01-01 until:2026-06-01'));
  assert.ok(args.includes('--since=2026-01-01'));
  assert.ok(args.includes('--until=2026-06-01'));
});

test('buildSearchArgs: case-sensitive omits --regexp-ignore-case', () => {
  const args = buildSearchArgs(parseQuery('case:off Fix'));
  assert.ok(!args.includes('--regexp-ignore-case'));
  assert.ok(args.includes('--grep=Fix'));
});

test('buildSearchArgs: no grep terms omits ignore-case flag entirely', () => {
  const args = buildSearchArgs(parseQuery('author:alice'));
  assert.ok(!args.includes('--regexp-ignore-case'));
});

test('buildSearchArgs: pathspecs come last after --', () => {
  const args = buildSearchArgs(parseQuery('foo path:src/ path:test/'));
  const idx = args.indexOf('--');
  assert.ok(idx >= 0);
  assert.deepEqual(args.slice(idx + 1), ['src/', 'test/']);
});

// ── parseHits ────────────────────────────────────────────────────

test('parseHits: 5-column format', () => {
  const raw = [
    'abc123|abc1234|2026-06-01T12:00:00Z|alice|fix parser bug',
    'def456|def4567|2026-05-01T08:00:00Z|bob|tweak lexer',
  ].join('\n');
  const hits = parseHits(raw);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].author, 'alice');
  assert.equal(hits[0].subject, 'fix parser bug');
});

test('parseHits: subject with pipes preserved', () => {
  const raw = 'sha|sha|2026-06-01|me|fix: foo | bar | baz';
  const hits = parseHits(raw);
  assert.equal(hits[0].subject, 'fix: foo | bar | baz');
});

test('parseHits: empty input', () => {
  assert.deepEqual(parseHits(''), []);
});

// ── describeHits ─────────────────────────────────────────────────

test('describeHits: no matches', () => {
  assert.equal(describeHits([]), 'No matches');
});

test('describeHits: counts + date range', () => {
  const hits = parseHits([
    'a|a|2026-06-01T00:00:00Z|alice|x',
    'b|b|2026-06-15T00:00:00Z|bob|y',
    'c|c|2026-06-20T00:00:00Z|alice|z',
  ].join('\n'));
  const desc = describeHits(hits);
  assert.match(desc, /3 matches/);
  assert.match(desc, /2 authors/);
  assert.match(desc, /2026-06-01.*2026-06-20/);
});

test('describeHits: single match → range collapses', () => {
  const hits = parseHits('a|a|2026-06-01T00:00:00Z|alice|x');
  assert.match(describeHits(hits), /1 match · 1 author · 2026-06-01/);
});

// ── describeQuery ─────────────────────────────────────────────────

test('describeQuery: includes all filters', () => {
  const q = parseQuery('author:alice path:src/ since:2026-01-01 re:^fix max:50');
  const desc = describeQuery(q);
  assert.match(desc, /grep: "\^fix"/);
  assert.match(desc, /author: alice/);
  assert.match(desc, /path: src\//);
  assert.match(desc, /since 2026-01-01/);
  assert.match(desc, /regex/);
  assert.match(desc, /max 50/);
});

test('describeQuery: empty query', () => {
  const q = parseQuery('');
  assert.match(describeQuery(q), /max 200/);
});
