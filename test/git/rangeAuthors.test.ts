import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  summariseRangeAuthors,
  formatRangeAuthorLine,
  isRangeExpr,
} from '../../src/git/rangeAuthors';

const SAMPLE = [
  '   42  Alice <alice@example.com>',
  '   18  Bob <bob@example.com>',
  '    9  Carol <CAROL@Example.com>',
].join('\n');

test('summariseRangeAuthors: parses shortlog rows, sorted desc, percentages add up', () => {
  const s = summariseRangeAuthors(SAMPLE);
  assert.equal(s.totalCommits, 69);
  assert.equal(s.totalAuthors, 3);
  assert.equal(s.authors[0].name, 'Alice');
  assert.equal(s.authors[0].commits, 42);
  assert.equal(s.authors[2].email, 'carol@example.com', 'email lowercased');
  const sum = s.authors.reduce((a, b) => a + b.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'shares sum to 1');
});

test('summariseRangeAuthors: empty input → zero everything', () => {
  const s = summariseRangeAuthors('');
  assert.deepEqual(s, { authors: [], totalCommits: 0, totalAuthors: 0 });
});

test('summariseRangeAuthors: skips malformed rows and zero counts', () => {
  const raw = [
    '   not a row',
    '    0  Zero <zero@example.com>',
    '   ?  Bad <bad@example.com>',
    '   12  Real <real@example.com>',
  ].join('\n');
  const s = summariseRangeAuthors(raw);
  assert.equal(s.totalAuthors, 1);
  assert.equal(s.authors[0].name, 'Real');
});

test('summariseRangeAuthors: handles single-author 100% case', () => {
  const s = summariseRangeAuthors('   3  Solo <solo@example.com>');
  assert.equal(s.authors[0].share, 1);
});

test('formatRangeAuthorLine renders rounded percentages', () => {
  const line = formatRangeAuthorLine({ name: 'Alice', email: 'a@x', commits: 1, share: 0.3333 });
  assert.equal(line, 'Alice — 1 (33%)');
});

test('isRangeExpr accepts a..b and a...b only', () => {
  assert.equal(isRangeExpr('main..feature'), true);
  assert.equal(isRangeExpr('main...feature'), true);
  assert.equal(isRangeExpr('HEAD~5..HEAD'), true);
  assert.equal(isRangeExpr('main'), false);
  assert.equal(isRangeExpr(''), false);
  assert.equal(isRangeExpr('main feature'), false);
});
