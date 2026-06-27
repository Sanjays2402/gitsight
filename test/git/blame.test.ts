import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parsePorcelainBlame,
  summariseBlame,
  blameHeat,
  sanitizeIgnoreRev,
  normalizeIgnoreRevs,
  buildIgnoreRevArgs,
} from '../../src/shared/blame';

// A compact but realistic porcelain stream: two commits, the first
// repeated for a run of lines (porcelain abbreviates the repeat header).
const PORCELAIN = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2',
  'author Ada Lovelace',
  'author-mail <ada@example.com>',
  'author-time 1700000000',
  'author-tz +0000',
  'committer Ada Lovelace',
  'committer-mail <ada@example.com>',
  'committer-time 1700000000',
  'committer-tz +0000',
  'summary first commit',
  'filename app.ts',
  '\tconst x = 1;',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2',
  '\tconst y = 2;',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 3 3 1',
  'author Grace Hopper',
  'author-mail <grace@example.com>',
  'author-time 1710000000',
  'author-tz +0000',
  'summary second commit',
  'filename app.ts',
  '\tconst z = 3;',
].join('\n');

test('parsePorcelainBlame parses lines + caches repeated commit metadata', () => {
  const model = parsePorcelainBlame(PORCELAIN);
  assert.equal(model.totalLines, 3);
  assert.equal(model.lines[0].line, 1);
  assert.equal(model.lines[0].author, 'Ada Lovelace');
  assert.equal(model.lines[0].email, 'ada@example.com');
  assert.equal(model.lines[0].shortSha, 'aaaaaaa');
  assert.equal(model.lines[0].code, 'const x = 1;');
  // The repeated (abbreviated) header reuses Ada's cached metadata.
  assert.equal(model.lines[1].author, 'Ada Lovelace');
  assert.equal(model.lines[1].summary, 'first commit');
  assert.equal(model.lines[1].code, 'const y = 2;');
  // Third line is Grace's.
  assert.equal(model.lines[2].author, 'Grace Hopper');
  assert.equal(model.lines[2].authorTime, 1710000000);
});

test('parsePorcelainBlame builds an author leaderboard busiest-first', () => {
  const model = parsePorcelainBlame(PORCELAIN);
  assert.equal(model.authors[0].author, 'Ada Lovelace');
  assert.equal(model.authors[0].lines, 2);
  assert.ok(Math.abs(model.authors[0].share - 2 / 3) < 1e-9);
  assert.equal(model.authors[1].author, 'Grace Hopper');
});

test('parsePorcelainBlame records the age span', () => {
  const model = parsePorcelainBlame(PORCELAIN);
  assert.equal(model.oldest, 1700000000);
  assert.equal(model.newest, 1710000000);
});

test('parsePorcelainBlame tolerates an empty input', () => {
  const model = parsePorcelainBlame('');
  assert.equal(model.totalLines, 0);
  assert.deepEqual(model.authors, []);
  assert.equal(model.oldest, 0);
});

test('parsePorcelainBlame keeps tab-only (blank) source lines', () => {
  const stream = [
    'cccccccccccccccccccccccccccccccccccccccc 1 1 1',
    'author Z',
    'author-mail <z@e.com>',
    'author-time 1',
    'summary s',
    'filename f',
    '\t',
  ].join('\n');
  const model = parsePorcelainBlame(stream);
  assert.equal(model.totalLines, 1);
  assert.equal(model.lines[0].code, '');
});

// ── summariseBlame ───────────────────────────────────────────────────

test('summariseBlame folds an explicit line list', () => {
  const model = summariseBlame([
    { line: 1, sha: 'a', shortSha: 'a', author: 'A', email: '', authorTime: 10, summary: '', code: '' },
    { line: 2, sha: 'b', shortSha: 'b', author: 'A', email: '', authorTime: 20, summary: '', code: '' },
    { line: 3, sha: 'c', shortSha: 'c', author: 'B', email: '', authorTime: 30, summary: '', code: '' },
  ]);
  assert.equal(model.totalLines, 3);
  assert.equal(model.authors[0].author, 'A');
  assert.equal(model.oldest, 10);
  assert.equal(model.newest, 30);
});

// ── blameHeat ────────────────────────────────────────────────────────

test('blameHeat maps newest->1 and oldest->0 across the span', () => {
  assert.equal(blameHeat(30, 10, 30), 1);
  assert.equal(blameHeat(10, 10, 30), 0);
  assert.equal(blameHeat(20, 10, 30), 0.5);
});

test('blameHeat returns 1 for a zero-span file and 0 for unknown time', () => {
  assert.equal(blameHeat(5, 5, 5), 1);
  assert.equal(blameHeat(0, 10, 30), 0);
});

// ── Ignore-revs (W44) ────────────────────────────────────────────────

test('sanitizeIgnoreRev accepts hex object names and lowercases them', () => {
  assert.equal(sanitizeIgnoreRev('ABCDEF1'), 'abcdef1');
  assert.equal(sanitizeIgnoreRev('  0a1b2c3d  '), '0a1b2c3d');
  // Full sha-256 length is fine.
  assert.equal(sanitizeIgnoreRev('a'.repeat(64)), 'a'.repeat(64));
});

test('sanitizeIgnoreRev rejects flags, refs, and out-of-range lengths', () => {
  assert.equal(sanitizeIgnoreRev('--all'), null);
  assert.equal(sanitizeIgnoreRev('HEAD~1'), null);
  assert.equal(sanitizeIgnoreRev('main'), null); // not hex
  assert.equal(sanitizeIgnoreRev('abc'), null); // too short (<4)
  assert.equal(sanitizeIgnoreRev('a'.repeat(65)), null); // too long (>64)
  assert.equal(sanitizeIgnoreRev(''), null);
});

test('normalizeIgnoreRevs sanitises, de-dupes (first-seen), and caps', () => {
  assert.deepEqual(normalizeIgnoreRevs(['ABCD', 'abcd', 'ef01', 'nope', '--x']), ['abcd', 'ef01']);
  // Cap respected.
  const many = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(8, '0'));
  assert.equal(normalizeIgnoreRevs(many, 50).length, 50);
  assert.deepEqual(normalizeIgnoreRevs([]), []);
});

test('buildIgnoreRevArgs emits one --ignore-rev pair per clean rev', () => {
  assert.deepEqual(buildIgnoreRevArgs(['abcd', 'ef01']), [
    '--ignore-rev',
    'abcd',
    '--ignore-rev',
    'ef01',
  ]);
  // Junk drops out; nothing valid -> no args.
  assert.deepEqual(buildIgnoreRevArgs(['--all', 'main']), []);
  assert.deepEqual(buildIgnoreRevArgs([]), []);
});
