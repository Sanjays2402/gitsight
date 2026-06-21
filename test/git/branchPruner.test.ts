import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildPruneCandidates,
  summarisePrune,
  describePrune,
  formatRowDetail,
  parseMergedBranches,
  PruneOptions,
} from '../../src/git/branchPruner';
import { Branch } from '../../src/git/git';

const now = new Date('2026-06-21T00:00:00Z');

function daysAgo(n: number): Date {
  return new Date(now.getTime() - n * 86400000);
}

function b(name: string, days: number, opts: Partial<Branch> = {}): Branch {
  return {
    name,
    current: false,
    ahead: 0, behind: 0, remote: false,
    sha: 'a'.repeat(40),
    lastDate: daysAgo(days),
    ...opts,
  };
}

// ── buildPruneCandidates ──────────────────────────────────────────

test('buildPruneCandidates: protected names are never deleteSafe', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(['main']), currentBranch: '' };
  const cands = buildPruneCandidates([b('main', 200)], opts, now);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].deleteSafe, false);
  assert.equal(cands[0].protectedReason, 'name');
});

test('buildPruneCandidates: merged + stale + non-protected → deleteSafe', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(['feature/x']), currentBranch: '' };
  const cands = buildPruneCandidates([b('feature/x', 90)], opts, now);
  assert.equal(cands[0].deleteSafe, true);
  assert.equal(cands[0].merged, true);
  assert.equal(cands[0].staleStatus, 'stale');
});

test('buildPruneCandidates: unmerged stale not deleteSafe by default', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(), currentBranch: '' };
  const cands = buildPruneCandidates([b('feature/x', 90)], opts, now);
  assert.equal(cands[0].deleteSafe, false);
});

test('buildPruneCandidates: includeUnmerged opt overrides', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(), currentBranch: '', includeUnmerged: true };
  const cands = buildPruneCandidates([b('feature/x', 90)], opts, now);
  assert.equal(cands[0].deleteSafe, true);
});

test('buildPruneCandidates: too young → not deleteSafe', () => {
  const opts: PruneOptions = { minAgeDays: 60, mergedInto: new Set(['feature/x']), currentBranch: '' };
  const cands = buildPruneCandidates([b('feature/x', 30)], opts, now);
  assert.equal(cands[0].deleteSafe, false);
});

test('buildPruneCandidates: current branch dropped', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(['feature/x']), currentBranch: 'feature/x' };
  const cands = buildPruneCandidates([b('feature/x', 90)], opts, now);
  assert.equal(cands.length, 0);
});

test('buildPruneCandidates: remote branches dropped', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(['origin/main']), currentBranch: '' };
  const cands = buildPruneCandidates([b('origin/main', 90, { remote: true })], opts, now);
  assert.equal(cands.length, 0);
});

test('buildPruneCandidates: extraProtected list honoured', () => {
  const opts: PruneOptions = {
    minAgeDays: 30,
    mergedInto: new Set(['feature/x']),
    currentBranch: '',
    extraProtected: ['feature/x'],
  };
  const cands = buildPruneCandidates([b('feature/x', 90)], opts, now);
  assert.equal(cands[0].deleteSafe, false);
  assert.equal(cands[0].protectedReason, 'extra');
});

test('buildPruneCandidates: sorts deleteSafe first by age (oldest top)', () => {
  const opts: PruneOptions = {
    minAgeDays: 30,
    mergedInto: new Set(['old', 'older', 'oldest']),
    currentBranch: '',
  };
  const cands = buildPruneCandidates(
    [b('old', 60), b('oldest', 200), b('older', 100)],
    opts,
    now,
  );
  assert.deepEqual(cands.map(c => c.branch.name), ['oldest', 'older', 'old']);
});

test('buildPruneCandidates: deleteSafe bucket comes before stale-unsafe', () => {
  const opts: PruneOptions = {
    minAgeDays: 30,
    mergedInto: new Set(['merged-stale']),
    currentBranch: '',
  };
  const cands = buildPruneCandidates(
    [b('unmerged-stale', 200), b('merged-stale', 100)],
    opts,
    now,
  );
  // merged-stale is deleteSafe; unmerged-stale is bucket 1.
  assert.equal(cands[0].branch.name, 'merged-stale');
  assert.equal(cands[1].branch.name, 'unmerged-stale');
});

test('buildPruneCandidates: fresh branches come last', () => {
  const opts: PruneOptions = {
    minAgeDays: 30,
    mergedInto: new Set(['fresh-merged', 'old-merged']),
    currentBranch: '',
  };
  const cands = buildPruneCandidates(
    [b('fresh-merged', 5), b('old-merged', 100)],
    opts,
    now,
  );
  assert.equal(cands[0].branch.name, 'old-merged');
  assert.equal(cands[1].branch.name, 'fresh-merged');
  assert.equal(cands[0].deleteSafe, true);
  assert.equal(cands[1].deleteSafe, false);
});

