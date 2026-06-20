import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { truncate, buildRestorePickItems } from '../../src/git/restorePick';

const fakeAgo = (_d: Date) => '3d ago';

const COMMITS = [
  {
    sha: 'aaaaaaa1111',
    shortSha: 'aaaaaaa',
    parents: [],
    author: 'Alice',
    email: 'alice@example.com',
    date: new Date('2026-06-15T10:00:00Z'),
    subject: 'feat: a',
    body: 'first line of the body\nsecond line',
    refs: [],
  },
  {
    sha: 'bbbbbbb2222',
    shortSha: 'bbbbbbb',
    parents: [],
    author: 'Bob',
    email: 'bob@example.com',
    date: new Date('2026-06-12T10:00:00Z'),
    subject: 'fix: b',
    body: '',
    refs: [],
  },
];

test('truncate keeps short strings, ellipsises long ones', () => {
  assert.equal(truncate('hi', 10), 'hi');
  assert.equal(truncate('abcdefghij', 10), 'abcdefghij');
  assert.equal(truncate('abcdefghijk', 10), 'abcdefghi…');
  assert.equal(truncate('', 10), '');
});

test('buildRestorePickItems produces label/description/detail per commit', () => {
  const items = buildRestorePickItems(COMMITS as any, fakeAgo);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, '$(git-commit) feat: a');
  assert.equal(items[0].description, 'aaaaaaa  ·  Alice  ·  3d ago');
  assert.equal(items[0].detail, 'first line of the body');
});

test('buildRestorePickItems: empty body falls back to full sha as detail', () => {
  const items = buildRestorePickItems(COMMITS as any, fakeAgo);
  assert.equal(items[1].detail, 'bbbbbbb2222');
});

test('buildRestorePickItems: caps detail to 120 chars', () => {
  const long = {
    ...COMMITS[0],
    body: 'x'.repeat(200),
  };
  const items = buildRestorePickItems([long] as any, fakeAgo);
  assert.equal(items[0].detail.length, 120);
  assert.ok(items[0].detail.endsWith('…'));
});

test('buildRestorePickItems: preserves order of input commits', () => {
  const items = buildRestorePickItems(COMMITS as any, fakeAgo);
  assert.deepEqual(items.map(i => i.shortSha), ['aaaaaaa', 'bbbbbbb']);
});

test('buildRestorePickItems: passes sha + subject through unchanged', () => {
  const items = buildRestorePickItems(COMMITS as any, fakeAgo);
  assert.equal(items[0].sha, 'aaaaaaa1111');
  assert.equal(items[0].subject, 'feat: a');
});
