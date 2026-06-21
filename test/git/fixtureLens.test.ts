import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isFixtureFile,
  parseFixtureLog,
  bucketByAuthor,
  relTime,
  buildLensLine,
  FixtureCommit,
} from '../../src/git/fixtureLens';

const now = new Date('2026-06-21T00:00:00Z');

function c(opts: Partial<FixtureCommit> & { dateIso: string; author: string }): FixtureCommit {
  return {
    sha: opts.sha ?? 'a'.repeat(40),
    shortSha: opts.shortSha ?? opts.sha?.slice(0, 7) ?? 'abcdef0',
    dateIso: opts.dateIso,
    author: opts.author,
  };
}

// ── isFixtureFile ─────────────────────────────────────────────────

test('isFixtureFile: jest __snapshots__ dir', () => {
  assert.equal(isFixtureFile('src/__snapshots__/Button.test.ts.snap'), true);
});

test('isFixtureFile: __fixtures__ dir', () => {
  assert.equal(isFixtureFile('src/feature/__fixtures__/sample.json'), true);
});

test('isFixtureFile: root-level fixtures/', () => {
  assert.equal(isFixtureFile('fixtures/users.json'), true);
});

test('isFixtureFile: fixtures/ under tests/', () => {
  assert.equal(isFixtureFile('tests/fixtures/users.json'), true);
});

test('isFixtureFile: fixtures/ under __tests__/', () => {
  assert.equal(isFixtureFile('src/__tests__/fixtures/users.json'), true);
});

test('isFixtureFile: docs/snapshots/ rejected', () => {
  assert.equal(isFixtureFile('docs/snapshots/architecture.png'), false);
});

test('isFixtureFile: testdata/ (Go convention)', () => {
  assert.equal(isFixtureFile('pkg/foo/testdata/input.txt'), true);
});

test('isFixtureFile: cassettes/ (VCR convention)', () => {
  assert.equal(isFixtureFile('spec/cassettes/api_call.yml'), true);
});

test('isFixtureFile: .snap extension', () => {
  assert.equal(isFixtureFile('src/Button.test.ts.snap'), true);
});

test('isFixtureFile: .snap.ts', () => {
  assert.equal(isFixtureFile('src/Button.snap.ts'), true);
});

test('isFixtureFile: .golden (Go)', () => {
  assert.equal(isFixtureFile('pkg/foo/expected.golden'), true);
});

test('isFixtureFile: .expected', () => {
  assert.equal(isFixtureFile('compiler/out.expected'), true);
});

test('isFixtureFile: .expected.json', () => {
  assert.equal(isFixtureFile('compiler/out.expected.json'), true);
});

test('isFixtureFile: regular source file rejected', () => {
  assert.equal(isFixtureFile('src/views/wipHunter.ts'), false);
  assert.equal(isFixtureFile('README.md'), false);
  assert.equal(isFixtureFile('package.json'), false);
});

test('isFixtureFile: filename containing fixture word', () => {
  assert.equal(isFixtureFile('test/fixtureLoader.ts'), false); // boundary
  assert.equal(isFixtureFile('test/fixture-data.json'), true); // word boundary match
  assert.equal(isFixtureFile('test/data_fixture.txt'), true);
});

test('isFixtureFile: windows-style separators', () => {
  assert.equal(isFixtureFile('src\\__snapshots__\\Button.snap'), true);
});

test('isFixtureFile: rejects empty + over-long', () => {
  assert.equal(isFixtureFile(''), false);
  assert.equal(isFixtureFile('a'.repeat(5000)), false);
});

test('isFixtureFile: .snap.png (visual regression)', () => {
  assert.equal(isFixtureFile('e2e/baseline.snap.png'), true);
});

// ── parseFixtureLog ────────────────────────────────────────────────

test('parseFixtureLog: standard 4-column format', () => {
  const raw = [
    'abc123def|abc123d|2026-06-01T12:00:00Z|alice',
    'def456abc|def456a|2026-05-15T08:30:00Z|bob',
  ].join('\n');
  const out = parseFixtureLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].author, 'alice');
  assert.equal(out[1].author, 'bob');
  assert.equal(out[0].dateIso, '2026-06-01T12:00:00Z');
});

test('parseFixtureLog: author name containing pipe', () => {
  const raw = 'abc|abc|2026-06-01T12:00:00Z|alice | dev';
  const out = parseFixtureLog(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].author, 'alice | dev');
});

test('parseFixtureLog: empty input', () => {
  assert.deepEqual(parseFixtureLog(''), []);
  assert.deepEqual(parseFixtureLog('\n\n'), []);
});

