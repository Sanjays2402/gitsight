import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildWorktreePruneCandidates,
  summariseWorktreePrune,
  describeWorktreePrune,
  formatRowDetail,
  buildRemoveCommand,
} from '../../src/git/worktreePruner';
import { Worktree } from '../../src/git/git';

function wt(over: Partial<Worktree>): Worktree {
  return {
    path: '/repos/x',
    branch: 'feature/x',
    head: 'a'.repeat(40),
    bare: false,
    detached: false,
    locked: false,
    ...over,
  };
}

test('buildWorktreePruneCandidates: missing-on-disk is highest priority', () => {
  const wts = [
    wt({ path: '/repos/main', branch: 'main' }),
    wt({ path: '/repos/gone', branch: 'feature/gone' }),
  ];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(['main', 'feature/gone']),
    minAgeDays: 7,
    existsOnDisk: w => w.path === '/repos/main',
    ageDaysFor: () => 30,
  });
  assert.equal(out[0].worktree.path, '/repos/gone');
  assert.equal(out[0].pruneSafe, true);
  assert.deepEqual(out[0].reasons, ['missing-on-disk']);
});

test('buildWorktreePruneCandidates: upstream-gone branches flagged', () => {
  const wts = [
    wt({ path: '/repos/has-upstream', branch: 'feature/keep' }),
    wt({ path: '/repos/no-upstream', branch: 'feature/dead' }),
  ];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(['feature/keep']),
    minAgeDays: 7,
    existsOnDisk: () => true,
    ageDaysFor: () => 30,
  });
  const dead = out.find(o => o.worktree.path === '/repos/no-upstream');
  assert.ok(dead);
  assert.equal(dead!.branchUpstreamGone, true);
  assert.equal(dead!.pruneSafe, true);
  assert.ok(dead!.reasons.includes('upstream-gone'));
  const keep = out.find(o => o.worktree.path === '/repos/has-upstream');
  assert.equal(keep!.pruneSafe, false);
  assert.equal(keep!.protectedReason, 'no-signal');
});

test('buildWorktreePruneCandidates: current worktree is protected', () => {
  const wts = [wt({ path: '/repos/main', branch: 'feature/dead' })];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(),
    minAgeDays: 7,
    existsOnDisk: () => true,
    ageDaysFor: () => 200,
  });
  assert.equal(out[0].protectedReason, 'current');
  assert.equal(out[0].pruneSafe, false);
});

test('buildWorktreePruneCandidates: locked worktree never offered', () => {
  const wts = [wt({ path: '/repos/locked', branch: 'feature/dead', locked: true })];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(),
    minAgeDays: 7,
    existsOnDisk: () => true,
    ageDaysFor: () => 200,
  });
  assert.equal(out[0].protectedReason, 'locked');
  assert.equal(out[0].pruneSafe, false);
});

test('buildWorktreePruneCandidates: too-young entries protected unless missing-on-disk', () => {
  const wts = [
    wt({ path: '/repos/young', branch: 'feature/dead' }),
    wt({ path: '/repos/gone-young', branch: 'feature/dead2' }),
  ];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(),
    minAgeDays: 30,
    existsOnDisk: w => w.path === '/repos/young', // gone-young is missing on disk
    ageDaysFor: () => 5,
  });
  const young = out.find(o => o.worktree.path === '/repos/young');
  const gone = out.find(o => o.worktree.path === '/repos/gone-young');
  assert.equal(young!.protectedReason, 'too-young');
  assert.equal(young!.pruneSafe, false);
  // Missing-on-disk bypasses the age guard — there's nothing to read mtime from anyway.
  assert.equal(gone!.pruneSafe, true);
});

test('buildWorktreePruneCandidates: includeStaleOnly opt-in surfaces stale entries', () => {
  const wts = [wt({ path: '/repos/stale', branch: 'feature/alive' })];
  const off = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(['feature/alive']),
    minAgeDays: 30,
    existsOnDisk: () => true,
    ageDaysFor: () => 100,
  });
  const on = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(['feature/alive']),
    minAgeDays: 30,
    includeStaleOnly: true,
    existsOnDisk: () => true,
    ageDaysFor: () => 100,
  });
  assert.equal(off[0].pruneSafe, false);
  assert.equal(off[0].protectedReason, 'no-signal');
  assert.equal(on[0].pruneSafe, true);
  assert.deepEqual(on[0].reasons, ['stale-only']);
});

