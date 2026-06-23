import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  inspectPatchPayload,
  parseGitSightFilename,
  classifyApplyResult,
  buildPatchPickerLabel,
  buildPatchPickerDetail,
  sortPatchCandidates,
  PatchCandidate,
} from '../../src/git/stashPatchImport';

const DIFF_BODY = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1234567..abcdefg 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,3 @@',
  '-const x = 1;',
  '+const x = 2;',
  '',
].join('\n');

const FORMAT_PATCH_BODY = [
  'From abc123 Mon Sep 17 00:00:00 2001',
  'From: Sanjay <sanjay@example.com>',
  'Date: Tue, 23 Jun 2026 11:00:00 -0700',
  'Subject: [PATCH] feat: add logout flow',
  '',
  '---',
  ' src/auth/logout.ts | 5 +++++',
  ' 1 file changed, 5 insertions(+)',
  '',
  'diff --git a/src/auth/logout.ts b/src/auth/logout.ts',
  '+const x = 1;',
].join('\n');

// ── inspectPatchPayload ───────────────────────────────────────────────

test('inspectPatchPayload: empty body -> looksValid=false, no file count', () => {
  const info = inspectPatchPayload('');
  assert.equal(info.looksValid, false);
  assert.equal(info.fileCount, 0);
  assert.equal(info.hasBinary, false);
  assert.equal(info.firstLine, '');
});

test('inspectPatchPayload: bare diff body -> looksValid=true, fileCount=1', () => {
  const info = inspectPatchPayload(DIFF_BODY);
  assert.equal(info.looksValid, true);
  assert.equal(info.fileCount, 1);
  assert.equal(info.hasBinary, false);
});

test('inspectPatchPayload: format-patch body -> looksValid=true, subject extracted', () => {
  const info = inspectPatchPayload(FORMAT_PATCH_BODY);
  assert.equal(info.looksValid, true);
  assert.equal(info.fileCount, 1);
  assert.equal(info.firstLine, '[PATCH] feat: add logout flow');
});

test('inspectPatchPayload: 3-file diff -> fileCount=3', () => {
  const body = [DIFF_BODY, DIFF_BODY.replace('src/foo', 'src/bar'), DIFF_BODY.replace('src/foo', 'src/baz')].join('\n');
  const info = inspectPatchPayload(body);
  assert.equal(info.fileCount, 3);
});

test('inspectPatchPayload: binary marker -> hasBinary=true', () => {
  const body = `${DIFF_BODY}\nBinary files a/icon.png and b/icon.png differ\n`;
  const info = inspectPatchPayload(body);
  assert.equal(info.hasBinary, true);
});

test('inspectPatchPayload: CRLF line endings -> still detected as valid', () => {
  const info = inspectPatchPayload(DIFF_BODY.replace(/\n/g, '\r\n'));
  assert.equal(info.looksValid, true);
  assert.equal(info.fileCount, 1);
});

test('inspectPatchPayload: nonsense body -> looksValid=false', () => {
  const info = inspectPatchPayload('This is just some random text with no patch headers.');
  assert.equal(info.looksValid, false);
  assert.equal(info.fileCount, 0);
});

test('inspectPatchPayload: filename arg surfaces gitsight meta when matching', () => {
  const info = inspectPatchPayload(DIFF_BODY, 'gitsight-stash__2026-06-23-1100__on-main__add-logout__abc123.patch');
  assert.equal(info.gitsightMeta?.sourceBranch, 'main');
  assert.equal(info.gitsightMeta?.date, '2026-06-23-1100');
  assert.equal(info.gitsightMeta?.subject, 'add logout');
});

test('inspectPatchPayload: filename arg silent when not gitsight-shaped', () => {
  const info = inspectPatchPayload(DIFF_BODY, 'something-else.patch');
  assert.equal(info.gitsightMeta, undefined);
});

// ── parseGitSightFilename ─────────────────────────────────────────────

test('parseGitSightFilename: full path basename extraction', () => {
  const meta = parseGitSightFilename('/Users/sanjay/patches/gitsight-stash__2026-06-23-1100__on-main__hello__abc123.patch');
  assert.equal(meta?.sourceBranch, 'main');
  assert.equal(meta?.subject, 'hello');
});

test('parseGitSightFilename: hyphenated subject converted to spaces', () => {
  const meta = parseGitSightFilename('gitsight-stash__2026-06-23-1100__on-feat-branch__add-the-logout-flow__abc123.patch');
  assert.equal(meta?.subject, 'add the logout flow');
});

