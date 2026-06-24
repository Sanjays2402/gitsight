import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyDryRunCheck,
  parseDryRunStat,
  describeDryRun,
  buildDryRunReport,
  defaultApplyButton,
  shouldOfferApply,
} from '../../src/git/stashPatchDryRun';

// ── classifyDryRunCheck ────────────────────────────────────────────────

test('classifyDryRunCheck: exit 0 -> clean', () => {
  const r = classifyDryRunCheck({ exitCode: 0, stderr: '' });
  assert.equal(r.verdict, 'clean');
  assert.equal(r.conflictedFiles.length, 0);
  assert.match(r.reason, /cleanly/);
});

test('classifyDryRunCheck: exit 0 with noise stderr still clean', () => {
  const r = classifyDryRunCheck({ exitCode: 0, stderr: 'warning: trailing whitespace' });
  assert.equal(r.verdict, 'clean');
});

test('classifyDryRunCheck: corrupt patch -> invalid', () => {
  const r = classifyDryRunCheck({
    exitCode: 128,
    stderr: 'fatal: corrupt patch at line 5',
  });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.conflictedFiles.length, 0);
  assert.match(r.reason, /corrupt/);
});

test('classifyDryRunCheck: garbage at top is also invalid', () => {
  const r = classifyDryRunCheck({
    exitCode: 128,
    stderr: 'error: garbage at end of patch',
  });
  assert.equal(r.verdict, 'invalid');
});

test('classifyDryRunCheck: missing 3-way blob -> rejected', () => {
  const r = classifyDryRunCheck({
    exitCode: 1,
    stderr: 'error: repository lacks the necessary blob to fall back on 3-way merge',
  });
  assert.equal(r.verdict, 'rejected');
});

test('classifyDryRunCheck: hunk failed -> conflicts with file extraction', () => {
  const r = classifyDryRunCheck({
    exitCode: 1,
    stderr: [
      'error: patch failed: src/foo.ts:32',
      'error: patch failed: src/bar.ts:5',
      'error: src/foo.ts: patch does not apply',
    ].join('\n'),
  });
  assert.equal(r.verdict, 'conflicts');
  assert.deepEqual(r.conflictedFiles.sort(), ['src/bar.ts', 'src/foo.ts']);
  assert.match(r.reason, /2 files would conflict/);
});

test('classifyDryRunCheck: patch does not apply without hunk lines still -> conflicts', () => {
  const r = classifyDryRunCheck({
    exitCode: 1,
    stderr: 'error: src/x.ts: patch does not apply',
  });
  assert.equal(r.verdict, 'conflicts');
});

test('classifyDryRunCheck: opaque failure -> unknown', () => {
  const r = classifyDryRunCheck({
    exitCode: 1,
    stderr: 'some-random-error',
  });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.reason, 'some-random-error');
});

test('classifyDryRunCheck: empty stderr non-zero exit -> unknown with placeholder', () => {
  const r = classifyDryRunCheck({ exitCode: 1, stderr: '' });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /unable to classify/);
});

test('classifyDryRunCheck: deduplicates per-file mentions across passes', () => {
  const r = classifyDryRunCheck({
    exitCode: 1,
    stderr: [
      'error: patch failed: src/foo.ts:1',
      'error: patch failed: src/foo.ts:32',
      'error: src/foo.ts: patch does not apply',
    ].join('\n'),
  });
  assert.deepEqual(r.conflictedFiles, ['src/foo.ts']);
});

// ── parseDryRunStat ────────────────────────────────────────────────────

test('parseDryRunStat: parses standard --stat output', () => {
  const out = [
    ' src/foo.ts | 12 ++++++++++--',
    ' docs/x.md  |  4 ++--',
    ' 2 files changed, 14 insertions(+), 2 deletions(-)',
  ].join('\n');
  const r = parseDryRunStat(out);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].path, 'src/foo.ts');
  assert.equal(r.rows[0].totalLines, 12);
  assert.equal(r.rows[0].insertions, 10);
  assert.equal(r.rows[0].deletions, 2);
  assert.equal(r.rows[1].path, 'docs/x.md');
  assert.equal(r.rows[1].totalLines, 4);
  assert.equal(r.rows[1].insertions, 2);
  assert.equal(r.rows[1].deletions, 2);
  assert.equal(r.totalInsertions, 12);
  assert.equal(r.totalDeletions, 4);
  assert.ok(r.footer);
  assert.match(r.footer!, /2 files changed/);
});

test('parseDryRunStat: binary file marker', () => {
  const out = ' img/x.png | Bin 0 -> 1234 bytes';
  const r = parseDryRunStat(out);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].binary, true);
  assert.equal(r.rows[0].path, 'img/x.png');
  assert.equal(r.hasBinary, true);
});

test('parseDryRunStat: empty bar - falls back to all insertions', () => {
  // git scales bars: a 1-line change can render with an empty bar.
  const out = ' tiny.txt | 1 ';
  const r = parseDryRunStat(out);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].insertions, 1);
  assert.equal(r.rows[0].deletions, 0);
});

test('parseDryRunStat: ignores blank lines + unknown lines', () => {
  const out = [
    '',
    'progress: applying patch',
    ' src/x.ts | 2 +-',
    '',
  ].join('\n');
  const r = parseDryRunStat(out);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].insertions, 1);
  assert.equal(r.rows[0].deletions, 1);
});

test('parseDryRunStat: empty input yields empty summary', () => {
  const r = parseDryRunStat('');
  assert.deepEqual(r.rows, []);
  assert.equal(r.totalInsertions, 0);
  assert.equal(r.totalDeletions, 0);
  assert.equal(r.hasBinary, false);
  assert.equal(r.footer, undefined);
});

