import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinBlobs,
  shasForBatchCheck,
  formatSize,
  summariseRepo,
  formatReportMarkdown,
} from '../../src/git/repoSize';

const REVLIST = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 assets/big.bin',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2 src/index.ts',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',                // orphan blob (no path)
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4 README.md',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5 tree-not-blob',  // will come through cat-file as tree → dropped
].join('\n');

const BATCH = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 blob 12000000',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2 blob 4321',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3 blob 600000',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4 blob 1234',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5 tree 999',          // dropped
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 blob 12000000',     // dupe
].join('\n');

test('joinBlobs: pairs SHA with path, drops trees, dedupes, sorts desc', () => {
  const blobs = joinBlobs(REVLIST, BATCH);
  assert.equal(blobs.length, 4);
  assert.equal(blobs[0].sha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
  assert.equal(blobs[0].size, 12000000);
  assert.equal(blobs[0].path, 'assets/big.bin');
  // orphan blob keeps empty path
  const orphan = blobs.find(b => b.sha === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3');
  assert.ok(orphan);
  assert.equal(orphan!.path, '');
});

test('joinBlobs: handles malformed lines silently', () => {
  const blobs = joinBlobs('\nmalformed\nrev-only-line\n', 'malformed-batch-line\n');
  assert.deepEqual(blobs, []);
});

test('joinBlobs: zero/negative sizes dropped', () => {
  const blobs = joinBlobs(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 x',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1 blob 0',
  );
  assert.deepEqual(blobs, []);
});

test('shasForBatchCheck: strips paths', () => {
  const out = shasForBatchCheck(REVLIST);
  const shas = out.split('\n');
  assert.equal(shas[0], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
  assert.equal(shas[2], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3'); // orphan
  assert.equal(shas.length, 5);
});

test('formatSize: thresholds', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KiB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MiB');
  assert.equal(formatSize(3 * 1024 * 1024 * 1024), '3.00 GiB');
});

test('formatSize: invalid input', () => {
  assert.equal(formatSize(NaN), '0 B');
  assert.equal(formatSize(-10), '0 B');
});

test('summariseRepo: totals + topN', () => {
  const blobs = joinBlobs(REVLIST, BATCH);
  const s = summariseRepo(blobs, 2);
  assert.equal(s.blobCount, 4);
  assert.equal(s.totalBytes, 12000000 + 4321 + 600000 + 1234);
  assert.equal(s.top.length, 2);
  assert.equal(s.top[0].size, 12000000);
  assert.equal(s.top[1].size, 600000);
});

test('formatReportMarkdown: empty repo', () => {
  const md = formatReportMarkdown(summariseRepo([], 20));
  assert.match(md, /Repo size — 0 blobs · 0 B total/);
  assert.match(md, /empty repo/);
});

test('formatReportMarkdown: table renders with sizes + sha shortening', () => {
  const blobs = joinBlobs(REVLIST, BATCH);
  const md = formatReportMarkdown(summariseRepo(blobs, 20));
  assert.match(md, /Top 4 largest blobs/);
  assert.match(md, /\| 1 \| 11.4 MiB \| assets\/big.bin \| `aaaaaaaaaaaa` \|/);
  assert.match(md, /orphan blob/); // unnamed row mentions orphan
  assert.match(md, /filter-repo/); // footer hint present
});

test('formatReportMarkdown: pipes in paths are escaped', () => {
  const md = formatReportMarkdown(summariseRepo([
    { sha: '11'.padEnd(40, '1'), size: 100, path: 'dir/foo|bar.txt' },
  ], 20));
  assert.match(md, /foo\\\|bar\.txt/);
});
