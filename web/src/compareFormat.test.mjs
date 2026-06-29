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
  compareRefPaletteItems,
  compareRouteFromRefs,
  compareRouteError,
  refDivergenceHint,
  refInsightDivergenceHint,
  compareInvalidNotice,
  nextRefSuggestion,
  divergenceClass,
  suggestionLabel,
  compareDivergence,
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

test('compareRefPaletteItems emits both directions per ref (W87)', () => {
  const items = compareRefPaletteItems([{ name: 'main' }, { name: 'dev' }], 'HEAD');
  // Two entries per ref (against-head + from-head).
  assert.equal(items.length, 4);
  assert.deepEqual(items[0], {
    side: 'against-head',
    label: 'Compare main with HEAD',
    base: 'main',
    head: 'HEAD',
  });
  assert.deepEqual(items[1], {
    side: 'from-head',
    label: 'Compare HEAD with main',
    base: 'HEAD',
    head: 'main',
  });
});

test('compareRefPaletteItems skips the current branch and a literal HEAD (W87)', () => {
  const items = compareRefPaletteItems(
    [{ name: 'main' }, { name: 'feature' }, { name: 'HEAD' }],
    'HEAD',
    'main',
  );
  // main is the current branch (no-op vs HEAD) and HEAD is literal -> both skipped.
  const refs = new Set(items.flatMap(i => [i.base, i.head]));
  assert.ok(!refs.has('main'));
  assert.equal(items.filter(i => i.base === 'feature' || i.head === 'feature').length, 2);
});

test('compareRefPaletteItems sanitises and de-dupes refs (W87)', () => {
  const items = compareRefPaletteItems(
    [{ name: 'main' }, { name: 'MAIN' }, { name: '-flag' }, { name: 'has space' }, { name: '' }],
    'HEAD',
  );
  // main de-dupes case-insensitively (one ref -> 2 entries); the flag-shaped,
  // spaced, and empty names are dropped by sanitizeRef.
  assert.equal(items.length, 2);
  assert.equal(items[0].base, 'main');
});

test('compareRefPaletteItems caps the ref count (W87)', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `b${i}` }));
  const items = compareRefPaletteItems(many, 'HEAD', null, 5);
  // 5 refs * 2 directions.
  assert.equal(items.length, 10);
});

// ── Compare ref-pair validation (W92) ────────────────────────────────

test('compareRouteFromRefs accepts a valid pair, trimming each ref (W92)', () => {
  assert.deepEqual(compareRouteFromRefs('  main  ', ' HEAD '), {
    ok: true,
    base: 'main',
    head: 'HEAD',
  });
  assert.deepEqual(compareRouteFromRefs('v1.0.0', 'feature/x'), {
    ok: true,
    base: 'v1.0.0',
    head: 'feature/x',
  });
});

test('compareRouteFromRefs rejects an empty/unsafe base or head (W92)', () => {
  assert.deepEqual(compareRouteFromRefs('', 'HEAD'), { ok: false, reason: 'empty-base' });
  assert.deepEqual(compareRouteFromRefs('   ', 'HEAD'), { ok: false, reason: 'empty-base' });
  // A flag-shaped base fails sanitizeRef -> empty-base.
  assert.deepEqual(compareRouteFromRefs('--output=x', 'HEAD'), { ok: false, reason: 'empty-base' });
  // A valid base but an empty/unsafe head -> empty-head.
  assert.deepEqual(compareRouteFromRefs('main', ''), { ok: false, reason: 'empty-head' });
  assert.deepEqual(compareRouteFromRefs('main', 'a b'), { ok: false, reason: 'empty-head' });
});

test('compareRouteFromRefs rejects a self-comparison (case-insensitive) (W92)', () => {
  assert.deepEqual(compareRouteFromRefs('main', 'main'), { ok: false, reason: 'self-compare' });
  // Same ref differing only by case + surrounding whitespace.
  assert.deepEqual(compareRouteFromRefs('  Main ', 'main'), { ok: false, reason: 'self-compare' });
  assert.deepEqual(compareRouteFromRefs('HEAD', 'head'), { ok: false, reason: 'self-compare' });
  // Different refs are fine.
  assert.equal(compareRouteFromRefs('main', 'dev').ok, true);
});

