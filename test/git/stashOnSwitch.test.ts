import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  matchStashesForBranch,
  classifyStashAge,
  glyphForAge,
  describeStashMatch,
  describeToastHeadline,
} from '../../src/git/stashOnSwitch';
import { Stash } from '../../src/git/git';

function stash(opts: { index: number; subject: string; ageDays?: number; branch?: string }): Stash {
  const now = new Date('2026-06-21T22:00:00Z');
  const date = opts.ageDays == null ? new Date(NaN) : new Date(now.getTime() - opts.ageDays * 86_400_000);
  return {
    index: opts.index,
    ref: `stash@{${opts.index}}`,
    subject: opts.subject,
    branch: opts.branch ?? '',
    date,
  };
}

const now = () => new Date('2026-06-21T22:00:00Z');

test('matchStashesForBranch returns only stashes from the target branch, newest-first by index', () => {
  const stashes = [
    stash({ index: 0, subject: 'WIP on feature/x: 3a97b28 work in progress', ageDays: 1 }),
    stash({ index: 1, subject: 'WIP on main: aaaaaaa other work', ageDays: 2 }),
    stash({ index: 2, subject: 'On feature/x: a typed message', ageDays: 5 }),
    stash({ index: 3, subject: 'WIP on (no branch): detached work', ageDays: 3 }),
  ];
  const matches = matchStashesForBranch(stashes, 'feature/x', { now });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].index, 0);
  assert.equal(matches[1].index, 2);
});

test('matchStashesForBranch normalises origin/ and refs/heads/ prefixes', () => {
  const stashes = [
    stash({ index: 0, subject: 'WIP on feature/x: aaa hello', ageDays: 0 }),
  ];
  assert.equal(matchStashesForBranch(stashes, 'origin/feature/x', { now }).length, 1);
  assert.equal(matchStashesForBranch(stashes, 'refs/heads/feature/x', { now }).length, 1);
  assert.equal(matchStashesForBranch(stashes, 'Feature/X', { now }).length, 1, 'case-insensitive');
});

test('matchStashesForBranch returns empty when branch is unset', () => {
  const stashes = [
    stash({ index: 0, subject: 'WIP on feature/x: aaa hello', ageDays: 0 }),
  ];
  assert.deepEqual(matchStashesForBranch(stashes, '', { now }), []);
});

test('matchStashesForBranch attaches clean subject + age + isNamed', () => {
  const stashes = [
    stash({ index: 0, subject: 'WIP on feature/x: 3a97b28 fixing the thing', ageDays: 1 }),
    stash({ index: 1, subject: 'On feature/x: hand-written stash name', ageDays: 7 }),
  ];
  const matches = matchStashesForBranch(stashes, 'feature/x', { now });
  assert.equal(matches[0].cleanSubject, 'fixing the thing');
  assert.equal(matches[0].isNamed, false);
  assert.equal(matches[0].age, 'fresh');
  assert.equal(matches[0].ageDays, 1);
  assert.equal(matches[1].cleanSubject, 'hand-written stash name');
  assert.equal(matches[1].isNamed, true);
  assert.equal(matches[1].age, 'aging');
});

test('matchStashesForBranch falls back to Stash.branch when subject lacks a branch', () => {
  const stashes = [
    stash({ index: 0, subject: 'opaque subject without prefix', branch: 'feature/x', ageDays: 1 }),
  ];
  const matches = matchStashesForBranch(stashes, 'feature/x', { now });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].branch, 'feature/x');
});

test('matchStashesForBranch tolerates undefined dates', () => {
  const stashes: Stash[] = [{ index: 0, ref: 'stash@{0}', subject: 'WIP on feature/x: aaa', branch: '', date: new Date(NaN) }];
  const matches = matchStashesForBranch(stashes, 'feature/x', { now });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ageDays, undefined);
  assert.equal(matches[0].age, 'aging');
});

test('classifyStashAge tiers respect thresholds', () => {
  assert.equal(classifyStashAge(0, 3, 14), 'fresh');
  assert.equal(classifyStashAge(3, 3, 14), 'fresh');
  assert.equal(classifyStashAge(4, 3, 14), 'aging');
  assert.equal(classifyStashAge(14, 3, 14), 'aging');
  assert.equal(classifyStashAge(15, 3, 14), 'old');
  assert.equal(classifyStashAge(undefined, 3, 14), 'aging');
});

test('glyphForAge returns stable codicon names', () => {
  assert.equal(glyphForAge('fresh'), 'sparkle');
  assert.equal(glyphForAge('aging'), 'archive');
  assert.equal(glyphForAge('old'),   'history');
});

test('describeStashMatch produces a stable single-line description', () => {
  const m = {
    index: 0,
    ref: 'stash@{0}',
    cleanSubject: 'fix',
    branch: 'feature/x',
    date: new Date(),
    ageDays: 1,
    age: 'fresh' as const,
    isNamed: false,
  };
  const desc = describeStashMatch(m);
  assert.ok(desc.includes('stash@{0}'));
  assert.ok(desc.includes('1 day ago'));
  assert.ok(desc.includes('WIP'));
});

test('describeStashMatch handles today, multi-day, and unknown ages', () => {
  const base = {
    index: 0, ref: 'stash@{0}', cleanSubject: 'x', branch: 'b', date: new Date(),
    age: 'fresh' as const, isNamed: true,
  };
  assert.ok(describeStashMatch({ ...base, ageDays: 0 }).includes('today'));
  assert.ok(describeStashMatch({ ...base, ageDays: 5 }).includes('5 days ago'));
  assert.ok(describeStashMatch({ ...base, ageDays: undefined }).includes('unknown age'));
});

test('describeToastHeadline formats plural correctly', () => {
  const one = [{
    index: 0, ref: 's', cleanSubject: 'c', branch: 'b', date: new Date(),
    ageDays: 0, age: 'fresh' as const, isNamed: false,
  }];
  const two = [one[0], { ...one[0], index: 1, ref: 's1' }];
  assert.ok(describeToastHeadline(one, 'feature/x').includes('1 stash'));
  assert.ok(describeToastHeadline(two, 'feature/x').includes('2 stashes'));
  assert.ok(describeToastHeadline([], 'feature/x').startsWith('No stashes'));
});
