import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDiscoveredPatch,
  describeDiscoveryToast,
  looksLikePatchPath,
  dedupAndSortDiscoveries,
  buildDiscoveryDetail,
  isGitSightExportFilename,
  isPrunedDirectory,
} from '../../src/git/stashPatchDiscovery';
import { PatchPayloadInfo } from '../../src/git/stashPatchImport';

const NOW = 1_700_000_000_000;

const validInfo: PatchPayloadInfo = {
  looksValid: true,
  fileCount: 3,
  hasBinary: false,
  firstLine: 'Subject: tweak login retry',
};

const invalidInfo: PatchPayloadInfo = {
  looksValid: false,
  fileCount: 0,
  hasBinary: false,
  firstLine: 'random gibberish here',
};

const gitsightInfo: PatchPayloadInfo = {
  ...validInfo,
  gitsightMeta: {
    sourceBranch: 'main',
    subject: 'fix login retry',
    date: '2026-06-23',
  },
};

test('classifyDiscoveredPatch: fresh foreign patch -> offer', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/foo.patch',
    info: validInfo,
    mtimeMs: NOW - 5 * 60_000, // 5 min old
    nowMs: NOW,
    dismissed: new Set(),
  });
  assert.equal(r.verdict, 'offer');
});

test('classifyDiscoveredPatch: gitsight-stamped patch -> silent-gitsight', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/gitsight-stash__2026-06-23-1100__on-main__x__abcdef.patch',
    info: gitsightInfo,
    mtimeMs: NOW - 60_000,
    nowMs: NOW,
    dismissed: new Set(),
  });
  assert.equal(r.verdict, 'silent-gitsight');
});

test('classifyDiscoveredPatch: invalid body -> skip-invalid', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/random.patch',
    info: invalidInfo,
    mtimeMs: NOW,
    nowMs: NOW,
    dismissed: new Set(),
  });
  assert.equal(r.verdict, 'skip-invalid');
  assert.match(r.reason, /no diff --git|no recognisable/);
});

test('classifyDiscoveredPatch: zero-file but lookValid -> still skip-invalid', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/empty.patch',
    info: { looksValid: true, fileCount: 0, hasBinary: false, firstLine: '' },
    mtimeMs: NOW,
    nowMs: NOW,
    dismissed: new Set(),
  });
  assert.equal(r.verdict, 'skip-invalid');
});

test('classifyDiscoveredPatch: dismissed path -> skip-dismissed', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/foo.patch',
    info: validInfo,
    mtimeMs: NOW,
    nowMs: NOW,
    dismissed: new Set(['/work/repo/foo.patch']),
  });
  assert.equal(r.verdict, 'skip-dismissed');
});

test('classifyDiscoveredPatch: stale beyond window -> skip-stale', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/old.patch',
    info: validInfo,
    mtimeMs: NOW - 2 * 60 * 60_000, // 2 hours ago
    nowMs: NOW,
    dismissed: new Set(),
    freshnessWindowMinutes: 60,
  });
  assert.equal(r.verdict, 'skip-stale');
  assert.match(r.reason, /\d+m old/);
});

test('classifyDiscoveredPatch: future mtime treated as just-appeared (clock skew)', () => {
  const r = classifyDiscoveredPatch({
    absPath: '/work/repo/future.patch',
    info: validInfo,
    mtimeMs: NOW + 5 * 60_000, // 5 min in the future
    nowMs: NOW,
    dismissed: new Set(),
  });
  // age clamped to 0 -> not stale -> offer
  assert.equal(r.verdict, 'offer');
});

test('classifyDiscoveredPatch: custom freshness window respected', () => {
  const args = {
    absPath: '/work/repo/x.patch',
    info: validInfo,
    mtimeMs: NOW - 30 * 60_000, // 30 min
    nowMs: NOW,
    dismissed: new Set<string>(),
  };
  assert.equal(classifyDiscoveredPatch({ ...args, freshnessWindowMinutes: 60 }).verdict, 'offer');
  assert.equal(classifyDiscoveredPatch({ ...args, freshnessWindowMinutes: 15 }).verdict, 'skip-stale');
});

test('classifyDiscoveredPatch: empty path -> skip-invalid', () => {
  const r = classifyDiscoveredPatch({
    absPath: '',
    info: validInfo,
    mtimeMs: NOW,
    nowMs: NOW,
    dismissed: new Set(),
  });
  assert.equal(r.verdict, 'skip-invalid');
});

test('describeDiscoveryToast: foreign patch includes file count', () => {
  const msg = describeDiscoveryToast('foo.patch', validInfo, 'offer');
  assert.match(msg, /apply patch `foo\.patch`/);
  assert.match(msg, /3 file changes/);
});