test('parseDryRunStat: mixed text + binary in one stat block', () => {
  const out = [
    ' src/foo.ts | 6 ++++--',
    ' img/a.png  | Bin 0 -> 5 bytes',
    ' 2 files changed, 4 insertions(+), 2 deletions(-)',
  ].join('\n');
  const r = parseDryRunStat(out);
  assert.equal(r.rows.length, 2);
  assert.equal(r.hasBinary, true);
  assert.equal(r.rows[1].binary, true);
});

// ── describeDryRun ─────────────────────────────────────────────────────

test('describeDryRun: clean -> includes file count + line totals', () => {
  const stat = parseDryRunStat(' a | 4 ++--\n');
  const s = describeDryRun({ verdict: 'clean', stat, conflictedFiles: [] });
  assert.match(s, /Dry-run: clean/);
  assert.match(s, /1 file/);
  assert.match(s, /\+2 -2/);
});

test('describeDryRun: conflicts with sample files', () => {
  const stat = parseDryRunStat('');
  const s = describeDryRun({
    verdict: 'conflicts', stat, conflictedFiles: ['a.ts', 'b.ts', 'c.ts'],
  });
  assert.match(s, /3 files would conflict/);
  assert.match(s, /a\.ts, b\.ts/);
  assert.match(s, /\+1 more/);
});

test('describeDryRun: rejected uses reason copy', () => {
  const stat = parseDryRunStat('');
  const s = describeDryRun({ verdict: 'rejected', stat, conflictedFiles: [], reason: 'no 3-way base' });
  assert.match(s, /rejected/);
  assert.match(s, /no 3-way base/);
});

test('describeDryRun: invalid uses reason copy', () => {
  const stat = parseDryRunStat('');
  const s = describeDryRun({ verdict: 'invalid', stat, conflictedFiles: [], reason: 'corrupt patch' });
  assert.match(s, /invalid patch/);
  assert.match(s, /corrupt patch/);
});

// ── buildDryRunReport ──────────────────────────────────────────────────

test('buildDryRunReport: clean verdict + stat + meta header', () => {
  const stat = parseDryRunStat(' src/foo.ts | 4 ++--');
  const md = buildDryRunReport({
    filename: '/tmp/some-stash.patch',
    check: classifyDryRunCheck({ exitCode: 0, stderr: '' }),
    stat,
    meta: { date: '2026-06-23-1400', sourceBranch: 'feature/x', subject: 'add logout' },
  });
  assert.match(md, /# Dry-run: `some-stash\.patch`/);
  assert.match(md, /2026-06-23-1400/);
  assert.match(md, /on `feature\/x`/);
  assert.match(md, /subject: add logout/);
  assert.match(md, /CLEAN/);
  assert.match(md, /\| `src\/foo\.ts` \| \+2 \/ -2/);
  assert.match(md, /safe to apply/);
});

test('buildDryRunReport: conflicts verdict lists conflicted files separately', () => {
  const stat = parseDryRunStat(' src/foo.ts | 6 ++++--');
  const md = buildDryRunReport({
    filename: 'p.patch',
    check: classifyDryRunCheck({
      exitCode: 1,
      stderr: 'error: patch failed: src/foo.ts:1\nerror: src/foo.ts: patch does not apply',
    }),
    stat,
  });
  assert.match(md, /CONFLICTS/);
  assert.match(md, /## Conflicted files/);
  assert.match(md, /- `src\/foo\.ts`/);
  assert.match(md, /conflict markers/);
});

test('buildDryRunReport: rejected -> consider re-creating copy', () => {
  const md = buildDryRunReport({
    filename: 'p.patch',
    check: classifyDryRunCheck({
      exitCode: 1,
      stderr: 'error: repository lacks the necessary blob',
    }),
    stat: parseDryRunStat(''),
  });
  assert.match(md, /REJECTED/);
  assert.match(md, /re-creating it/);
});

test('buildDryRunReport: invalid -> editor inspection copy', () => {
  const md = buildDryRunReport({
    filename: 'p.patch',
    check: classifyDryRunCheck({
      exitCode: 128,
      stderr: 'fatal: corrupt patch at line 1',
    }),
    stat: parseDryRunStat(''),
  });
  assert.match(md, /INVALID/);
  assert.match(md, /Open the file in the editor/);
});

test('buildDryRunReport: empty stat produces the empty-stat copy + still shows verdict', () => {
  const md = buildDryRunReport({
    filename: 'p.patch',
    check: classifyDryRunCheck({ exitCode: 0, stderr: '' }),
    stat: parseDryRunStat(''),
  });
  assert.match(md, /CLEAN/);
  assert.match(md, /No file changes detected/);
});

// ── defaultApplyButton + shouldOfferApply ──────────────────────────────

test('defaultApplyButton: clean -> apply, everything else -> cancel', () => {
  assert.equal(defaultApplyButton('clean'), 'apply');
  assert.equal(defaultApplyButton('conflicts'), 'cancel');
  assert.equal(defaultApplyButton('rejected'), 'cancel');
  assert.equal(defaultApplyButton('invalid'), 'cancel');
  assert.equal(defaultApplyButton('unknown'), 'cancel');
});

test('shouldOfferApply: invalid -> false, all others -> true', () => {
  assert.equal(shouldOfferApply('clean'), true);
  assert.equal(shouldOfferApply('conflicts'), true);
  assert.equal(shouldOfferApply('rejected'), true);
  assert.equal(shouldOfferApply('unknown'), true);
  assert.equal(shouldOfferApply('invalid'), false);
});
