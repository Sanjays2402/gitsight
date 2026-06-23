import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseDiffNumstat,
  summariseAccumulation,
  formatAccumulationHeadline,
  buildChangelogPreview,
} from '../../src/git/releaseSinceLastTag';
import type { MergedCommit } from '../../src/git/tagOnMerge';

const commits: MergedCommit[] = [
  { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'feat(api): add logout', body: '', author: 'Alice' },
  { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'fix: handle empty branch', body: '', author: 'Bob' },
  { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'chore: bump deps', body: '', author: 'Alice' },
  { sha: 'd'.repeat(40), shortSha: 'ddddddd', subject: 'feat!: rename foo to bar', body: 'BREAKING CHANGE: removed foo()', author: 'Bob' },
  { sha: 'e'.repeat(40), shortSha: 'eeeeeee', subject: 'perf: speed up parser', body: '', author: 'Carol' },
];

test('parseDiffNumstat parses LF-separated lines and a binary marker', () => {
  const raw = '12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n5\t0\tsrc/b.ts\n';
  const rows = parseDiffNumstat(raw);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { path: 'src/a.ts', added: 12, removed: 3, binary: false });
  assert.deepEqual(rows[1], { path: 'assets/logo.png', added: 0, removed: 0, binary: true });
  assert.deepEqual(rows[2], { path: 'src/b.ts', added: 5, removed: 0, binary: false });
});

test('parseDiffNumstat tolerates empty / malformed input', () => {
  assert.deepEqual(parseDiffNumstat(''), []);
  assert.deepEqual(parseDiffNumstat('hello world\nfoo\n'), []);
});

test('summariseAccumulation rolls commit types into the byType map', () => {
  const s = summariseAccumulation({ commits, numstat: [], previousTag: 'v1.0.0' });
  assert.equal(s.commitCount, 5);
  assert.equal(s.byType['feat'], 2);
  assert.equal(s.byType['fix'], 1);
  assert.equal(s.byType['chore'], 1);
  assert.equal(s.byType['perf'], 1);
});

test('summariseAccumulation: BREAKING CHANGE in body forces major bump + appropriate next tag', () => {
  const s = summariseAccumulation({ commits, numstat: [], previousTag: 'v1.0.0' });
  assert.equal(s.bump, 'major');
  assert.equal(s.nextTag, 'v2.0.0');
});

test('summariseAccumulation: only fixes -> patch bump', () => {
  const fixesOnly: MergedCommit[] = [
    { sha: 'x'.repeat(40), shortSha: 'xxxxxxx', subject: 'fix: one', body: '', author: 'A' },
    { sha: 'y'.repeat(40), shortSha: 'yyyyyyy', subject: 'fix: two', body: '', author: 'A' },
  ];
  const s = summariseAccumulation({ commits: fixesOnly, numstat: [], previousTag: 'v1.0.0' });
  assert.equal(s.bump, 'patch');
  assert.equal(s.nextTag, 'v1.0.1');
});

test('summariseAccumulation: no previous tag seeds at v0.1.0 for minor bump', () => {
  const minorOnly: MergedCommit[] = [
    { sha: 'x'.repeat(40), shortSha: 'xxxxxxx', subject: 'feat: a', body: '', author: 'A' },
  ];
  const s = summariseAccumulation({ commits: minorOnly, numstat: [], previousTag: undefined });
  assert.equal(s.bump, 'minor');
  assert.equal(s.nextTag, 'v0.1.0');
});

test('summariseAccumulation accumulates added / removed / binary counts from numstat', () => {
  const numstat = parseDiffNumstat('10\t2\tsrc/a.ts\n5\t1\tsrc/b.ts\n-\t-\tlogo.png\n');
  const s = summariseAccumulation({ commits, numstat, previousTag: 'v1.0.0' });
  assert.equal(s.added, 15);
  assert.equal(s.removed, 3);
  assert.equal(s.binary, 1);
  assert.equal(s.fileCount, 3);
});

test('summariseAccumulation top contributors ranked by commit count then name', () => {
  const s = summariseAccumulation({ commits, numstat: [], previousTag: 'v1.0.0' });
  assert.equal(s.topContributors[0].name, 'Alice');
  assert.equal(s.topContributors[0].commits, 2);
  assert.equal(s.topContributors[1].name, 'Bob');
  assert.equal(s.topContributors[2].name, 'Carol');
});

