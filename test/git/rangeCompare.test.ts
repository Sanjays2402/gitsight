import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  compareStatusFromCode,
  parseCompareCommits,
  parseCompareNumstat,
  parseCompareNameStatus,
  buildRangeComparison,
  compareHeadline,
  COMPARE_LOG_FORMAT,
} from '../../src/shared/rangeCompare';

const F = '\x1f';
const R = '\x1e';

// ── compareStatusFromCode ────────────────────────────────────────────

test('compareStatusFromCode maps git letters', () => {
  assert.equal(compareStatusFromCode('A'), 'added');
  assert.equal(compareStatusFromCode('D'), 'deleted');
  assert.equal(compareStatusFromCode('M'), 'modified');
  assert.equal(compareStatusFromCode('R100'), 'renamed');
  assert.equal(compareStatusFromCode('C75'), 'copied');
  assert.equal(compareStatusFromCode('T'), 'typechange');
  assert.equal(compareStatusFromCode('X'), 'unknown');
  assert.equal(compareStatusFromCode(''), 'unknown');
});

// ── parseCompareCommits ──────────────────────────────────────────────

test('parseCompareCommits parses RECORD/FIELD log output', () => {
  const stdout =
    ['abc123def', 'abc123d', 'Ada', '2026-06-20T09:00:00Z', 'feat: thing (#9)'].join(F) + R +
    ['def456abc', 'def456a', 'Grace', '2026-06-19T09:00:00Z', 'fix: bug'].join(F) + R;
  const commits = parseCompareCommits(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, 'abc123def');
  assert.equal(commits[0].shortSha, 'abc123d');
  assert.equal(commits[0].author, 'Ada');
  assert.equal(commits[0].subject, 'feat: thing (#9)');
  assert.equal(commits[1].author, 'Grace');
});

test('parseCompareCommits tolerates empty output + malformed records', () => {
  assert.deepEqual(parseCompareCommits(''), []);
  assert.deepEqual(parseCompareCommits(R + R), []);
  // A record missing the sha is dropped.
  assert.deepEqual(parseCompareCommits(['', '', 'x'].join(F) + R), []);
});

// ── parseCompareNumstat ──────────────────────────────────────────────

test('parseCompareNumstat reads counts, binary, and renames', () => {
  const stdout = `5\t2\tsrc/a.ts\0` + `-\t-\tlogo.png\0` + `3\t1\t\0old/b.ts\0new/b.ts\0`;
  const rows = parseCompareNumstat(stdout);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { insertions: 5, deletions: 2, binary: false, path: 'src/a.ts' });
  assert.equal(rows[1].binary, true);
  assert.equal(rows[1].insertions, -1);
  assert.equal(rows[2].path, 'new/b.ts');
  assert.equal(rows[2].oldPath, 'old/b.ts');
});

// ── parseCompareNameStatus ───────────────────────────────────────────

test('parseCompareNameStatus keys by destination path + handles renames', () => {
  const stdout = `M\0src/a.ts\0A\0src/new.ts\0R100\0old/b.ts\0new/b.ts\0`;
  const map = parseCompareNameStatus(stdout);
  assert.equal(map.get('src/a.ts')!.status, 'modified');
  assert.equal(map.get('src/new.ts')!.status, 'added');
  assert.equal(map.get('new/b.ts')!.status, 'renamed');
  assert.equal(map.get('new/b.ts')!.oldPath, 'old/b.ts');
});

// ── buildRangeComparison ─────────────────────────────────────────────

test('buildRangeComparison correlates files + sorts by churn desc', () => {
  const ahead = ['s1', 's1short', 'Ada', '2026-06-20T09:00:00Z', 'feat: a'].join(F) + R;
  const behind = ['s2', 's2short', 'Grace', '2026-06-18T09:00:00Z', 'chore: b'].join(F) + R;
  const numstat = `1\t1\tsmall.ts\0` + `40\t10\tbig.ts\0`;
  const nameStatus = `M\0small.ts\0M\0big.ts\0`;
  const cmp = buildRangeComparison({
    base: 'main',
    head: 'feature',
    aheadStdout: ahead,
    behindStdout: behind,
    numstatStdout: numstat,
    nameStatusStdout: nameStatus,
  });
  assert.equal(cmp.base, 'main');
  assert.equal(cmp.head, 'feature');
  assert.equal(cmp.ahead.length, 1);
  assert.equal(cmp.behind.length, 1);
  assert.equal(cmp.filesChanged, 2);
  // big.ts (50 churn) sorts before small.ts (2 churn).
  assert.equal(cmp.files[0].path, 'big.ts');
  assert.equal(cmp.insertions, 41);
  assert.equal(cmp.deletions, 11);
});

test('buildRangeComparison ignores binary churn in totals', () => {
  const cmp = buildRangeComparison({
    base: 'a',
    head: 'b',
    aheadStdout: '',
    behindStdout: '',
    numstatStdout: `-\t-\tlogo.png\0` + `2\t0\ttext.txt\0`,
    nameStatusStdout: `M\0logo.png\0A\0text.txt\0`,
  });
  assert.equal(cmp.insertions, 2);
  assert.equal(cmp.deletions, 0);
  const logo = cmp.files.find(f => f.path === 'logo.png');
  assert.equal(logo!.binary, true);
});

// ── compareHeadline ──────────────────────────────────────────────────

test('compareHeadline summarises ahead/behind/files with pluralisation', () => {
  const cmp = buildRangeComparison({
    base: 'a',
    head: 'b',
    aheadStdout: ['s1', 's1', 'X', '2026-06-20T09:00:00Z', 'a'].join(F) + R,
    behindStdout: '',
    numstatStdout: `1\t0\tone.ts\0`,
    nameStatusStdout: `A\0one.ts\0`,
  });
  assert.equal(compareHeadline(cmp), '1 ahead, 0 behind, 1 file changed');
});

test('COMPARE_LOG_FORMAT carries the five fields + record terminator', () => {
  assert.ok(COMPARE_LOG_FORMAT.includes('%H'));
  assert.ok(COMPARE_LOG_FORMAT.includes('%s'));
  assert.ok(COMPARE_LOG_FORMAT.endsWith('%x1e'));
});