test('compareRouteError gives a distinct message per reason (W92)', () => {
  assert.match(compareRouteError('empty-base'), /base/i);
  assert.match(compareRouteError('empty-head'), /against/i);
  assert.match(compareRouteError('self-compare'), /different/i);
});

// ── Compare ref palette divergence hint (W95) ────────────────────────

test('refDivergenceHint reads "even with HEAD" when level (W95)', () => {
  assert.equal(refDivergenceHint({ ahead: 0, behind: 0, exact: true }), 'even with HEAD');
  // Negative/zero treated as level too.
  assert.equal(refDivergenceHint({ ahead: 0, behind: 0, exact: false }), 'even with HEAD');
});

test('refDivergenceHint trims a zero side and joins both (W95)', () => {
  assert.equal(refDivergenceHint({ ahead: 3, behind: 0, exact: true }), '3 ahead');
  assert.equal(refDivergenceHint({ ahead: 0, behind: 2, exact: true }), '2 behind');
  assert.equal(refDivergenceHint({ ahead: 3, behind: 1, exact: true }), '3 ahead, 1 behind');
});

test('refDivergenceHint marks an inexact (capped) count with ~ (W95)', () => {
  assert.equal(refDivergenceHint({ ahead: 5, behind: 0, exact: false }), '~5 ahead');
  assert.equal(refDivergenceHint({ ahead: 5, behind: 2, exact: false }), '~5 ahead, ~2 behind');
});

test('compareRefPaletteItems attaches a shared divergence hint per ref (W95)', () => {
  const div = name => (name === 'dev' ? { ahead: 2, behind: 1, exact: true } : null);
  const items = compareRefPaletteItems([{ name: 'dev' }, { name: 'old' }], 'HEAD', null, 30, div);
  // dev (2 entries) both carry the same hint; old (no divergence) carries none.
  const dev = items.filter(i => i.base === 'dev' || (i.head === 'dev' && i.base === 'HEAD'));
  assert.equal(dev.length, 2);
  assert.equal(dev[0].hint, '2 ahead, 1 behind');
  assert.equal(dev[1].hint, '2 ahead, 1 behind');
  const old = items.filter(i => i.base === 'old' || (i.head === 'old' && i.base === 'HEAD'));
  assert.equal(old[0].hint, undefined);
});

test('compareRefPaletteItems omits hints entirely without a lookup (W95/W87)', () => {
  // The W87 shape (no divergence arg) must be unchanged — no hint key.
  const items = compareRefPaletteItems([{ name: 'dev' }], 'HEAD');
  assert.equal('hint' in items[0], false);
});

// ── refInsightDivergenceHint (W100): rail popover unification ─────────

test('refInsightDivergenceHint matches refDivergenceHint for the same numbers (W100)', () => {
  for (const x of [{ ahead: 0, behind: 0, exact: true }, { ahead: 3, behind: 1, exact: true }, { ahead: 2, behind: 0, exact: false }]) {
    assert.equal(refInsightDivergenceHint(x), refDivergenceHint(x));
  }
});

test('refInsightDivergenceHint says "even with HEAD" not "up to date" when level (W100)', () => {
  assert.equal(refInsightDivergenceHint({ ahead: 0, behind: 0, exact: true }), 'even with HEAD');
});

test('refInsightDivergenceHint carries ~ on a capped count (W100)', () => {
  assert.equal(refInsightDivergenceHint({ ahead: 5, behind: 2, exact: false }), '~5 ahead, ~2 behind');
});

// ── compareInvalidNotice (W98): inline self-compare clash ────────────

test('compareInvalidNotice names both refs on a self-compare (W98)', () => {
  assert.equal(compareInvalidNotice('self-compare', 'main', 'HEAD'), 'main and HEAD point at the same commit');
  assert.equal(compareInvalidNotice('self-compare', ' main ', ' HEAD '), 'main and HEAD point at the same commit');
});

test('compareInvalidNotice falls back to W92 wording for empty sides (W98)', () => {
  assert.equal(compareInvalidNotice('empty-base', '', 'HEAD'), 'Enter a base ref to compare');
  assert.equal(compareInvalidNotice('empty-head', 'main', ''), 'Enter a ref to compare against');
  // self-compare with a blank side degrades to the generic line.
  assert.equal(compareInvalidNotice('self-compare', '', ''), 'Pick two different refs to compare');
});

// ── nextRefSuggestion (W103): one-key self-compare recovery ──────────

