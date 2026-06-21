import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStashCandidates,
  ageDays,
  summariseStashTrash,
  describeStashTrash,
  formatStashRow,
} from '../../src/git/stashTrash';

const NOW = new Date('2026-06-21T00:00:00Z');

function makeStash(overrides: Partial<{ index: number; subject: string; date: Date; branch: string }> = {}): any {
  return {
    index: overrides.index ?? 0,
    ref: `stash@{${overrides.index ?? 0}}`,
    subject: overrides.subject ?? 'WIP on main: 1234567 something',
    branch: overrides.branch ?? 'main',
    date: overrides.date ?? NOW,
  };
}

test('ageDays: integer days difference', () => {
  assert.equal(ageDays(new Date('2026-06-20T00:00:00Z'), NOW), 1);
  assert.equal(ageDays(new Date('2026-06-21T12:00:00Z'), NOW), 0); // future = 0
  assert.equal(ageDays(new Date('2025-06-21T00:00:00Z'), NOW), 365);
});

test('ageDays: bad date returns Infinity', () => {
  assert.equal(ageDays(undefined, NOW), Infinity);
  assert.equal(ageDays(new Date('not a date'), NOW), Infinity);
});

test('buildStashCandidates: ancient stash always dropSafe regardless of branch', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on main: a wip',
      date: new Date('2025-12-01T00:00:00Z') }), // ~202d
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main']), // even though branch is alive
  }, NOW);
  assert.equal(out[0].ageBucket, 'ancient');
  assert.equal(out[0].dropSafe, true);
  assert.equal(out[0].sourceBranch, 'main');
  assert.equal(out[0].sourceBranchGone, false);
});

test('buildStashCandidates: stale + branch gone = dropSafe', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on feature/x: a wip',
      date: new Date('2026-04-01T00:00:00Z') }), // ~80d
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main']), // feature/x is gone
  }, NOW);
  assert.equal(out[0].ageBucket, 'stale');
  assert.equal(out[0].sourceBranchGone, true);
  assert.equal(out[0].dropSafe, true);
});

test('buildStashCandidates: stale + branch alive = review (NOT dropSafe)', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on feature/x: a wip',
      date: new Date('2026-04-01T00:00:00Z') }), // ~80d
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main', 'feature/x']),
  }, NOW);
  assert.equal(out[0].ageBucket, 'stale');
  assert.equal(out[0].sourceBranchGone, false);
  assert.equal(out[0].dropSafe, false);
});

test('buildStashCandidates: fresh stash never dropSafe even if branch is gone', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on gone-yesterday: a wip',
      date: new Date('2026-06-10T00:00:00Z') }), // ~11d
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main']),
  }, NOW);
  assert.equal(out[0].ageBucket, 'fresh');
  assert.equal(out[0].sourceBranchGone, true);
  assert.equal(out[0].dropSafe, false);
});

test('buildStashCandidates: detached-HEAD stash has no source branch, never gone', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on (no branch): abcdef 1234 oops',
      branch: '', // detached
      date: new Date('2026-04-01T00:00:00Z') }),
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main']),
  }, NOW);
  assert.equal(out[0].sourceBranch, undefined);
  assert.equal(out[0].sourceBranchGone, false);
  // Stale but branch isn't known-gone, so not dropSafe.
  assert.equal(out[0].dropSafe, false);
});

test('buildStashCandidates: extraLiveBranches union with liveBranches', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on release/v1: x',
      date: new Date('2026-04-01T00:00:00Z') }),
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main']),
    extraLiveBranches: ['release/v1'],
  }, NOW);
  assert.equal(out[0].sourceBranchGone, false);
  assert.equal(out[0].dropSafe, false);
});

test('buildStashCandidates: ordering — dropSafe first, then review, then fresh', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on main: fresh', date: new Date('2026-06-19T00:00:00Z') }), // fresh
    makeStash({ index: 1, subject: 'WIP on gone: stale', date: new Date('2026-04-01T00:00:00Z') }), // dropSafe
    makeStash({ index: 2, subject: 'WIP on main: stale-alive', date: new Date('2026-04-01T00:00:00Z') }), // stale review
    makeStash({ index: 3, subject: 'WIP on main: ancient', date: new Date('2025-10-01T00:00:00Z') }), // dropSafe ancient
  ];
  const out = buildStashCandidates(stashes, {
    staleAfterDays: 60,
    ancientAfterDays: 180,
    liveBranches: new Set(['main']),
  }, NOW);
  // dropSafe order (oldest first): index 3 (~263d ancient) then index 1 (~81d stale-gone),
  // then stale-alive index 2, then fresh index 0.
  assert.deepEqual(out.map(c => c.stash.index), [3, 1, 2, 0]);
});

test('summariseStashTrash: counts per bucket', () => {
  const stashes = [
    makeStash({ index: 0, subject: 'WIP on main: fresh', date: new Date('2026-06-19T00:00:00Z') }),
    makeStash({ index: 1, subject: 'WIP on gone: stale', date: new Date('2026-04-01T00:00:00Z') }),
    makeStash({ index: 2, subject: 'WIP on main: ancient', date: new Date('2025-10-01T00:00:00Z') }),
  ];
  const c = buildStashCandidates(stashes, {
    staleAfterDays: 60, ancientAfterDays: 180,
    liveBranches: new Set(['main']),
  }, NOW);
  const s = summariseStashTrash(c);
  assert.equal(s.total, 3);
  assert.equal(s.fresh, 1);
  assert.equal(s.stale, 1);
  assert.equal(s.ancient, 1);
  assert.equal(s.dropSafe, 2); // ancient + stale-gone
  assert.equal(s.sourceBranchGone, 1);
});

test('describeStashTrash: pluralisation + ordering', () => {
  const s = describeStashTrash({ total: 1, dropSafe: 1, fresh: 0, stale: 0, ancient: 1, sourceBranchGone: 0 });
  assert.match(s, /1 stash/);
  assert.match(s, /1 safe to drop/);
  assert.match(s, /1 ancient/);
});

test('formatStashRow: includes age + branch-gone marker', () => {
  const row = formatStashRow({
    stash: makeStash({ index: 0, subject: 'WIP on gone: x', date: new Date('2026-04-01T00:00:00Z') }),
    ageDays: 81, ageBucket: 'stale', sourceBranch: 'gone',
    sourceBranchGone: true, cleanSubject: 'x', named: false, dropSafe: true,
  });
  assert.match(row, /stale/);
  assert.match(row, /81d/);
  assert.match(row, /branch gone/);
});

test('formatStashRow: includes named marker for named stashes', () => {
  const row = formatStashRow({
    stash: makeStash({ index: 0, subject: 'On main: a typed message', date: NOW }),
    ageDays: 0, ageBucket: 'fresh', sourceBranch: 'main',
    sourceBranchGone: false, cleanSubject: 'a typed message', named: true, dropSafe: false,
  });
  assert.match(row, /named/);
  assert.match(row, /on main/);
});

test('formatStashRow: handles missing date with ?', () => {
  const row = formatStashRow({
    stash: makeStash({ index: 0 }),
    ageDays: Infinity, ageBucket: 'fresh', sourceBranchGone: false,
    cleanSubject: 'x', named: false, dropSafe: false,
  });
  assert.match(row, /\?/);
});
