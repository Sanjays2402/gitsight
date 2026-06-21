import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildCoAuthorSuggestions,
  buildTrailerBlock,
  insertTrailers,
} from '../../src/git/coAuthorSuggest';

const now = new Date('2026-06-20T12:00:00Z');
const day = (offset: number) => new Date(now.getTime() - offset * 86_400_000);

test('buildCoAuthorSuggestions: extracts authors and trailers, excludes self', () => {
  const commits = [
    {
      sha: 'a',
      authorName: 'Sanjay',
      authorEmail: 'me@example.com',
      message: 'feat: x\n\nCo-authored-by: Alice <alice@example.com>',
      date: day(1),
    },
    {
      sha: 'b',
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      message: 'fix: y',
      date: day(2),
    },
    {
      sha: 'c',
      authorName: 'Sanjay',
      authorEmail: 'me@example.com',
      message: 'docs: z\n\nCo-authored-by: Alice <alice@example.com>',
      date: day(3),
    },
  ];
  const out = buildCoAuthorSuggestions(commits, ['me@example.com'], now);
  const names = out.map(s => s.name);
  assert.deepEqual(names, ['Alice', 'Bob']);
  const alice = out[0];
  assert.equal(alice.count, 2);
  assert.deepEqual([...alice.sources].sort(), ['trailer']);
  assert.equal(out[1].name, 'Bob');
  assert.deepEqual([...out[1].sources], ['author']);
});

test('buildCoAuthorSuggestions: recency boosts more recent contributors', () => {
  const commits = [
    {
      sha: 'old',
      authorName: 'OldFriend',
      authorEmail: 'old@example.com',
      message: 'old',
      date: day(90),
    },
    {
      sha: 'new',
      authorName: 'NewFriend',
      authorEmail: 'new@example.com',
      message: 'new',
      date: day(1),
    },
  ];
  const out = buildCoAuthorSuggestions(commits, ['me@example.com'], now);
  assert.equal(out[0].name, 'NewFriend');
  assert.ok(out[0].score > out[1].score);
});

test('buildCoAuthorSuggestions: case-insensitive email merging', () => {
  const commits = [
    { sha: '1', authorName: 'X', authorEmail: 'X@Y.com', message: '', date: day(1) },
    { sha: '2', authorName: 'X', authorEmail: 'x@y.COM', message: '', date: day(2) },
  ];
  const out = buildCoAuthorSuggestions(commits, [], now);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 2);
  assert.equal(out[0].email, 'x@y.com');
});

test('buildCoAuthorSuggestions: blank emails are dropped', () => {
  const commits = [
    { sha: 'a', authorName: 'Ghost', authorEmail: '', message: '', date: day(1) },
  ];
  assert.deepEqual(buildCoAuthorSuggestions(commits, [], now), []);
});

test('buildTrailerBlock: renders one per line in input order', () => {
  const block = buildTrailerBlock([
    { name: 'A', email: 'a@x' },
    { name: 'B', email: 'b@x' },
  ]);
  assert.equal(block, 'Co-authored-by: A <a@x>\nCo-authored-by: B <b@x>');
});

test('insertTrailers: appends with blank-line separator when missing', () => {
  const out = insertTrailers('feat: x\n\nDoes a thing.', [{ name: 'Alice', email: 'a@x' }]);
  assert.equal(out, 'feat: x\n\nDoes a thing.\n\nCo-authored-by: Alice <a@x>\n');
});

test('insertTrailers: appends without extra blank line when trailer block exists', () => {
  const cur = 'feat: x\n\nCo-authored-by: Bob <b@x>\n';
  const out = insertTrailers(cur, [{ name: 'Alice', email: 'a@x' }]);
  assert.match(out, /Co-authored-by: Bob <b@x>\nCo-authored-by: Alice <a@x>/);
});

test('insertTrailers: de-dupes already-present trailers', () => {
  const cur = 'feat\n\nCo-authored-by: A <a@x>\n';
  const out = insertTrailers(cur, [
    { name: 'A', email: 'A@X' },
    { name: 'B', email: 'b@x' },
  ]);
  assert.match(out, /Co-authored-by: A <a@x>/);
  assert.match(out, /Co-authored-by: B <b@x>/);
  // 'A' must not appear twice.
  assert.equal(out.match(/Co-authored-by: A/g)?.length, 1);
});

test('insertTrailers: empty picks returns input unchanged', () => {
  assert.equal(insertTrailers('hello', []), 'hello');
});