test('nextRefSuggestion picks the most-diverged other ref (W103)', () => {
  const refs = [
    { name: 'main', ahead: 0, behind: 0 },
    { name: 'feat', ahead: 3, behind: 1 },
    { name: 'dev', ahead: 1, behind: 1 },
  ];
  assert.equal(nextRefSuggestion('main', refs), 'feat'); // 4 > 2, skips main
});

test('nextRefSuggestion skips the base case-insensitively (W103)', () => {
  const refs = [{ name: 'Main', ahead: 9, behind: 9 }, { name: 'dev', ahead: 1, behind: 0 }];
  assert.equal(nextRefSuggestion('main', refs), 'dev');
});

test('nextRefSuggestion keeps input order on a tie + drops junk (W103)', () => {
  const refs = [{ name: 'a', ahead: 1 }, { name: 'b', ahead: 1 }, { name: '-bad' }];
  assert.equal(nextRefSuggestion('main', refs), 'a'); // first of the tie, -bad sanitised out
  assert.equal(nextRefSuggestion('main', []), null);
  assert.equal(nextRefSuggestion('main', [{ name: 'main' }]), null); // only the base
});

// ── divergenceClass (W105): rail popover dot colour ──────────────────

test('divergenceClass distinguishes the four shapes (W105)', () => {
  assert.equal(divergenceClass({ ahead: 0, behind: 0 }), 'level');
  assert.equal(divergenceClass({ ahead: 3, behind: 0 }), 'ahead');
  assert.equal(divergenceClass({ ahead: 0, behind: 2 }), 'behind');
  assert.equal(divergenceClass({ ahead: 3, behind: 2 }), 'diverged');
});

// ── suggestionLabel (W108): self-compare inline affordance ───────────

test('suggestionLabel names a clean ref (W108)', () => {
  assert.equal(suggestionLabel('dev'), 'Compare with dev instead');
  assert.equal(suggestionLabel('feature/x'), 'Compare with feature/x instead');
  // Trims surrounding whitespace via sanitizeRef.
  assert.equal(suggestionLabel('  main '), 'Compare with main instead');
});

test('suggestionLabel returns empty for a blank or unsafe ref (W108)', () => {
  assert.equal(suggestionLabel(''), '');
  assert.equal(suggestionLabel('   '), '');
  assert.equal(suggestionLabel('--flag'), ''); // sanitizeRef rejects a flag
  assert.equal(suggestionLabel('a b'), ''); // and a spaced ref
});

// ── compareDivergence (W110): rail divergence ordering ───────────────

test('compareDivergence ranks diverged > one-sided > level (W110)', () => {
  const diverged = { ahead: 3, behind: 2 };
  const ahead = { ahead: 5, behind: 0 };
  const level = { ahead: 0, behind: 0 };
  // diverged sorts before a bigger one-sided drift, which sorts before level.
  assert.ok(compareDivergence(diverged, ahead) < 0);
  assert.ok(compareDivergence(ahead, level) < 0);
  assert.ok(compareDivergence(diverged, level) < 0);
});

test('compareDivergence breaks a same-class tie by total drift (W110)', () => {
  // Both diverged: the bigger ahead+behind leads.
  assert.ok(compareDivergence({ ahead: 5, behind: 5 }, { ahead: 1, behind: 1 }) < 0);
  // Ahead vs behind share rank 2; bigger drift wins.
  assert.ok(compareDivergence({ ahead: 9, behind: 0 }, { ahead: 0, behind: 2 }) < 0);
});

test('compareDivergence is stable (0) for equal positions (W110)', () => {
  assert.equal(compareDivergence({ ahead: 0, behind: 0 }, { ahead: 0, behind: 0 }), 0);
  assert.equal(compareDivergence({ ahead: 3, behind: 1 }, { ahead: 3, behind: 1 }), 0);
});

test('compareDivergence sorts a ref list most-diverged first (W110)', () => {
  const refs = [
    { name: 'level', ahead: 0, behind: 0 },
    { name: 'ahead', ahead: 4, behind: 0 },
    { name: 'diverged', ahead: 2, behind: 3 },
  ];
  const order = refs.slice().sort((a, b) => compareDivergence(a, b)).map(r => r.name);
  assert.deepEqual(order, ['diverged', 'ahead', 'level']);
});
