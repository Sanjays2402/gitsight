/**
 * Compare-view pure-helper tests (W18).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  compareGlyph,
  compareLabel,
  compareChurn,
  splitComparePath,
  sanitizeRef,
  normalizeCommitQuery,
  commitMatchesQuery,
  filterCompareCommits,
  firstCompareMatch,
} from './compareFormat.ts';

test('compareGlyph maps each status to a single letter', () => {
  assert.equal(compareGlyph('added'), 'A');
  assert.equal(compareGlyph('modified'), 'M');
  assert.equal(compareGlyph('deleted'), 'D');
  assert.equal(compareGlyph('renamed'), 'R');
  assert.equal(compareGlyph('copied'), 'C');
  assert.equal(compareGlyph('typechange'), 'T');
  assert.equal(compareGlyph('unknown'), '?');
});

test('compareLabel expands typechange but passes others through', () => {
  assert.equal(compareLabel('typechange'), 'type change');
  assert.equal(compareLabel('added'), 'added');
});

test('compareChurn formats +/-, binary, and mode-only', () => {
  assert.deepEqual(compareChurn({ insertions: 5, deletions: 2, binary: false }), {
    binary: false,
    insertions: 5,
    deletions: 2,
    text: '+5 -2',
  });
  assert.equal(compareChurn({ insertions: -1, deletions: -1, binary: true }).text, 'binary');
  assert.equal(compareChurn({ insertions: 0, deletions: 0, binary: false }).text, '0');
  assert.equal(compareChurn({ insertions: 3, deletions: 0, binary: false }).text, '+3');
});

test('splitComparePath separates dir from basename', () => {
  assert.deepEqual(splitComparePath('src/web/main.ts'), { dir: 'src/web/', name: 'main.ts' });
  assert.deepEqual(splitComparePath('README.md'), { dir: '', name: 'README.md' });
});

test('sanitizeRef accepts valid refs and rejects unsafe input', () => {
  assert.equal(sanitizeRef('  main  '), 'main');
  assert.equal(sanitizeRef('feature/foo-bar'), 'feature/foo-bar');
  assert.equal(sanitizeRef('v1.2.0'), 'v1.2.0');
  assert.equal(sanitizeRef('HEAD~3'), 'HEAD~3');
  assert.equal(sanitizeRef(''), null);
  assert.equal(sanitizeRef('   '), null);
  assert.equal(sanitizeRef('--output=x'), null);
  assert.equal(sanitizeRef('a b'), null);
  assert.equal(sanitizeRef('x'.repeat(201)), null);
});

// ── Commit-list filtering (W54) ──────────────────────────────────────

const COMMITS = [
  { sha: 'aaaa1111bbbb2222', shortSha: 'aaaa111', author: 'Ada Lovelace', subject: 'Fix the lane layout off-by-one' },
  { sha: 'cccc3333dddd4444', shortSha: 'cccc333', author: 'Bjarne S', subject: 'Add stash split toggle' },
  { sha: 'eeee5555ffff6666', shortSha: 'eeee555', author: 'Ada Lovelace', subject: 'Document the compare grammar' },
];

test('normalizeCommitQuery trims and lowercases', () => {
  assert.equal(normalizeCommitQuery('  Lane  '), 'lane');
  assert.equal(normalizeCommitQuery(''), '');
  assert.equal(normalizeCommitQuery('   '), '');
});

test('commitMatchesQuery matches subject, author, and either sha form', () => {
  // Subject substring (case-insensitive).
  assert.equal(commitMatchesQuery(COMMITS[0], 'lane'), true);
  assert.equal(commitMatchesQuery(COMMITS[0], 'LANE'), true);
  // Author substring.
  assert.equal(commitMatchesQuery(COMMITS[0], 'ada'), true);
  // Full sha prefix and short sha both hit.
  assert.equal(commitMatchesQuery(COMMITS[1], 'cccc3333'), true);
  assert.equal(commitMatchesQuery(COMMITS[1], 'cccc333'), true);
  // No match.
  assert.equal(commitMatchesQuery(COMMITS[1], 'lane'), false);
  // Empty query matches everything.
  assert.equal(commitMatchesQuery(COMMITS[1], ''), true);
  assert.equal(commitMatchesQuery(COMMITS[1], '   '), true);
});

test('filterCompareCommits narrows by query, preserving order + identity', () => {
  const adaCommits = filterCompareCommits(COMMITS, 'ada');
  assert.equal(adaCommits.length, 2);
  assert.equal(adaCommits[0], COMMITS[0]); // same object, original order
  assert.equal(adaCommits[1], COMMITS[2]);
  // Empty query returns a fresh copy of the whole list.
  const all = filterCompareCommits(COMMITS, '');
  assert.deepEqual(all, COMMITS);
  assert.notEqual(all, COMMITS); // new array
  // No matches -> empty.
  assert.deepEqual(filterCompareCommits(COMMITS, 'zzzzz'), []);
});

// ── First match -> jump (W62) ────────────────────────────────────────

test('firstCompareMatch returns the first ahead-column match', () => {
  const ahead = [COMMITS[1]]; // "Add stash split toggle" by Bjarne
  const behind = [COMMITS[0], COMMITS[2]]; // both Ada
  // "ada" matches only the behind column here.
  assert.equal(firstCompareMatch(ahead, behind, 'ada'), COMMITS[0]);
});

test('firstCompareMatch searches ahead before behind', () => {
  // Both columns carry an "ada" match; the ahead one wins.
  const ahead = [COMMITS[2]];
  const behind = [COMMITS[0]];
  assert.equal(firstCompareMatch(ahead, behind, 'ada'), COMMITS[2]);
});

test('firstCompareMatch returns null for no match or empty query', () => {
  assert.equal(firstCompareMatch(COMMITS, [], 'zzzzz'), null);
  assert.equal(firstCompareMatch(COMMITS, COMMITS, ''), null);
  assert.equal(firstCompareMatch(COMMITS, COMMITS, '   '), null);
  assert.equal(firstCompareMatch([], [], 'ada'), null);
});

test('firstCompareMatch resolves a sha prefix', () => {
  assert.equal(firstCompareMatch([], COMMITS, 'cccc333'), COMMITS[1]);
});
