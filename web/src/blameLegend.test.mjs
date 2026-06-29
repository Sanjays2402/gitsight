/**
 * Blame age-legend + author-filter tests (W40).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildAgeRamp, isAuthorDimmed, toggleAuthorFilter, authorEmailFromLines, buildBlameLineMenu, blameAuthorPaletteItems, blameAuthorShareHint, sortBlameAuthorsForPalette, ownershipTag, matchesOwnership, toggleOwnershipFilter } from './blameLegend.ts';

test('buildAgeRamp returns evenly-spaced stops cold -> hot', () => {
  const ramp = buildAgeRamp(1000, 2000, 5);
  assert.equal(ramp.length, 5);
  assert.equal(ramp[0].heat, 0);
  assert.equal(ramp[4].heat, 1);
  // Heat ascends; unix times ascend with it.
  assert.equal(ramp[0].unixSec, 1000);
  assert.equal(ramp[4].unixSec, 2000);
  assert.equal(ramp[2].unixSec, 1500); // midpoint
  for (let i = 1; i < ramp.length; i++) {
    assert.ok(ramp[i].heat > ramp[i - 1].heat);
    assert.ok(ramp[i].unixSec >= ramp[i - 1].unixSec);
  }
});

test('buildAgeRamp clamps the stop count to at least 2', () => {
  assert.equal(buildAgeRamp(1000, 2000, 1).length, 2);
  assert.equal(buildAgeRamp(1000, 2000, 0).length, 2);
});

test('buildAgeRamp collapses a degenerate span to a single hot stop', () => {
  assert.deepEqual(buildAgeRamp(0, 0), [{ heat: 1, unixSec: 0 }]);
  assert.deepEqual(buildAgeRamp(5000, 5000), [{ heat: 1, unixSec: 5000 }]);
  // newest before oldest is also degenerate.
  assert.deepEqual(buildAgeRamp(9000, 8000), [{ heat: 1, unixSec: 8000 }]);
});

test('isAuthorDimmed dims everyone but the active author', () => {
  assert.equal(isAuthorDimmed('Ada', null), false); // no filter -> nothing dims
  assert.equal(isAuthorDimmed('Ada', 'Ada'), false);
  assert.equal(isAuthorDimmed('Grace', 'Ada'), true);
});

test('isAuthorDimmed compares case-insensitively + trimmed', () => {
  assert.equal(isAuthorDimmed('  ada  ', 'ADA'), false);
  assert.equal(isAuthorDimmed('Ada Lovelace', 'ada'), true);
});

test('toggleAuthorFilter selects, switches, and clears', () => {
  assert.equal(toggleAuthorFilter(null, 'Ada'), 'Ada'); // select
  assert.equal(toggleAuthorFilter('Ada', 'Grace'), 'Grace'); // switch
  assert.equal(toggleAuthorFilter('Ada', 'Ada'), null); // clear (same)
  assert.equal(toggleAuthorFilter('ada', 'ADA'), null); // clear (case-insensitive)
});

// ── authorEmailFromLines (W51) ───────────────────────────────────────

const lines = [
  { author: 'Ada Lovelace', email: 'ada@analytical.engine' },
  { author: 'Grace Hopper', email: 'grace@navy.mil' },
  { author: 'Ada Lovelace', email: 'ada@analytical.engine' },
  { author: 'Not Committed Yet', email: '' },
];

test('authorEmailFromLines resolves an author name to their email', () => {
  assert.equal(authorEmailFromLines(lines, 'Ada Lovelace'), 'ada@analytical.engine');
  assert.equal(authorEmailFromLines(lines, 'Grace Hopper'), 'grace@navy.mil');
});

test('authorEmailFromLines matches case-insensitively + trimmed', () => {
  assert.equal(authorEmailFromLines(lines, '  ada lovelace '), 'ada@analytical.engine');
  assert.equal(authorEmailFromLines(lines, 'GRACE HOPPER'), 'grace@navy.mil');
});

test('authorEmailFromLines returns empty for an author with no email', () => {
  assert.equal(authorEmailFromLines(lines, 'Not Committed Yet'), '');
});

test('authorEmailFromLines returns empty when the author is absent', () => {
  assert.equal(authorEmailFromLines(lines, 'Nobody'), '');
  assert.equal(authorEmailFromLines([], 'Ada'), '');
});

// ── buildBlameLineMenu (W77) ─────────────────────────────────────────

test('buildBlameLineMenu offers Isolate for a non-active author', () => {
  const m = buildBlameLineMenu({ author: 'Ada', activeAuthor: null });
  assert.equal(m.length, 1);
  assert.equal(m[0].action, 'isolate');
  assert.equal(m[0].label, 'Isolate Ada');
  assert.equal(m[0].author, 'Ada');
});

test('buildBlameLineMenu offers only Show-all on the active author', () => {
  const m = buildBlameLineMenu({ author: 'Ada', activeAuthor: 'Ada' });
  assert.equal(m.length, 1);
  assert.equal(m[0].action, 'show-all');
  assert.equal(m[0].label, 'Show all authors');
});

test('buildBlameLineMenu matches the active author case-insensitively', () => {
  // Right-clicking "ada" while "ADA" is isolated reads as the active line.
  const m = buildBlameLineMenu({ author: 'ada', activeAuthor: 'ADA' });
  assert.deepEqual(m.map(c => c.action), ['show-all']);
});

test('buildBlameLineMenu adds Show-all when a DIFFERENT author is isolated', () => {
  const m = buildBlameLineMenu({ author: 'Grace', activeAuthor: 'Ada' });
  assert.deepEqual(m.map(c => c.action), ['isolate', 'show-all']);
  assert.equal(m[0].author, 'Grace');
});

test('buildBlameLineMenu offers View-author only with a wired panel + email', () => {
  // No email -> no view-author entry even when the panel is wired.
  const noEmail = buildBlameLineMenu({ author: 'Ada', activeAuthor: null, canViewAuthor: true });
  assert.equal(noEmail.some(c => c.action === 'view-author'), false);
  // Email present + wired -> the entry shows, carrying the email + a separator.
  const withEmail = buildBlameLineMenu({
    author: 'Ada',
    email: 'ada@x.io',
    activeAuthor: null,
    canViewAuthor: true,
  });
  const view = withEmail.find(c => c.action === 'view-author');
  assert.ok(view);
  assert.equal(view.email, 'ada@x.io');
  assert.equal(view.label, "View Ada's contributions");
  assert.equal(view.separator, true);
  // Not wired -> no entry regardless of email.
  const notWired = buildBlameLineMenu({ author: 'Ada', email: 'ada@x.io', activeAuthor: null });
  assert.equal(notWired.some(c => c.action === 'view-author'), false);
});

test('buildBlameLineMenu offers Copy-line only when wired', () => {
  const on = buildBlameLineMenu({ author: 'Ada', activeAuthor: null, canCopyLine: true });
  const copy = on.find(c => c.action === 'copy-line');
  assert.ok(copy);
  assert.equal(copy.separator, true);
  const off = buildBlameLineMenu({ author: 'Ada', activeAuthor: null });
  assert.equal(off.some(c => c.action === 'copy-line'), false);
});

test('buildBlameLineMenu offers Open-line only when wired (W90)', () => {
  const on = buildBlameLineMenu({ author: 'Ada', activeAuthor: null, canOpenLine: true });
  const open = on.find(c => c.action === 'open-line');
  assert.ok(open);
  assert.equal(open.label, 'Open line in new tab');
  // First nav entry (no copy above it) -> gets the hairline separator.
  assert.equal(open.separator, true);
  const off = buildBlameLineMenu({ author: 'Ada', activeAuthor: null });
  assert.equal(off.some(c => c.action === 'open-line'), false);
});

test('buildBlameLineMenu groups copy + open without a separator between them (W90)', () => {
  const m = buildBlameLineMenu({ author: 'Ada', activeAuthor: null, canCopyLine: true, canOpenLine: true });
  const copy = m.find(c => c.action === 'copy-line');
  const open = m.find(c => c.action === 'open-line');
  assert.equal(copy.separator, true); // hairline above the pair
  assert.equal(open.separator, false); // no divider mid-pair
});

test('buildBlameLineMenu composes all actions in order', () => {
  const m = buildBlameLineMenu({
    author: 'Grace',
    email: 'grace@navy.mil',
    activeAuthor: 'Ada',
    canViewAuthor: true,
    canCopyLine: true,
    canOpenLine: true,
  });
  assert.deepEqual(m.map(c => c.action), ['isolate', 'show-all', 'view-author', 'copy-line', 'open-line']);
});

// ── blameAuthorPaletteItems (W82) ────────────────────────────────────

const blameAuthors = [{ author: 'Ada' }, { author: 'Grace' }, { author: 'Linus' }];

test('blameAuthorPaletteItems offers Isolate for every author when none active', () => {
  const items = blameAuthorPaletteItems(blameAuthors, null);
  assert.deepEqual(items.map(i => i.action), ['isolate', 'isolate', 'isolate']);
  assert.deepEqual(items.map(i => i.author), ['Ada', 'Grace', 'Linus']);
  assert.equal(items[0].label, 'Blame: isolate Ada');
});

test('blameAuthorPaletteItems leads with Show-all + omits the active author', () => {
  const items = blameAuthorPaletteItems(blameAuthors, 'Grace');
  // Show-all first, then isolate for the OTHER two (Grace is already active).
  assert.deepEqual(items.map(i => i.action), ['show-all', 'isolate', 'isolate']);
  assert.equal(items[0].label, 'Blame: show all authors');
  assert.deepEqual(items.slice(1).map(i => i.author), ['Ada', 'Linus']);
});

test('blameAuthorPaletteItems matches the active author case-insensitively', () => {
  const items = blameAuthorPaletteItems([{ author: 'ada' }, { author: 'Grace' }], 'ADA');
  // "ada" is the active author -> omitted; only Grace gets an isolate entry.
  assert.deepEqual(items.map(i => i.action), ['show-all', 'isolate']);
  assert.equal(items[1].author, 'Grace');
});

test('blameAuthorPaletteItems de-dupes authors + skips blanks', () => {
  const items = blameAuthorPaletteItems(
    [{ author: 'Ada' }, { author: ' ada ' }, { author: '' }, { author: 'Grace' }],
    null,
  );
  assert.deepEqual(items.map(i => i.author), ['Ada', 'Grace']);
});

test('blameAuthorPaletteItems caps the isolate entries at the limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ author: `Author ${i}` }));
  const items = blameAuthorPaletteItems(many, null, 5);
  assert.equal(items.length, 5);
  assert.ok(items.every(i => i.action === 'isolate'));
  // Show-all doesn't count toward the isolate cap.
  const withActive = blameAuthorPaletteItems(many, 'Author 0', 5);
  assert.equal(withActive[0].action, 'show-all');
  assert.equal(withActive.filter(i => i.action === 'isolate').length, 5);
});

// ── blameAuthorShareHint / palette ownership hints (W97) ─────────────

test('blameAuthorShareHint renders lines + rounded share (W97)', () => {
  assert.equal(blameAuthorShareHint(128, 0.34), '128 lines \u00b7 34%');
  // Singular line.
  assert.equal(blameAuthorShareHint(1, 0.5), '1 line \u00b7 50%');
  // Share rounds.
  assert.equal(blameAuthorShareHint(10, 0.336), '10 lines \u00b7 34%');
});

test('blameAuthorShareHint omits the percent when share is unknown/zero (W97)', () => {
  assert.equal(blameAuthorShareHint(40, 0), '40 lines');
  assert.equal(blameAuthorShareHint(40, NaN), '40 lines');
  assert.equal(blameAuthorShareHint(0, 0), '0 lines');
});

test('blameAuthorPaletteItems attaches an ownership hint when stats are present (W97)', () => {
  const items = blameAuthorPaletteItems(
    [{ author: 'Ada', lines: 128, share: 0.34 }, { author: 'Grace', lines: 12, share: 0.03 }],
    null,
  );
  assert.equal(items[0].hint, '128 lines \u00b7 34%');
  assert.equal(items[1].hint, '12 lines \u00b7 3%');
});

test('blameAuthorPaletteItems omits the hint for stat-less authors (W97/W82)', () => {
  // The W82 shape ({author} only) stays unchanged — no hint key.
  const items = blameAuthorPaletteItems([{ author: 'Ada' }], null);
  assert.equal('hint' in items[0], false);
  // show-all never carries a hint.
  const withActive = blameAuthorPaletteItems([{ author: 'Ada', lines: 5, share: 1 }], 'Ada');
  assert.equal(withActive[0].action, 'show-all');
  assert.equal('hint' in withActive[0], false);
});

// ── sortBlameAuthorsForPalette (W102) ────────────────────────────────

test('sortBlameAuthorsForPalette orders by lines desc, name tie-break (W102)', () => {
  const out = sortBlameAuthorsForPalette([
    { author: 'Ada', lines: 12 },
    { author: 'Grace', lines: 200 },
    { author: 'Bob', lines: 12 },
  ]);
  assert.deepEqual(out.map(a => a.author), ['Grace', 'Ada', 'Bob']);
});

test('sortBlameAuthorsForPalette sinks stat-less authors below counted ones (W102)', () => {
  const out = sortBlameAuthorsForPalette([
    { author: 'NoStat' },
    { author: 'Ada', lines: 1 },
  ]);
  assert.deepEqual(out.map(a => a.author), ['Ada', 'NoStat']);
});

test('sortBlameAuthorsForPalette does not mutate a frozen input (W102)', () => {
  const input = Object.freeze([{ author: 'B', lines: 1 }, { author: 'A', lines: 9 }]);
  const out = sortBlameAuthorsForPalette(input);
  assert.equal(out[0].author, 'A');
  assert.equal(input[0].author, 'B'); // original order intact
});

test('blameAuthorPaletteItems keeps the biggest owners under the cap (W102)', () => {
  const authors = [
    { author: 'tail', lines: 1 },
    { author: 'owner', lines: 500 },
    { author: 'mid', lines: 50 },
  ];
  const items = blameAuthorPaletteItems(authors, null, 2);
  // 2 isolate entries; the 1-line drive-by is dropped, owners survive.
  assert.deepEqual(items.map(i => i.author), ['owner', 'mid']);
});

// ── ownershipTag / spread-thin + concentrated hint (W112) ────────────

test('ownershipTag flags spread-thin: many lines, tiny share (W112)', () => {
  assert.equal(ownershipTag(200, 0.05), 'spread thin');
  assert.equal(ownershipTag(100, 0.09), 'spread thin');
  // 10% or above is no longer thin.
  assert.equal(ownershipTag(200, 0.1), '');
  // Under 100 lines doesn't qualify even at a tiny share.
  assert.equal(ownershipTag(40, 0.05), '');
});

test('ownershipTag flags concentrated: big share, few lines (W112)', () => {
  assert.equal(ownershipTag(20, 0.8), 'concentrated');
  assert.equal(ownershipTag(39, 0.6), 'concentrated');
  // At/above 40 lines it's a normal big stake, not concentrated.
  assert.equal(ownershipTag(40, 0.8), '');
  // Under 60% isn't concentrated.
  assert.equal(ownershipTag(20, 0.59), '');
});

test('ownershipTag is empty for balanced or stat-less authors (W112)', () => {
  assert.equal(ownershipTag(128, 0.34), '');
  assert.equal(ownershipTag(0, 0), '');
  assert.equal(ownershipTag(0, 0.9), ''); // no lines -> not concentrated
});

test('blameAuthorShareHint appends the W112 tag when skewed', () => {
  assert.equal(blameAuthorShareHint(200, 0.05), '200 lines \u00b7 5% \u00b7 spread thin');
  assert.equal(blameAuthorShareHint(20, 0.8), '20 lines \u00b7 80% \u00b7 concentrated');
  // Balanced -> the W97 shape is unchanged (no tag).
  assert.equal(blameAuthorShareHint(128, 0.34), '128 lines \u00b7 34%');
});

// ── matchesOwnership / toggleOwnershipFilter quick filter (W116) ──────

test('matchesOwnership keeps everyone when no filter is set (W116)', () => {
  assert.equal(matchesOwnership(200, 0.05, null), true);
  assert.equal(matchesOwnership(20, 0.8, null), true);
});

test('matchesOwnership keeps only the selected band (W116)', () => {
  // spread-thin: many lines, tiny share.
  assert.equal(matchesOwnership(200, 0.05, 'spread-thin'), true);
  assert.equal(matchesOwnership(200, 0.05, 'concentrated'), false);
  // concentrated: big share, few lines.
  assert.equal(matchesOwnership(20, 0.8, 'concentrated'), true);
  assert.equal(matchesOwnership(20, 0.8, 'spread-thin'), false);
  // balanced authors match neither band, so they fall away when one's on.
  assert.equal(matchesOwnership(128, 0.34, 'concentrated'), false);
  assert.equal(matchesOwnership(128, 0.34, 'spread-thin'), false);
});

test('toggleOwnershipFilter switches bands and clears on the active one (W116)', () => {
  assert.equal(toggleOwnershipFilter(null, 'concentrated'), 'concentrated');
  assert.equal(toggleOwnershipFilter('concentrated', 'spread-thin'), 'spread-thin');
  assert.equal(toggleOwnershipFilter('concentrated', 'concentrated'), null);
});

// ── sortBlameAuthorsForPalette three-key sort (W107) ─────────────────

test('sortBlameAuthorsForPalette breaks an equal-lines tie by share desc (W107)', () => {
  const out = sortBlameAuthorsForPalette([
    { author: 'thin', lines: 100, share: 0.10 },
    { author: 'thick', lines: 100, share: 0.40 },
  ]);
  assert.deepEqual(out.map(a => a.author), ['thick', 'thin']); // higher share first
});

test('sortBlameAuthorsForPalette keeps stable name order on identical stats (W107)', () => {
  const out = sortBlameAuthorsForPalette([
    { author: 'Bob', lines: 50, share: 0.5 },
    { author: 'Ada', lines: 50, share: 0.5 },
  ]);
  assert.deepEqual(out.map(a => a.author), ['Ada', 'Bob']); // name tie-break
});

test('sortBlameAuthorsForPalette: lines still dominate share (W107)', () => {
  const out = sortBlameAuthorsForPalette([
    { author: 'few', lines: 10, share: 0.9 },
    { author: 'many', lines: 90, share: 0.1 },
  ]);
  assert.deepEqual(out.map(a => a.author), ['many', 'few']); // lines win over share
});
