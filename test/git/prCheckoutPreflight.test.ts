import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  aggregateVerdict,
  summariseChecks,
  checkOriginMatch,
  checkWorkingTree,
  checkBranchAlreadyLocal,
  checkBaseDivergence,
  checkConflictRisk,
  runPreflight,
  describeReport,
  renderPreflightMarkdown,
  countOverlap,
  PreflightCheck,
} from '../../src/git/prCheckoutPreflight';

test('aggregateVerdict: all ok = clear', () => {
  const checks: PreflightCheck[] = [
    { id: '1', title: 'a', severity: 'ok', message: 'm' },
    { id: '2', title: 'b', severity: 'ok', message: 'm' },
  ];
  assert.equal(aggregateVerdict(checks), 'clear');
});

test('aggregateVerdict: any warning = caution', () => {
  const checks: PreflightCheck[] = [
    { id: '1', title: 'a', severity: 'ok', message: 'm' },
    { id: '2', title: 'b', severity: 'warning', message: 'm' },
  ];
  assert.equal(aggregateVerdict(checks), 'caution');
});

test('aggregateVerdict: any error = blocked', () => {
  const checks: PreflightCheck[] = [
    { id: '1', title: 'a', severity: 'warning', message: 'm' },
    { id: '2', title: 'b', severity: 'error', message: 'm' },
  ];
  assert.equal(aggregateVerdict(checks), 'blocked');
});

test('aggregateVerdict: empty = clear (no checks, no objections)', () => {
  assert.equal(aggregateVerdict([]), 'clear');
});

test('summariseChecks: counts by severity', () => {
  const checks: PreflightCheck[] = [
    { id: '1', title: 'a', severity: 'ok', message: 'm' },
    { id: '2', title: 'b', severity: 'warning', message: 'm' },
    { id: '3', title: 'c', severity: 'warning', message: 'm' },
    { id: '4', title: 'd', severity: 'error', message: 'm' },
  ];
  const out = summariseChecks(checks);
  assert.deepEqual(out.counts, { ok: 1, warning: 2, error: 1 });
  assert.equal(out.verdict, 'blocked');
});

test('checkOriginMatch: matching slugs (case-insensitive) = ok', () => {
  const out = checkOriginMatch('Foo/Bar', 'foo/bar');
  assert.equal(out.severity, 'ok');
});

test('checkOriginMatch: mismatched slugs = error', () => {
  const out = checkOriginMatch('foo/bar', 'other/repo');
  assert.equal(out.severity, 'error');
  assert.match(out.message, /foo\/bar/);
  assert.match(out.message, /other\/repo/);
});

test('checkOriginMatch: missing local slug = error', () => {
  const out = checkOriginMatch(undefined, 'foo/bar');
  assert.equal(out.severity, 'error');
  assert.match(out.message, /does not have/);
});

test('checkWorkingTree: clean = ok', () => {
  assert.equal(checkWorkingTree(0).severity, 'ok');
});

test('checkWorkingTree: dirty = warning', () => {
  const out = checkWorkingTree(3);
  assert.equal(out.severity, 'warning');
  assert.match(out.message, /3 unstaged/);
});

test('checkWorkingTree: 1 dirty file = singular', () => {
  const out = checkWorkingTree(1);
  assert.match(out.message, /1 unstaged change\b/);
});

test('checkBranchAlreadyLocal: not present = ok', () => {
  assert.equal(checkBranchAlreadyLocal('feature/x', ['main', 'dev']).severity, 'ok');
});

test('checkBranchAlreadyLocal: present = warning', () => {
  const out = checkBranchAlreadyLocal('feature/x', ['main', 'feature/x']);
  assert.equal(out.severity, 'warning');
});

test('checkBaseDivergence: behindBy 0 = ok', () => {
  assert.equal(checkBaseDivergence('main', 0, 0).severity, 'ok');
});

test('checkBaseDivergence: behindBy > 0 = warning', () => {
  const out = checkBaseDivergence('main', 5, 2);
  assert.equal(out.severity, 'warning');
  assert.match(out.message, /5 commits behind/);
  assert.match(out.message, /2 local/);
});

test('checkBaseDivergence: singular when behindBy = 1', () => {
  const out = checkBaseDivergence('main', 1, 0);
  assert.match(out.message, /1 commit behind\b/);
});

test('checkConflictRisk: no overlap = ok', () => {
  assert.equal(checkConflictRisk(0, 10).severity, 'ok');
});