test('parseGitSightFilename: non-matching name returns undefined', () => {
  assert.equal(parseGitSightFilename('random.patch'), undefined);
  assert.equal(parseGitSightFilename(''), undefined);
});

test('parseGitSightFilename: branch with hyphens (F127 sanitises slashes to hyphens)', () => {
  // F127 sanitiseFilenameComponent maps non-alphanumerics to `-`, so a
  // release/2026.q2 source branch lands as `release-2026-q2`. Round-trip
  // recovery of the original branch isn't possible from the filename
  // alone; we just preserve what's in the filename.
  const meta = parseGitSightFilename('gitsight-stash__2026-06-23-1100__on-release-2026-q2__bump__abc123.patch');
  assert.equal(meta?.sourceBranch, 'release-2026-q2');
});

// ── classifyApplyResult ───────────────────────────────────────────────

test('classifyApplyResult: exit=0, no stderr -> applied cleanly', () => {
  const r = classifyApplyResult({ exitCode: 0, stderr: '' });
  assert.equal(r.outcome, 'applied');
  assert.match(r.reason, /clean/);
  assert.deepEqual(r.conflictedFiles, []);
});

test('classifyApplyResult: exit=0 with U marker -> applied-with-conflicts', () => {
  const r = classifyApplyResult({ exitCode: 0, stderr: 'Applied patch foo.patch cleanly.\nU src/foo.ts\nU src/bar.ts' });
  assert.equal(r.outcome, 'applied-with-conflicts');
  assert.deepEqual(r.conflictedFiles, ['src/foo.ts', 'src/bar.ts']);
});

test('classifyApplyResult: exit=0 with "with conflicts" phrase -> applied-with-conflicts', () => {
  const r = classifyApplyResult({ exitCode: 0, stderr: 'Applied patch a/b with conflicts.\n' });
  assert.equal(r.outcome, 'applied-with-conflicts');
});

test('classifyApplyResult: exit=1 with U marker (fell back to 3way) -> applied-with-conflicts', () => {
  const r = classifyApplyResult({ exitCode: 1, stderr: 'fell back on 3-way merge\nU src/x.ts\n' });
  assert.equal(r.outcome, 'applied-with-conflicts');
  assert.deepEqual(r.conflictedFiles, ['src/x.ts']);
});

test('classifyApplyResult: exit=1 with "patch does not apply" -> rejected', () => {
  const r = classifyApplyResult({ exitCode: 1, stderr: 'error: patch failed: src/foo.ts:10\nerror: patch does not apply\n' });
  assert.equal(r.outcome, 'rejected');
});

test('classifyApplyResult: exit=1 with "already applied" hint -> already-applied', () => {
  const r = classifyApplyResult({ exitCode: 1, stderr: 'Skipping patch, already applied to working tree.\n' });
  assert.equal(r.outcome, 'already-applied');
});

test('classifyApplyResult: exit=1 with already-applied AND failed -> rejected wins', () => {
  // If both are present, the actual failure should win (we can't claim
  // the patch is already applied when git also said hunk #1 failed).
  const r = classifyApplyResult({ exitCode: 1, stderr: 'patch is already applied somewhere\nerror: hunk #1 failed at line 10\n' });
  assert.equal(r.outcome, 'rejected');
});

test('classifyApplyResult: exit=1 with unknown error -> failed', () => {
  const r = classifyApplyResult({ exitCode: 1, stderr: 'fatal: not a git repository\n' });
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /not a git repository/);
});

test('classifyApplyResult: extractConflictedFiles dedupes', () => {
  const r = classifyApplyResult({ exitCode: 0, stderr: 'U src/foo.ts\nU src/foo.ts\nU src/bar.ts' });
  assert.deepEqual(r.conflictedFiles, ['src/foo.ts', 'src/bar.ts']);
});

test('classifyApplyResult: CONFLICT markers parsed too', () => {
  const r = classifyApplyResult({ exitCode: 1, stderr: 'CONFLICT (content): Merge conflict in src/foo.ts\nU src/foo.ts' });
  assert.equal(r.outcome, 'applied-with-conflicts');
  assert.ok(r.conflictedFiles.includes('src/foo.ts'));
});

test('classifyApplyResult: reason truncated to 200 chars', () => {
  const long = 'x'.repeat(500);
  const r = classifyApplyResult({ exitCode: 2, stderr: long });
  assert.ok(r.reason.length <= 200);
});