test('describeDiscoveryToast: single-file uses singular', () => {
  const msg = describeDiscoveryToast('foo.patch', { ...validInfo, fileCount: 1 }, 'offer');
  assert.match(msg, /1 file change\./);
  assert.doesNotMatch(msg, /changes\./);
});

test('describeDiscoveryToast: gitsight-stamped surfaces branch hint', () => {
  const msg = describeDiscoveryToast('something.patch', gitsightInfo, 'silent-gitsight');
  assert.match(msg, /GitSight export/);
  assert.match(msg, /on `main`/);
});

test('describeDiscoveryToast: gitsight-stamped without branch survives', () => {
  const info: PatchPayloadInfo = { ...validInfo, gitsightMeta: { subject: 'x' } };
  const msg = describeDiscoveryToast('a.patch', info, 'silent-gitsight');
  assert.match(msg, /GitSight export/);
  assert.doesNotMatch(msg, /from on/);
});

test('looksLikePatchPath: .patch / .diff accepted', () => {
  assert.equal(looksLikePatchPath('/x/foo.patch'), true);
  assert.equal(looksLikePatchPath('/x/foo.diff'), true);
  assert.equal(looksLikePatchPath('/x/foo.PATCH'), true);
});

test('looksLikePatchPath: dot-temp + non-patch rejected', () => {
  assert.equal(looksLikePatchPath('/x/.foo.patch.swp'), false);
  assert.equal(looksLikePatchPath('/x/.hidden.patch'), false);
  assert.equal(looksLikePatchPath('/x/foo.txt'), false);
  assert.equal(looksLikePatchPath(''), false);
});

test('dedupAndSortDiscoveries: keeps freshest mtime per path, sorts desc', () => {
  const out = dedupAndSortDiscoveries([
    { absPath: '/a/x.patch', mtimeMs: 100 },
    { absPath: '/a/x.patch', mtimeMs: 200 }, // dup, newer
    { absPath: '/b/y.patch', mtimeMs: 150 },
    { absPath: '', mtimeMs: 999 },           // empty path filtered
  ]);
  assert.deepEqual(out.map(e => e.absPath), ['/a/x.patch', '/b/y.patch']);
  assert.deepEqual(out.map(e => e.mtimeMs), [200, 150]);
});

test('dedupAndSortDiscoveries: empty input -> empty output', () => {
  assert.deepEqual(dedupAndSortDiscoveries([]), []);
});

test('buildDiscoveryDetail: full gitsight stamp', () => {
  const d = buildDiscoveryDetail(gitsightInfo, 4096);
  assert.match(d, /on main/);
  assert.match(d, /subject: fix login retry/);
  assert.match(d, /3 files/);
  assert.match(d, /4\.0 KB/);
  assert.match(d, /2026-06-23/);
});

test('buildDiscoveryDetail: foreign patch falls back to firstLine', () => {
  const d = buildDiscoveryDetail(validInfo);
  assert.match(d, /Subject: tweak login retry/);
  assert.match(d, /3 files/);
});

test('buildDiscoveryDetail: truncates long firstLine to 80 chars + ellipsis', () => {
  const longLine = 'x'.repeat(200);
  const info: PatchPayloadInfo = { looksValid: true, fileCount: 1, hasBinary: false, firstLine: longLine };
  const d = buildDiscoveryDetail(info);
  assert.match(d, /x{77}\u2026/);
});

test('buildDiscoveryDetail: byte formatter handles MB', () => {
  const d = buildDiscoveryDetail(validInfo, 2 * 1024 * 1024);
  assert.match(d, /2\.0 MB/);
});

test('buildDiscoveryDetail: byte formatter handles plain bytes', () => {
  const d = buildDiscoveryDetail(validInfo, 200);
  assert.match(d, /200 B/);
});

test('isGitSightExportFilename: recognises stamp', () => {
  assert.equal(
    isGitSightExportFilename('gitsight-stash__2026-06-23-1100__on-main__some-subject__abcdef.patch'),
    true,
  );
  assert.equal(isGitSightExportFilename('something-else.patch'), false);
  assert.equal(isGitSightExportFilename(''), false);
});

test('isPrunedDirectory: skips common heavy/build dirs', () => {
  assert.equal(isPrunedDirectory('.git'), true);
  assert.equal(isPrunedDirectory('node_modules'), true);
  assert.equal(isPrunedDirectory('dist'), true);
  assert.equal(isPrunedDirectory('out'), true);
  assert.equal(isPrunedDirectory('out-test'), true);
  assert.equal(isPrunedDirectory('vendor'), true);
});

test('isPrunedDirectory: allows source/test dirs', () => {
  assert.equal(isPrunedDirectory('src'), false);
  assert.equal(isPrunedDirectory('test'), false);
  assert.equal(isPrunedDirectory('docs'), false);
  assert.equal(isPrunedDirectory('.gitsight'), false);
});
