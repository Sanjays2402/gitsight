import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCoAuthors, formatCoAuthors, coAuthorTrailerLines } from '../../src/git/coAuthors';

test('parseCoAuthors: parses canonical trailer block', () => {
  const msg = [
    'feat: add cool thing',
    '',
    'Body talking about the change.',
    '',
    'Co-authored-by: Alice <alice@example.com>',
    'Co-authored-by: Bob <bob@example.com>',
  ].join('\n');
  const got = parseCoAuthors(msg);
  assert.deepEqual(got, [
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ]);
});

test('parseCoAuthors: case-insensitive, trims whitespace', () => {
  const msg = '  CO-Authored-By:   Cake  <Cake@Example.com>  ';
  assert.deepEqual(parseCoAuthors(msg), [{ name: 'Cake', email: 'cake@example.com' }]);
});

test('parseCoAuthors: de-duplicates by email', () => {
  const msg = [
    'Co-authored-by: Alice <alice@example.com>',
    'Co-authored-by: Alice the Second <alice@example.com>',
    'Co-authored-by: Bob <bob@example.com>',
  ].join('\n');
  const got = parseCoAuthors(msg);
  assert.equal(got.length, 2);
  assert.equal(got[0].name, 'Alice');
  assert.equal(got[1].name, 'Bob');
});

test('parseCoAuthors: empty / missing trailers → empty list', () => {
  assert.deepEqual(parseCoAuthors(''), []);
  assert.deepEqual(parseCoAuthors('feat: nothing\n\nNo trailers here.'), []);
});

test('parseCoAuthors: skips malformed lines (no email, no Co- prefix)', () => {
  const msg = [
    'Signed-off-by: Alice <alice@example.com>',
    'Co-authored-by: Bob',           // missing email
    'Co-authored-by: <only@email>',  // missing name
    'Co-authored-by: Carol <carol@example.com>',
  ].join('\n');
  const got = parseCoAuthors(msg);
  // Only the well-formed Carol entry survives — and the no-name entry is
  // rejected because the regex requires at least one char before the email.
  assert.deepEqual(got, [{ name: 'Carol', email: 'carol@example.com' }]);
});

test('formatCoAuthors + coAuthorTrailerLines round-trip', () => {
  const authors = [{ name: 'Alice', email: 'alice@example.com' }];
  assert.equal(formatCoAuthors(authors), 'Alice <alice@example.com>');
  assert.deepEqual(coAuthorTrailerLines(authors), ['Co-authored-by: Alice <alice@example.com>']);
});
