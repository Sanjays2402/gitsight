import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  aggregateMergeVerdict,
  summariseMergeReport,
  checkReviewApprovals,
  checkStatusChecks,
  checkConflictFreshness,
  checkBaseDivergence,
  checkTestImpactSynced,
  runPreMergeChecklist,
  describeMergeReport,
  renderMergeReport,
  allowsOverride,
  normaliseMergeStateStatus,
  normaliseMergeable,
  MergeCheck,
} from '../../src/git/preMergeChecklist';

// ── aggregate ─────────────────────────────────────────────────────────

test('aggregateMergeVerdict: any error -> blocked', () => {
  const checks: MergeCheck[] = [
    { id: 'a', title: 'A', severity: 'ok', message: '' },
    { id: 'b', title: 'B', severity: 'error', message: '' },
  ];
  assert.equal(aggregateMergeVerdict(checks), 'blocked');
});

test('aggregateMergeVerdict: warnings -> caution', () => {
  const checks: MergeCheck[] = [
    { id: 'a', title: 'A', severity: 'warning', message: '' },
    { id: 'b', title: 'B', severity: 'ok', message: '' },
  ];
  assert.equal(aggregateMergeVerdict(checks), 'caution');
});

test('aggregateMergeVerdict: all ok -> ready', () => {
  const checks: MergeCheck[] = [
    { id: 'a', title: 'A', severity: 'ok', message: '' },
  ];
  assert.equal(aggregateMergeVerdict(checks), 'ready');
});

test('summariseMergeReport: counts per severity', () => {
  const checks: MergeCheck[] = [
    { id: 'a', title: 'A', severity: 'ok', message: '' },
    { id: 'b', title: 'B', severity: 'warning', message: '' },
    { id: 'c', title: 'C', severity: 'warning', message: '' },
    { id: 'd', title: 'D', severity: 'error', message: '' },
  ];
  const r = summariseMergeReport(checks);
  assert.deepEqual(r.counts, { ok: 1, warning: 2, error: 1 });
  assert.equal(r.verdict, 'blocked');
});

// ── reviews ───────────────────────────────────────────────────────────

test('checkReviewApprovals: 0/1 -> error', () => {
  const c = checkReviewApprovals(0, 1);
  assert.equal(c.severity, 'error');
  assert.match(c.message, /0\/1/);
});

test('checkReviewApprovals: 1/2 -> warning (one short)', () => {
  const c = checkReviewApprovals(1, 2);
  assert.equal(c.severity, 'warning');
  assert.match(c.message, /one short/);
});

test('checkReviewApprovals: 2/2 -> ok', () => {
  const c = checkReviewApprovals(2, 2);
  assert.equal(c.severity, 'ok');
});

test('checkReviewApprovals: extra approvals also ok', () => {
  const c = checkReviewApprovals(5, 1);
  assert.equal(c.severity, 'ok');
});

test('checkReviewApprovals: required=0 treats as require 1', () => {
  // We never let a PR merge with literally zero reviewers required;
  // a 0 requirement is treated as 1.
  const c = checkReviewApprovals(0, 0);
  assert.equal(c.severity, 'error');
});

// ── status checks ────────────────────────────────────────────────────

test('checkStatusChecks: CLEAN -> ok', () => {
  assert.equal(checkStatusChecks('CLEAN').severity, 'ok');
});

test('checkStatusChecks: HAS_HOOKS -> ok (same as CLEAN)', () => {
  assert.equal(checkStatusChecks('HAS_HOOKS').severity, 'ok');
});

test('checkStatusChecks: UNSTABLE -> warning (non-required failed)', () => {
  const c = checkStatusChecks('UNSTABLE');
  assert.equal(c.severity, 'warning');
  assert.match(c.message, /non-required/);
});

test('checkStatusChecks: BEHIND -> warning + hint to rebase', () => {
  const c = checkStatusChecks('BEHIND');
  assert.equal(c.severity, 'warning');
  assert.match(c.hint!, /merge or rebase from base/);
});

test('checkStatusChecks: BLOCKED -> error with failing count', () => {
  const c = checkStatusChecks('BLOCKED', 3);
  assert.equal(c.severity, 'error');
  assert.match(c.message, /3 required checks/);
});