test('checkConflictRisk: low overlap (< 25%) = warning', () => {
  const out = checkConflictRisk(1, 20);
  assert.equal(out.severity, 'warning');
  assert.match(out.message, /1 of 20/);
});

test('checkConflictRisk: high overlap (>= 25%) = error', () => {
  const out = checkConflictRisk(5, 10);
  assert.equal(out.severity, 'error');
  assert.match(out.message, /50%/);
});

test('checkConflictRisk: 100% overlap = error', () => {
  const out = checkConflictRisk(3, 3);
  assert.equal(out.severity, 'error');
  assert.match(out.message, /100%/);
});

test('runPreflight: clean inputs = clear verdict', () => {
  const report = runPreflight({
    localSlug: 'foo/bar',
    prSlug: 'foo/bar',
    dirtyPaths: 0,
    headRefName: 'feature/x',
    baseRefName: 'main',
    localBranches: ['main'],
    baseBehindBy: 0,
    baseAheadBy: 0,
    overlappingFiles: 0,
    prTotalFiles: 5,
  });
  assert.equal(report.verdict, 'clear');
  assert.equal(report.checks.length, 5);
  assert.equal(report.counts.ok, 5);
});

test('runPreflight: mixed = caution when no error', () => {
  const report = runPreflight({
    localSlug: 'foo/bar',
    prSlug: 'foo/bar',
    dirtyPaths: 2,
    headRefName: 'feature/x',
    baseRefName: 'main',
    localBranches: ['main'],
    baseBehindBy: 0,
    baseAheadBy: 0,
    overlappingFiles: 0,
    prTotalFiles: 5,
  });
  assert.equal(report.verdict, 'caution');
});

test('runPreflight: origin mismatch = blocked even with everything else clean', () => {
  const report = runPreflight({
    localSlug: 'wrong/repo',
    prSlug: 'foo/bar',
    dirtyPaths: 0,
    headRefName: 'feature/x',
    baseRefName: 'main',
    localBranches: ['main'],
    baseBehindBy: 0,
    baseAheadBy: 0,
    overlappingFiles: 0,
    prTotalFiles: 5,
  });
  assert.equal(report.verdict, 'blocked');
});

test('describeReport: clear case', () => {
  const report = summariseChecks([
    { id: '1', title: 'Origin match', severity: 'ok', message: 'm' },
  ]);
  assert.equal(describeReport(report), 'Pre-flight: clear');
});

test('describeReport: blocked picks "blocked" wording', () => {
  const report = summariseChecks([
    { id: '1', title: 'Origin match', severity: 'error', message: 'm' },
  ]);
  const out = describeReport(report);
  assert.match(out, /blocked/);
  assert.match(out, /origin match/);
});

test('describeReport: lists warning titles', () => {
  const report = summariseChecks([
    { id: '1', title: 'Working tree', severity: 'warning', message: 'm' },
    { id: '2', title: 'Base alignment', severity: 'warning', message: 'm' },
  ]);
  const out = describeReport(report);
  assert.match(out, /2 warnings/);
  assert.match(out, /working tree/);
  assert.match(out, /base alignment/);
});

test('renderPreflightMarkdown: includes verdict in header', () => {
  const report = summariseChecks([
    { id: '1', title: 'Origin match', severity: 'ok', message: 'm' },
  ]);
  const md = renderPreflightMarkdown('foo/bar#42', report);
  assert.match(md, /^# Pre-flight: foo\/bar#42/);
  assert.match(md, /Verdict: \*\*CLEAR\*\*/);
});

test('renderPreflightMarkdown: hint rendered when present', () => {
  const report = summariseChecks([
    { id: '1', title: 'Working tree', severity: 'warning', message: 'dirty', hint: 'stash first' },
  ]);
  const md = renderPreflightMarkdown('demo', report);
  assert.match(md, /Hint: stash first/);
});

test('countOverlap: empty arrays = 0', () => {
  assert.equal(countOverlap([], ['a', 'b']), 0);
  assert.equal(countOverlap(['a', 'b'], []), 0);
});

test('countOverlap: counts case-insensitive matches', () => {
  assert.equal(countOverlap(['Src/Index.ts', 'Pkg.json'], ['src/index.ts', 'lib/x.ts']), 1);
});

test('countOverlap: duplicate paths only count toward overlap if they appear in recent set', () => {
  assert.equal(countOverlap(['a', 'a', 'b'], ['a']), 2);
});

test('countOverlap: no overlap = 0', () => {
  assert.equal(countOverlap(['a', 'b'], ['c', 'd']), 0);
});