// ── buildPatchPickerLabel + Detail ────────────────────────────────────

test('buildPatchPickerLabel: gitsight stamp uses friendly form', () => {
  const info = inspectPatchPayload(DIFF_BODY, 'gitsight-stash__2026-06-23-1100__on-main__add-x__abc123.patch');
  const label = buildPatchPickerLabel('/abs/gitsight-stash__2026-06-23-1100__on-main__add-x__abc123.patch', info);
  assert.match(label, /gitsight-stash/);
  assert.match(label, /on main/);
  assert.match(label, /1 file/);
});

test('buildPatchPickerLabel: foreign patch falls back to basename', () => {
  const info = inspectPatchPayload(DIFF_BODY);
  const label = buildPatchPickerLabel('/abs/feature-x.patch', info);
  assert.match(label, /feature-x\.patch/);
  assert.match(label, /1 file/);
});

test('buildPatchPickerLabel: binary suffix appended when applicable', () => {
  const info = inspectPatchPayload(`${DIFF_BODY}\nBinary files a/x b/x differ`);
  const label = buildPatchPickerLabel('x.patch', info);
  assert.match(label, /contains binary/);
});

test('buildPatchPickerDetail: gitsight subject preferred over first line', () => {
  const info = inspectPatchPayload(DIFF_BODY, 'gitsight-stash__2026-06-23-1100__on-main__feat-add-x__abc123.patch');
  const detail = buildPatchPickerDetail(info);
  assert.match(detail, /feat add x/);
});

test('buildPatchPickerDetail: foreign patch falls back to first line', () => {
  const info = inspectPatchPayload(FORMAT_PATCH_BODY);
  const detail = buildPatchPickerDetail(info);
  assert.match(detail, /\[PATCH\] feat: add logout flow/);
});

test('buildPatchPickerDetail: empty body returns "no subject" placeholder', () => {
  const info = inspectPatchPayload('');
  const detail = buildPatchPickerDetail(info);
  assert.equal(detail, 'no subject');
});

// ── sortPatchCandidates ───────────────────────────────────────────────

test('sortPatchCandidates: gitsight-stamped files first', () => {
  const candidates: PatchCandidate[] = [
    { filename: 'aaa.patch', info: inspectPatchPayload(DIFF_BODY) },
    { filename: 'gitsight-stash__2026-06-23-1100__on-main__x__abc123.patch', info: inspectPatchPayload(DIFF_BODY, 'gitsight-stash__2026-06-23-1100__on-main__x__abc123.patch') },
    { filename: 'zzz.patch', info: inspectPatchPayload(DIFF_BODY) },
  ];
  const out = sortPatchCandidates(candidates);
  assert.match(out[0].filename, /gitsight-stash/);
});

test('sortPatchCandidates: among gitsight-stamped, more files float up', () => {
  const big = `${DIFF_BODY}\n${DIFF_BODY.replace('src/foo', 'src/bar')}`;
  const candidates: PatchCandidate[] = [
    { filename: 'a.patch', info: inspectPatchPayload(DIFF_BODY, 'gitsight-stash__2026-06-23-1100__on-main__a__abc123.patch') },
    { filename: 'b.patch', info: inspectPatchPayload(big,       'gitsight-stash__2026-06-23-1100__on-main__b__abc123.patch') },
  ];
  const out = sortPatchCandidates(candidates);
  assert.equal(out[0].filename, 'b.patch');
});

test('sortPatchCandidates: among same tier + same file count, alphabetical', () => {
  const candidates: PatchCandidate[] = [
    { filename: 'zzz.patch', info: inspectPatchPayload(DIFF_BODY) },
    { filename: 'aaa.patch', info: inspectPatchPayload(DIFF_BODY) },
    { filename: 'mmm.patch', info: inspectPatchPayload(DIFF_BODY) },
  ];
  const out = sortPatchCandidates(candidates);
  assert.deepEqual(out.map(c => c.filename), ['aaa.patch', 'mmm.patch', 'zzz.patch']);
});

test('sortPatchCandidates: does NOT mutate input', () => {
  const candidates: PatchCandidate[] = [
    { filename: 'zzz.patch', info: inspectPatchPayload(DIFF_BODY) },
    { filename: 'aaa.patch', info: inspectPatchPayload(DIFF_BODY) },
  ];
  const original = candidates.map(c => c.filename);
  sortPatchCandidates(candidates);
  assert.deepEqual(candidates.map(c => c.filename), original);
});
