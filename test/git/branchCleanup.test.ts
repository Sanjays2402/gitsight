import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseMergedBranches,
  classifyCleanupCandidates,
  isProtectedName,
} from '../../src/git/branchCleanup';

const branch = (over: any = {}) => ({
  name: 'x',
  current: false,
  remote: false,
  ahead: 0,
  behind: 0,
  sha: 'aaaaaaa',
  ...over,
});

test('parseMergedBranches: strips leading flags and ignores detached lines', () => {
  const out = [
    '* main',
    '  feature/a',
    '  feature/b',
    '+ stacked/c',
    '  (HEAD detached at v1.0.0)',
    '',
  ].join('\n');
  const got = parseMergedBranches(out);
  assert.deepEqual([...got].sort(), ['feature/a', 'feature/b', 'main', 'stacked/c']);
});

test('isProtectedName recognises common defaults', () => {
  for (const n of ['main', 'Master', 'TRUNK', 'develop', 'release', 'production', 'staging']) {
    assert.equal(isProtectedName(n), true, `${n} should be protected`);
  }
  assert.equal(isProtectedName('feature/foo'), false);
  assert.equal(isProtectedName(''), false);
});

test('classifyCleanupCandidates: excludes remotes and current branch', () => {
  const all = [
    branch({ name: 'main' }),
    branch({ name: 'feature/a' }),
    branch({ name: 'origin/feature/a', remote: true }),
    branch({ name: 'current', current: true }),
  ];
  const merged = new Set(['feature/a', 'main']);
  const got = classifyCleanupCandidates(all, merged, 'current');
  const names = got.map(c => c.branch.name);
  assert.ok(!names.includes('current'));
  assert.ok(!names.includes('origin/feature/a'));
  assert.ok(names.includes('feature/a'));
});

test('classifyCleanupCandidates: sorts safe-merged first, then protected, then unmerged', () => {
  const all = [
    branch({ name: 'feature/unmerged' }),
    branch({ name: 'main' }),
    branch({ name: 'feature/safe' }),
    branch({ name: 'release' }),
  ];
  const merged = new Set(['main', 'feature/safe', 'release']);
  const got = classifyCleanupCandidates(all, merged, 'develop');
  assert.deepEqual(
    got.map(c => c.branch.name),
    ['feature/safe', 'main', 'release', 'feature/unmerged'],
    'merged-safe → merged-protected → unmerged',
  );
});

test('classifyCleanupCandidates: marks protected names with a reason', () => {
  const all = [branch({ name: 'main' }), branch({ name: 'feature/x' })];
  const got = classifyCleanupCandidates(all, new Set(['main', 'feature/x']), 'dev');
  const main = got.find(c => c.branch.name === 'main')!;
  const feat = got.find(c => c.branch.name === 'feature/x')!;
  assert.equal(main.protectedReason, 'protected name');
  assert.equal(feat.protectedReason, undefined);
});

test('parseMergedBranches: empty input → empty set', () => {
  assert.equal(parseMergedBranches('').size, 0);
});
