import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildAuthorSparkline,
  aggregateAuthorFiles,
  normalizeNumstatPath,
  AUTHOR_FILES_FORMAT,
} from '../../src/shared/authorDetail';

const R = '\x1e';

// ── buildAuthorSparkline ─────────────────────────────────────────────

test('buildAuthorSparkline buckets dates into recent weekly bins', () => {
  const now = Date.parse('2026-06-25T12:00:00Z');
  const day = 86_400_000;
  const dates = [
    new Date(now - 1 * day).toISOString(), // this week -> last bin
    new Date(now - 2 * day).toISOString(), // this week
    new Date(now - 8 * day).toISOString(), // 1 week ago
    new Date(now - 40 * day).toISOString(), // ~5.7 weeks ago
  ];
  const sp = buildAuthorSparkline(dates, { weeks: 8, now });
  assert.equal(sp.weeks, 8);
  assert.equal(sp.total, 4);
  assert.equal(sp.bins.length, 8);
  // Two commits land in the most-recent bin.
  assert.equal(sp.bins[7], 2);
  assert.equal(sp.bins[6], 1); // 1 week ago
  assert.equal(sp.max, 2);
});

test('buildAuthorSparkline drops commits older than the window', () => {
  const now = Date.parse('2026-06-25T12:00:00Z');
  const old = new Date(now - 200 * 86_400_000).toISOString();
  const sp = buildAuthorSparkline([old], { weeks: 4, now });
  assert.equal(sp.total, 0);
  assert.equal(sp.max, 0);
  assert.deepEqual(sp.bins, [0, 0, 0, 0]);
});

test('buildAuthorSparkline ignores unparseable dates and future commits', () => {
  const now = Date.parse('2026-06-25T12:00:00Z');
  const future = new Date(now + 5 * 86_400_000).toISOString();
  const sp = buildAuthorSparkline(['garbage', future], { weeks: 4, now });
  assert.equal(sp.total, 0);
});

// ── normalizeNumstatPath ─────────────────────────────────────────────

test('normalizeNumstatPath collapses rename forms to the new path', () => {
  assert.equal(normalizeNumstatPath('src/a.ts'), 'src/a.ts');
  assert.equal(normalizeNumstatPath('old.ts => new.ts'), 'new.ts');
  assert.equal(normalizeNumstatPath('src/{old => new}/file.ts'), 'src/new/file.ts');
  assert.equal(normalizeNumstatPath('lib/{ => sub}/x.ts'), 'lib/sub/x.ts');
});

// ── aggregateAuthorFiles ─────────────────────────────────────────────

test('aggregateAuthorFiles sums churn + commit counts for the exact email', () => {
  // Two commits by ada, one by bob (filtered out by the exact-email guard).
  const stdout =
    `${R}ada@x.io\n` +
    `10\t2\tsrc/a.ts\n` +
    `3\t0\tsrc/b.ts\n` +
    `${R}ada@x.io\n` +
    `5\t1\tsrc/a.ts\n` +
    `${R}bob@y.io\n` +
    `100\t0\tsrc/a.ts\n`;
  const files = aggregateAuthorFiles(stdout, 'ada@x.io');
  // a.ts: 2 commits, 15 ins, 3 del. b.ts: 1 commit, 3 ins.
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], { path: 'src/a.ts', commits: 2, insertions: 15, deletions: 3 });
  assert.deepEqual(files[1], { path: 'src/b.ts', commits: 1, insertions: 3, deletions: 0 });
});

test('aggregateAuthorFiles is case-insensitive on the email and skips binaries', () => {
  const stdout =
    `${R}Ada@X.io\n` +
    `-\t-\tlogo.png\n` + // binary -> 0/0 churn but still a touched file
    `4\t4\tsrc/a.ts\n`;
  const files = aggregateAuthorFiles(stdout, 'ada@x.io');
  const png = files.find(f => f.path === 'logo.png');
  assert.ok(png);
  assert.equal(png.insertions, 0);
  assert.equal(png.deletions, 0);
  assert.equal(png.commits, 1);
});

test('aggregateAuthorFiles counts a file once per commit even if it appears once', () => {
  const stdout = `${R}ada@x.io\n1\t1\tsrc/a.ts\n${R}ada@x.io\n2\t2\tsrc/a.ts\n`;
  const files = aggregateAuthorFiles(stdout, 'ada@x.io');
  assert.equal(files[0].commits, 2);
  assert.equal(files[0].insertions, 3);
});

test('AUTHOR_FILES_FORMAT carries the record sep + author email', () => {
  assert.equal(AUTHOR_FILES_FORMAT, '%x1e%aE');
});
