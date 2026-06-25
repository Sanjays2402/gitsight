import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  tokenizeQuery,
  parseQueryDate,
  parseQuery,
  termMatches,
  commitMatchesQuery,
  filterCommits,
  isStructuredQuery,
} from '../../src/shared/commitQuery';

function commit(over = {}) {
  return {
    sha: 'a1b2c3d4e5f6',
    shortSha: 'a1b2c3d',
    author: 'Ada Lovelace',
    email: 'ada@example.com',
    subject: 'feat: add lane layout',
    date: '2026-06-20T09:00:00Z',
    refs: ['HEAD -> main', 'origin/main'],
    ...over,
  };
}

// ── tokenizeQuery ────────────────────────────────────────────────────

test('tokenizeQuery splits field:value, quoted values, and bare terms', () => {
  assert.deepEqual(tokenizeQuery('author:ada grep:lane'), [
    { key: 'author', value: 'ada' },
    { key: 'grep', value: 'lane' },
  ]);
  assert.deepEqual(tokenizeQuery('author:"Ada Lovelace"'), [
    { key: 'author', value: 'Ada Lovelace' },
  ]);
  assert.deepEqual(tokenizeQuery('"just text" bare'), [
    { key: null, value: 'just text' },
    { key: null, value: 'bare' },
  ]);
});

// ── parseQueryDate ───────────────────────────────────────────────────

test('parseQueryDate handles YYYY-MM-DD and full ISO, NaN otherwise', () => {
  assert.equal(Number.isNaN(parseQueryDate('not-a-date')), true);
  assert.equal(parseQueryDate('2026-06-20'), Date.parse('2026-06-20T00:00:00'));
  assert.equal(parseQueryDate('2026-06-20T12:00:00Z'), Date.parse('2026-06-20T12:00:00Z'));
});

// ── parseQuery ───────────────────────────────────────────────────────

test('parseQuery maps aliases to canonical fields', () => {
  const q = parseQuery('by:ada subject:lane branch:main after:2026-01-01');
  assert.deepEqual(
    q.terms.map(t => t.field),
    ['author', 'grep', 'ref', 'since'],
  );
});

test('parseQuery keeps an unknown key:value as literal text', () => {
  const q = parseQuery('fix:bug');
  assert.equal(q.terms.length, 1);
  assert.equal(q.terms[0].field, 'text');
  assert.equal(q.terms[0].value, 'fix:bug');
});

test('parseQuery attaches an epoch to date terms (NaN when bad)', () => {
  const q = parseQuery('since:2026-06-20 until:garbage');
  const since = q.terms.find(t => t.field === 'since')!;
  const until = q.terms.find(t => t.field === 'until')!;
  assert.equal(since.epoch, Date.parse('2026-06-20T00:00:00'));
  assert.equal(Number.isNaN(until.epoch), true);
});

// ── termMatches ──────────────────────────────────────────────────────

test('author term matches name or email, case-insensitive', () => {
  assert.equal(termMatches({ field: 'author', value: 'LOVELACE' }, commit()), true);
  assert.equal(termMatches({ field: 'author', value: 'ada@example' }, commit()), true);
  assert.equal(termMatches({ field: 'author', value: 'sanjay' }, commit()), false);
});

test('grep term matches the subject only', () => {
  assert.equal(termMatches({ field: 'grep', value: 'lane' }, commit()), true);
  assert.equal(termMatches({ field: 'grep', value: 'ada' }, commit()), false);
});

test('ref term matches any decoration ref', () => {
  assert.equal(termMatches({ field: 'ref', value: 'origin' }, commit()), true);
  assert.equal(termMatches({ field: 'ref', value: 'feature' }, commit()), false);
});

test('sha term matches a full or short prefix', () => {
  assert.equal(termMatches({ field: 'sha', value: 'a1b2' }, commit()), true);
  assert.equal(termMatches({ field: 'sha', value: 'a1b2c3d4e5f6' }, commit()), true);
  assert.equal(termMatches({ field: 'sha', value: 'ffff' }, commit()), false);
});

test('since/until bound by commit date and ignore bad dates', () => {
  const c = commit({ date: '2026-06-20T09:00:00Z' });
  assert.equal(termMatches({ field: 'since', value: 'x', epoch: Date.parse('2026-06-19T00:00:00Z') }, c), true);
  assert.equal(termMatches({ field: 'since', value: 'x', epoch: Date.parse('2026-06-21T00:00:00Z') }, c), false);
  assert.equal(termMatches({ field: 'until', value: 'x', epoch: Date.parse('2026-06-21T00:00:00Z') }, c), true);
  // NaN epoch is ignored (term passes), so a half-typed date doesn't blank.
  assert.equal(termMatches({ field: 'since', value: 'x', epoch: NaN }, c), true);
});

// ── commitMatchesQuery (AND) ─────────────────────────────────────────

test('commitMatchesQuery ANDs all terms; empty query matches all', () => {
  assert.equal(commitMatchesQuery(commit(), parseQuery('')), true);
  assert.equal(commitMatchesQuery(commit(), parseQuery('author:ada grep:lane')), true);
  assert.equal(commitMatchesQuery(commit(), parseQuery('author:ada grep:nomatch')), false);
});

// ── filterCommits ────────────────────────────────────────────────────

test('filterCommits narrows a list by a structured query', () => {
  const list = [
    commit({ shortSha: 'aaa1111', author: 'Ada Lovelace', subject: 'feat: x' }),
    commit({ shortSha: 'bbb2222', author: 'Sanjay', subject: 'fix: y' }),
    commit({ shortSha: 'ccc3333', author: 'Ada Lovelace', subject: 'docs: z' }),
  ];
  const out = filterCommits(list, 'author:ada');
  assert.deepEqual(out.map(c => c.shortSha), ['aaa1111', 'ccc3333']);
  // Empty query returns the same array reference contents.
  assert.equal(filterCommits(list, '').length, 3);
});

// ── isStructuredQuery ────────────────────────────────────────────────

test('isStructuredQuery detects field-scoped terms', () => {
  assert.equal(isStructuredQuery('author:ada'), true);
  assert.equal(isStructuredQuery('just text'), false);
  assert.equal(isStructuredQuery('fix:bug'), false); // unknown key -> text
});
