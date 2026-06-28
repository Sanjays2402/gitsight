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
  stepMatch,
  matchSummary,
  shouldRevealEmpty,
  emptyFilterMessage,
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

// ── Match-list keyboard stepping (W70) ───────────────────────────────

test('stepMatch wraps forward and backward through the list', () => {
  // Forward through a 3-item list.
  assert.equal(stepMatch(3, 0, 1), 1);
  assert.equal(stepMatch(3, 1, 1), 2);
  // Past the end wraps to the start.
  assert.equal(stepMatch(3, 2, 1), 0);
  // Backward.
  assert.equal(stepMatch(3, 2, -1), 1);
  assert.equal(stepMatch(3, 0, -1), 2); // before the start wraps to the end
});

test('stepMatch starts from nothing-focused at an end', () => {
  // Down with nothing focused -> the first match.
  assert.equal(stepMatch(3, -1, 1), 0);
  // Up with nothing focused -> the last match.
  assert.equal(stepMatch(3, -1, -1), 2);
});

test('stepMatch handles an empty list and a zero delta', () => {
  assert.equal(stepMatch(0, -1, 1), -1);
  assert.equal(stepMatch(0, 0, -1), -1);
  // A zero delta keeps the focus where it is (clamped into range).
  assert.equal(stepMatch(3, 1, 0), 1);
  assert.equal(stepMatch(3, -1, 0), -1);
  assert.equal(stepMatch(3, 5, 0), 2); // out-of-range clamps to the last
});

test('stepMatch on a single-item list always lands on 0', () => {
  assert.equal(stepMatch(1, -1, 1), 0);
  assert.equal(stepMatch(1, 0, 1), 0); // wrap back onto itself
  assert.equal(stepMatch(1, 0, -1), 0);
});

// ── Match-count badge (W74) ──────────────────────────────────────────

test('matchSummary reports a plain count when nothing is focused', () => {
  assert.equal(matchSummary(12, -1), '12 matches');
  // Singular for one match.
  assert.equal(matchSummary(1, -1), '1 match');
});

test('matchSummary reports a 1-based position once a match is focused', () => {
  assert.equal(matchSummary(12, 0), '1 of 12');
  assert.equal(matchSummary(12, 4), '5 of 12');
  assert.equal(matchSummary(12, 11), '12 of 12');
});

test('matchSummary says "No matches" for an empty match set', () => {
  assert.equal(matchSummary(0, -1), 'No matches');
  assert.equal(matchSummary(0, 3), 'No matches'); // focus is meaningless at 0
  assert.equal(matchSummary(-1, -1), 'No matches');
});

test('matchSummary clamps an out-of-range focus index defensively', () => {
  // A stale focus past the end clamps to the last position rather than over-counting.
  assert.equal(matchSummary(3, 9), '3 of 3');
});

// ── Empty-match reveal (W78) ─────────────────────────────────────────

test('shouldRevealEmpty is true only for a non-empty query with no matches', () => {
  assert.equal(shouldRevealEmpty('fix', 0), true);
  // A blank/whitespace query matches everything -> never reveal.
  assert.equal(shouldRevealEmpty('', 0), false);
  assert.equal(shouldRevealEmpty('   ', 0), false);
  // A query WITH matches -> don't reveal the empty state.
  assert.equal(shouldRevealEmpty('fix', 3), false);
});

test('emptyFilterMessage shows the typed query verbatim (not lowercased)', () => {
  assert.equal(emptyFilterMessage('FixBug', 0), 'No commits match \u201cFixBug\u201d');
  // Trims surrounding whitespace for display.
  assert.equal(emptyFilterMessage('  Ada  ', 0), 'No commits match \u201cAda\u201d');
});

test('emptyFilterMessage is empty when there is a match or a blank query', () => {
  assert.equal(emptyFilterMessage('fix', 2), '');
  assert.equal(emptyFilterMessage('', 0), '');
});

test('emptyFilterMessage ellipsises a very long query', () => {
  const long = 'a'.repeat(80);
  const msg = emptyFilterMessage(long, 0);
  assert.ok(msg.includes('\u2026'));
  // 60 kept + the ellipsis, wrapped in the quotes + prefix.
  assert.ok(msg.includes('a'.repeat(60) + '\u2026'));
});