test('checkStatusChecks: DIRTY -> warning (defers to conflict gate)', () => {
  // DIRTY should surface in the dedicated conflict-freshness gate as
  // an error; we still emit a warning here so a caller that only
  // looks at status-checks gets a heads-up.
  const c = checkStatusChecks('DIRTY');
  assert.equal(c.severity, 'warning');
});

test('checkStatusChecks: UNKNOWN -> warning', () => {
  assert.equal(checkStatusChecks('UNKNOWN').severity, 'warning');
});

// ── conflict freshness ──────────────────────────────────────────────

test('checkConflictFreshness: MERGEABLE + CLEAN -> ok', () => {
  assert.equal(checkConflictFreshness('MERGEABLE', 'CLEAN').severity, 'ok');
});

test('checkConflictFreshness: CONFLICTING -> error', () => {
  const c = checkConflictFreshness('CONFLICTING');
  assert.equal(c.severity, 'error');
  assert.match(c.message, /merge conflicts/);
});

test('checkConflictFreshness: DIRTY merge state -> error even if MERGEABLE', () => {
  // Defensive: GitHub sometimes reports mergeable=MERGEABLE while
  // mergeStateStatus=DIRTY during the brief computation window.
  // The conflict gate trusts mergeStateStatus when present.
  const c = checkConflictFreshness('MERGEABLE', 'DIRTY');
  assert.equal(c.severity, 'error');
});

test('checkConflictFreshness: UNKNOWN -> warning', () => {
  const c = checkConflictFreshness('UNKNOWN');
  assert.equal(c.severity, 'warning');
  assert.match(c.message, /computing mergeability/);
});

// ── base divergence ────────────────────────────────────────────────

test('checkBaseDivergence: 0 -> ok', () => {
  const c = checkBaseDivergence('main', 0);
  assert.equal(c.severity, 'ok');
  assert.match(c.message, /Up-to-date with main/);
});

test('checkBaseDivergence: small drift -> ok', () => {
  const c = checkBaseDivergence('main', 3);
  assert.equal(c.severity, 'ok');
  assert.match(c.message, /3 commits behind/);
});

test('checkBaseDivergence: >=10 commits -> warning (default threshold)', () => {
  const c = checkBaseDivergence('main', 15);
  assert.equal(c.severity, 'warning');
  assert.match(c.message, /15 commits behind/);
});

test('checkBaseDivergence: custom threshold honoured', () => {
  // With threshold=20, a 15-commit drift is still ok.
  const c = checkBaseDivergence('main', 15, 20);
  assert.equal(c.severity, 'ok');
});

// ── test-impact synced ─────────────────────────────────────────────

test('checkTestImpactSynced: no block -> ok (opt-in)', () => {
  const c = checkTestImpactSynced({ hasBlock: false, blockMatchesHead: false });
  assert.equal(c.severity, 'ok');
  assert.match(c.message, /opt-in/);
});

test('checkTestImpactSynced: block fresh -> ok', () => {
  const c = checkTestImpactSynced({ hasBlock: true, blockMatchesHead: true });
  assert.equal(c.severity, 'ok');
  assert.match(c.message, /up-to-date/);
});

test('checkTestImpactSynced: block stale -> warning', () => {
  const c = checkTestImpactSynced({ hasBlock: true, blockMatchesHead: false });
  assert.equal(c.severity, 'warning');
  assert.match(c.message, /stale/);
});

// ── composite ──────────────────────────────────────────────────────

test('runPreMergeChecklist: happy path -> ready', () => {
  const r = runPreMergeChecklist({
    approvingReviews: 2,
    requiredApprovals: 2,
    statusCheckVerdict: 'CLEAN',
    mergeable: 'MERGEABLE',
    baseBranch: 'main',
    baseBehindBy: 0,
    testImpactHasBlock: false,
    testImpactBlockMatchesHead: false,
  });
  assert.equal(r.verdict, 'ready');
  assert.equal(r.counts.error, 0);
  assert.equal(r.counts.warning, 0);
});

test('runPreMergeChecklist: caution mix -> caution', () => {
  const r = runPreMergeChecklist({
    approvingReviews: 1,
    requiredApprovals: 2,
    statusCheckVerdict: 'CLEAN',
    mergeable: 'MERGEABLE',
    baseBranch: 'main',
    baseBehindBy: 0,
    testImpactHasBlock: true,
    testImpactBlockMatchesHead: false,
  });
  assert.equal(r.verdict, 'caution');
  assert.equal(r.counts.warning, 2);
});