// ── bucketByAuthor ─────────────────────────────────────────────────

test('bucketByAuthor: distinct authors in recency order', () => {
  const commits = [
    c({ dateIso: '2026-06-01', author: 'Alice' }),
    c({ dateIso: '2026-05-01', author: 'Bob' }),
    c({ dateIso: '2026-04-01', author: 'Alice' }),
  ];
  const buckets = bucketByAuthor(commits);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].author, 'Alice');
  assert.equal(buckets[0].commits.length, 2);
  assert.equal(buckets[1].author, 'Bob');
});

test('bucketByAuthor: case-insensitive grouping but preserves display case', () => {
  const commits = [
    c({ dateIso: '2026-06-01', author: 'Alice' }),
    c({ dateIso: '2026-05-01', author: 'alice' }),
  ];
  const buckets = bucketByAuthor(commits);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].author, 'Alice'); // first seen wins
});

test('bucketByAuthor: empty input', () => {
  assert.deepEqual(bucketByAuthor([]), []);
});

// ── relTime ────────────────────────────────────────────────────────

test('relTime: < 60s → just now', () => {
  assert.equal(relTime(new Date(now.getTime() - 30 * 1000), now), 'just now');
});

test('relTime: minutes', () => {
  assert.equal(relTime(new Date(now.getTime() - 5 * 60 * 1000), now), '5m ago');
});

test('relTime: hours', () => {
  assert.equal(relTime(new Date(now.getTime() - 3 * 3600 * 1000), now), '3h ago');
});

test('relTime: days', () => {
  assert.equal(relTime(new Date(now.getTime() - 2 * 86400 * 1000), now), '2d ago');
});

test('relTime: weeks', () => {
  assert.equal(relTime(new Date(now.getTime() - 21 * 86400 * 1000), now), '3w ago');
});

test('relTime: months', () => {
  assert.equal(relTime(new Date(now.getTime() - 90 * 86400 * 1000), now), '3mo ago');
});

test('relTime: years', () => {
  assert.equal(relTime(new Date(now.getTime() - 800 * 86400 * 1000), now), '2y ago');
});

test('relTime: future time clamped to 0', () => {
  assert.equal(relTime(new Date(now.getTime() + 60000), now), 'just now');
});

test('relTime: invalid input', () => {
  assert.equal(relTime('not-a-date', now), '?');
});

// ── buildLensLine ──────────────────────────────────────────────────

test('buildLensLine: 1 author → "Last author"', () => {
  const commits = [c({ dateIso: '2026-06-19T00:00:00Z', author: 'Alice' })];
  const line = buildLensLine(commits, now);
  assert.ok(line);
  assert.match(line.title, /^Last author: Alice \(\dd ago\)$/);
});

test('buildLensLine: 3 authors → "Last 3 authors"', () => {
  const commits = [
    c({ dateIso: '2026-06-19T00:00:00Z', author: 'Alice' }),
    c({ dateIso: '2026-06-15T00:00:00Z', author: 'Bob' }),
    c({ dateIso: '2026-06-01T00:00:00Z', author: 'Carol' }),
  ];
  const line = buildLensLine(commits, now);
  assert.ok(line);
  assert.match(line.title, /^Last 3 authors: Alice .*, Bob .*, Carol /);
});

test('buildLensLine: more than topN → "+N more"', () => {
  const commits = [
    c({ dateIso: '2026-06-19T00:00:00Z', author: 'A' }),
    c({ dateIso: '2026-06-18T00:00:00Z', author: 'B' }),
    c({ dateIso: '2026-06-17T00:00:00Z', author: 'C' }),
    c({ dateIso: '2026-06-16T00:00:00Z', author: 'D' }),
    c({ dateIso: '2026-06-15T00:00:00Z', author: 'E' }),
  ];
  const line = buildLensLine(commits, now, 3);
  assert.ok(line);
  assert.match(line.title, /\+2 more/);
});

test('buildLensLine: empty commits → undefined', () => {
  assert.equal(buildLensLine([], now), undefined);
});

test('buildLensLine: tooltip includes commit count per author', () => {
  const commits = [
    c({ dateIso: '2026-06-19T00:00:00Z', author: 'Alice', sha: 'aaaa1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortSha: 'aaaa111' }),
    c({ dateIso: '2026-06-01T00:00:00Z', author: 'Alice', sha: 'aaaa2222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortSha: 'aaaa222' }),
  ];
  const line = buildLensLine(commits, now);
  assert.ok(line);
  assert.match(line.tooltip, /Alice — 2 commits/);
  assert.match(line.tooltip, /aaaa111/);
});