test('formatAccumulationHeadline mentions previous tag when supplied', () => {
  const s = summariseAccumulation({ commits, numstat: [], previousTag: 'v1.0.0' });
  const h = formatAccumulationHeadline(s, 'v1.0.0');
  assert.match(h, /since v1\.0\.0/);
  assert.match(h, /5 commits/);
  assert.match(h, /v2\.0\.0/);
  assert.match(h, /\(major\)/);
});

test('formatAccumulationHeadline reads first commit when previousTag missing', () => {
  const s = summariseAccumulation({ commits, numstat: [], previousTag: undefined });
  const h = formatAccumulationHeadline(s, undefined);
  assert.match(h, /first commit/);
});

test('formatAccumulationHeadline: empty range surfaces clearly', () => {
  const s = summariseAccumulation({ commits: [], numstat: [], previousTag: 'v1.0.0' });
  assert.match(formatAccumulationHeadline(s, 'v1.0.0'), /No new commits since v1\.0\.0/);
});

test('formatAccumulationHeadline reports "no semver bump" when nothing to ship', () => {
  const chores: MergedCommit[] = [
    { sha: 'x'.repeat(40), shortSha: 'xxxxxxx', subject: 'chore: cleanup', body: '', author: 'A' },
  ];
  const s = summariseAccumulation({ commits: chores, numstat: [], previousTag: 'v1.0.0' });
  const h = formatAccumulationHeadline(s, 'v1.0.0');
  assert.match(h, /no semver bump/);
});

test('buildChangelogPreview emits the expected section structure', () => {
  const numstat = parseDiffNumstat('10\t2\tsrc/a.ts\n5\t1\tsrc/b.ts\n');
  const s = summariseAccumulation({ commits, numstat, previousTag: 'v1.0.0' });
  const md = buildChangelogPreview({ commits, numstat, previousTag: 'v1.0.0', summary: s, rangeRef: 'v1.0.0..HEAD' });
  assert.match(md, /## v2\.0\.0 \(preview\)/);
  assert.match(md, /### Breaking changes/);
  assert.match(md, /### Features/);
  assert.match(md, /### Fixes/);
  assert.match(md, /### Performance/);
  assert.match(md, /### Other/);
  assert.match(md, /### Contributors/);
  assert.match(md, /### Touched files/);
});

test('buildChangelogPreview respects commitsCap', () => {
  const many: MergedCommit[] = Array.from({ length: 10 }, (_, i) => ({
    sha: 'x'.repeat(40), shortSha: `x${i}`, subject: `feat: thing ${i}`, body: '', author: 'A',
  }));
  const s = summariseAccumulation({ commits: many, numstat: [], previousTag: 'v1.0.0' });
  const md = buildChangelogPreview({ commits: many, numstat: [], previousTag: 'v1.0.0', summary: s, commitsCap: 3 });
  assert.match(md, /\(7 more commits omitted\)/);
});

test('buildChangelogPreview respects filesCap', () => {
  const numstat = Array.from({ length: 8 }, (_, i) =>
    ({ path: `src/f${i}.ts`, added: i + 1, removed: 0, binary: false }));
  const s = summariseAccumulation({ commits, numstat, previousTag: 'v1.0.0' });
  const md = buildChangelogPreview({ commits, numstat, previousTag: 'v1.0.0', summary: s, filesCap: 3 });
  assert.match(md, /\(5 more files omitted\)/);
});

test('buildChangelogPreview: unreleased header when no nextTag', () => {
  const chores: MergedCommit[] = [
    { sha: 'x'.repeat(40), shortSha: 'xxxxxxx', subject: 'chore: x', body: '', author: 'A' },
  ];
  const s = summariseAccumulation({ commits: chores, numstat: [], previousTag: 'v1.0.0' });
  const md = buildChangelogPreview({ commits: chores, numstat: [], previousTag: 'v1.0.0', summary: s });
  assert.match(md, /## \(unreleased\) \(preview\)/);
});

test('buildChangelogPreview touched files sorted by total churn desc', () => {
  const numstat = parseDiffNumstat('1\t0\ttiny.ts\n50\t5\thot.ts\n3\t2\tmid.ts\n');
  const s = summariseAccumulation({ commits, numstat, previousTag: 'v1.0.0' });
  const md = buildChangelogPreview({ commits, numstat, previousTag: 'v1.0.0', summary: s });
  // hot.ts must appear before tiny.ts in the Touched files table.
  const hotIdx = md.indexOf('hot.ts');
  const tinyIdx = md.indexOf('tiny.ts');
  assert.ok(hotIdx > 0 && tinyIdx > 0 && hotIdx < tinyIdx);
});