test('runPreMergeChecklist: any error -> blocked', () => {
  const r = runPreMergeChecklist({
    approvingReviews: 0,
    requiredApprovals: 1,
    statusCheckVerdict: 'BLOCKED',
    mergeable: 'CONFLICTING',
    baseBranch: 'main',
    baseBehindBy: 50,
    testImpactHasBlock: false,
    testImpactBlockMatchesHead: false,
  });
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.counts.error, 3); // reviews + status + conflict
});

test('runPreMergeChecklist: conflict-freshness first in checks list for readability', () => {
  const r = runPreMergeChecklist({
    approvingReviews: 1,
    requiredApprovals: 1,
    statusCheckVerdict: 'CLEAN',
    mergeable: 'CONFLICTING',
    baseBranch: 'main',
    baseBehindBy: 0,
    testImpactHasBlock: false,
    testImpactBlockMatchesHead: false,
  });
  assert.equal(r.checks[0].id, 'conflict-freshness');
});

// ── describeMergeReport ────────────────────────────────────────────

test('describeMergeReport: ready', () => {
  const r = summariseMergeReport([
    { id: 'a', title: 'A', severity: 'ok', message: '' },
  ]);
  assert.equal(describeMergeReport(r), 'Merge: ready');
});

test('describeMergeReport: caution lists ids', () => {
  const r = summariseMergeReport([
    { id: 'review-approvals', title: 'R', severity: 'warning', message: '' },
    { id: 'base-divergence', title: 'B', severity: 'warning', message: '' },
  ]);
  const s = describeMergeReport(r);
  assert.match(s, /caution - 2 warnings/);
  assert.match(s, /review-approvals, base-divergence/);
});

test('describeMergeReport: blocked uses error count', () => {
  const r = summariseMergeReport([
    { id: 'a', title: 'A', severity: 'error', message: '' },
  ]);
  assert.match(describeMergeReport(r), /blocked - 1 error/);
});

// ── renderMergeReport ──────────────────────────────────────────────

test('renderMergeReport: includes verdict + each check', () => {
  const r = summariseMergeReport([
    { id: 'a', title: 'A check', severity: 'ok', message: 'a-msg' },
    { id: 'b', title: 'B check', severity: 'warning', message: 'b-msg', hint: 'b-hint' },
  ]);
  const md = renderMergeReport('PR #42 some title', r);
  assert.match(md, /# Pre-merge: PR #42 some title/);
  assert.match(md, /CAUTION/);
  assert.match(md, /## \[ok\] A check/);
  assert.match(md, /## \[warn\] B check/);
  assert.match(md, /Hint: b-hint/);
});

// ── allowsOverride ─────────────────────────────────────────────────

test('allowsOverride: caution -> true, blocked + ready -> false', () => {
  assert.equal(allowsOverride('caution'), true);
  assert.equal(allowsOverride('blocked'), false);
  assert.equal(allowsOverride('ready'), false);
});

// ── normaliseMergeStateStatus + normaliseMergeable ────────────────

test('normaliseMergeStateStatus: tolerates lowercase + unknown', () => {
  assert.equal(normaliseMergeStateStatus('clean'), 'CLEAN');
  assert.equal(normaliseMergeStateStatus('DIRTY'), 'DIRTY');
  assert.equal(normaliseMergeStateStatus(undefined), 'UNKNOWN');
  assert.equal(normaliseMergeStateStatus(''), 'UNKNOWN');
  assert.equal(normaliseMergeStateStatus('nonsense'), 'UNKNOWN');
});

test('normaliseMergeable: tolerates lowercase + null + unknown', () => {
  assert.equal(normaliseMergeable('MERGEABLE'), 'MERGEABLE');
  assert.equal(normaliseMergeable('mergeable'), 'MERGEABLE');
  assert.equal(normaliseMergeable('conflicting'), 'CONFLICTING');
  assert.equal(normaliseMergeable(null), 'UNKNOWN');
  assert.equal(normaliseMergeable('soon'), 'UNKNOWN');
});
