/**
 * Blame age-legend + author-filter tests (W40).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildAgeRamp, isAuthorDimmed, toggleAuthorFilter, authorEmailFromLines, buildBlameLineMenu, blameAuthorPaletteItems } from './blameLegend.ts';

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