test('buildPruneCandidates: missing lastDate → Infinity age, ancient status', () => {
  const opts: PruneOptions = { minAgeDays: 30, mergedInto: new Set(['no-date']), currentBranch: '' };
  const cands = buildPruneCandidates([b('no-date', 0, { lastDate: undefined })], opts, now);
  assert.equal(cands[0].ageDays, Infinity);
  assert.equal(cands[0].staleStatus, 'ancient');
  assert.equal(cands[0].deleteSafe, true);
});

// ── summarisePrune ────────────────────────────────────────────────

test('summarisePrune: counts buckets correctly', () => {
  const cands = buildPruneCandidates(
    [
      b('a', 5),          // fresh, deleteSafe=false (young)
      b('b', 50),         // aging, deleteSafe=false (unmerged)
      b('c', 100),        // stale, deleteSafe=true (merged)
      b('main', 500),     // ancient, deleteSafe=false (protected)
    ],
    { minAgeDays: 30, mergedInto: new Set(['c', 'main']), currentBranch: '' },
    now,
  );
  const s = summarisePrune(cands);
  assert.equal(s.total, 4);
  assert.equal(s.deleteSafe, 1);
  assert.equal(s.protectedCount, 1);
  assert.equal(s.unmerged, 2); // a + b
  assert.equal(s.byStatus.fresh, 1);
  assert.equal(s.byStatus.aging, 1);
  assert.equal(s.byStatus.stale, 1);
  assert.equal(s.byStatus.ancient, 1);
});

// ── describePrune ────────────────────────────────────────────────

test('describePrune: includes pieces only when nonzero', () => {
  const s = { total: 5, deleteSafe: 2, protectedCount: 0, unmerged: 0, byStatus: { fresh: 0, aging: 0, stale: 5, ancient: 0 } };
  assert.equal(describePrune(s as any), '5 local branches · 2 safe to delete');
});

test('describePrune: omits unmerged/protected when zero', () => {
  const s = { total: 1, deleteSafe: 1, protectedCount: 1, unmerged: 1, byStatus: { fresh: 0, aging: 0, stale: 1, ancient: 0 } };
  assert.equal(describePrune(s as any), '1 local branch · 1 safe to delete · 1 unmerged · 1 protected');
});

// ── formatRowDetail ──────────────────────────────────────────────

test('formatRowDetail: stale unmerged', () => {
  const c = buildPruneCandidates(
    [b('x', 100)],
    { minAgeDays: 30, mergedInto: new Set(), currentBranch: '' },
    now,
  )[0];
  assert.equal(formatRowDetail(c), 'stale · 100d (unmerged)');
});

test('formatRowDetail: aging merged', () => {
  const c = buildPruneCandidates(
    [b('x', 31)],
    { minAgeDays: 10, mergedInto: new Set(['x']), currentBranch: '' },
    now,
  )[0];
  assert.equal(formatRowDetail(c), 'aging · 31d (merged)');
});

test('formatRowDetail: protected branch flagged', () => {
  const c = buildPruneCandidates(
    [b('main', 200)],
    { minAgeDays: 30, mergedInto: new Set(['main']), currentBranch: '' },
    now,
  )[0];
  assert.equal(formatRowDetail(c), 'stale · 200d (merged) · name-protected');
});

test('formatRowDetail: missing date → ?', () => {
  const c = buildPruneCandidates(
    [b('x', 0, { lastDate: undefined })],
    { minAgeDays: 30, mergedInto: new Set(['x']), currentBranch: '' },
    now,
  )[0];
  assert.equal(formatRowDetail(c), 'ancient · ? (merged)');
});

// ── parseMergedBranches ──────────────────────────────────────────

test('parseMergedBranches: strips leading flags', () => {
  const out = '* main\n  feature/x\n  feature/y\n+ worktree-branch';
  const set = parseMergedBranches(out);
  assert.equal(set.has('main'), true);
  assert.equal(set.has('feature/x'), true);
  assert.equal(set.has('feature/y'), true);
  assert.equal(set.has('worktree-branch'), true);
});

test('parseMergedBranches: skips detached HEAD note', () => {
  const out = '  (HEAD detached at abc1234)\n  main';
  const set = parseMergedBranches(out);
  assert.equal(set.size, 1);
  assert.equal(set.has('main'), true);
});

test('parseMergedBranches: empty input', () => {
  assert.equal(parseMergedBranches('').size, 0);
});