test('buildWorktreePruneCandidates: isMain hook protects the main worktree', () => {
  const wts = [wt({ path: '/repos/main', branch: 'feature/dead' })];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/other',
    branchesWithUpstream: new Set(),
    minAgeDays: 7,
    existsOnDisk: () => true,
    ageDaysFor: () => 200,
    isMain: w => w.path === '/repos/main',
  });
  assert.equal(out[0].protectedReason, 'main');
});

test('buildWorktreePruneCandidates: ordering puts missing > upstream-gone > rest', () => {
  const wts = [
    wt({ path: '/repos/upstream', branch: 'feature/dead' }),
    wt({ path: '/repos/missing', branch: 'feature/dead2' }),
    wt({ path: '/repos/healthy', branch: 'main' }),
  ];
  const out = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/healthy',
    branchesWithUpstream: new Set(['main']),
    minAgeDays: 7,
    existsOnDisk: w => w.path !== '/repos/missing',
    ageDaysFor: () => 60,
  });
  assert.equal(out[0].worktree.path, '/repos/missing');
  assert.equal(out[1].worktree.path, '/repos/upstream');
  assert.equal(out[2].worktree.path, '/repos/healthy');
});

test('summariseWorktreePrune: counts by bucket', () => {
  const c = buildWorktreePruneCandidates(
    [
      wt({ path: '/a', branch: 'f1' }),
      wt({ path: '/b', branch: 'f2' }),
      wt({ path: '/c', branch: 'main' }),
    ],
    {
      currentWorktreePath: '/c',
      branchesWithUpstream: new Set(['main']),
      minAgeDays: 7,
      existsOnDisk: w => w.path !== '/a',
      ageDaysFor: () => 30,
    },
  );
  const s = summariseWorktreePrune(c);
  assert.equal(s.total, 3);
  assert.equal(s.pruneSafe, 2);
  assert.equal(s.missingOnDisk, 1);
  // /a has BOTH missing-on-disk AND upstream-gone reasons; /b has upstream-gone.
  // The summary counts each reason independently, so both increment upstreamGone.
  assert.equal(s.upstreamGone, 2);
  assert.equal(s.protectedCount, 1);
});

test('describeWorktreePrune: builds title bits', () => {
  const summary = {
    total: 4, pruneSafe: 2, missingOnDisk: 1, upstreamGone: 1, staleOnly: 0, protectedCount: 2,
  };
  const t = describeWorktreePrune(summary);
  assert.match(t, /4 worktrees/);
  assert.match(t, /2 safe to remove/);
  assert.match(t, /1 missing/);
  assert.match(t, /1 upstream gone/);
});

test('formatRowDetail: missing entry shows on-disk status', () => {
  const c = buildWorktreePruneCandidates(
    [wt({ path: '/a', branch: 'feature/dead' })],
    {
      currentWorktreePath: '/c',
      branchesWithUpstream: new Set(),
      minAgeDays: 7,
      existsOnDisk: () => false,
      ageDaysFor: () => Infinity,
    },
  );
  const d = formatRowDetail(c[0]);
  assert.match(d, /missing on disk/);
  assert.match(d, /upstream gone/);
  assert.match(d, /branch=feature\/dead/);
});

test('formatRowDetail: present entry shows age', () => {
  const c = buildWorktreePruneCandidates(
    [wt({ path: '/a', branch: 'feature/dead' })],
    {
      currentWorktreePath: '/c',
      branchesWithUpstream: new Set(),
      minAgeDays: 7,
      existsOnDisk: () => true,
      ageDaysFor: () => 42,
    },
  );
  const d = formatRowDetail(c[0]);
  assert.match(d, /42d old/);
});

test('buildRemoveCommand: missing-on-disk uses prune; present uses remove', () => {
  const wts = [wt({ path: '/repos/gone', branch: 'feature/dead' })];
  const candidates = buildWorktreePruneCandidates(wts, {
    currentWorktreePath: '/repos/main',
    branchesWithUpstream: new Set(),
    minAgeDays: 7,
    existsOnDisk: () => false,
    ageDaysFor: () => Infinity,
  });
  assert.deepEqual(buildRemoveCommand(candidates[0]), ['worktree', 'prune']);

  const present = buildWorktreePruneCandidates(
    [wt({ path: '/repos/x', branch: 'feature/dead' })],
    {
      currentWorktreePath: '/repos/main',
      branchesWithUpstream: new Set(),
      minAgeDays: 7,
      existsOnDisk: () => true,
      ageDaysFor: () => 30,
    },
  );
  assert.deepEqual(buildRemoveCommand(present[0]), ['worktree', 'remove', '/repos/x']);
});
