import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyPullError,
  suggestPrepullStashName,
  summarisePullBlock,
  pullBlockHeadline,
  summariseRecovery,
} from '../../src/git/stashOnPull';

// ── classifyPullError ─────────────────────────────────────────────

test('classifyPullError: empty / undefined input', () => {
  assert.equal(classifyPullError(''), undefined);
  assert.equal(classifyPullError('   '), undefined);
  assert.equal(classifyPullError(undefined as any), undefined);
});

test('classifyPullError: merge-local-changes with file list', () => {
  const stderr = [
    'error: Your local changes to the following files would be overwritten by merge:',
    '\tsrc/auth.ts',
    '\tsrc/index.ts',
    'Please commit your changes or stash them before you merge.',
    'Aborting',
  ].join('\n');
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'merge-local-changes');
  assert.deepEqual(b.files.sort(), ['src/auth.ts', 'src/index.ts']);
  assert.equal(b.autoStashable, true);
});

test('classifyPullError: rebase-local-changes (unstaged)', () => {
  const stderr = 'error: cannot pull with rebase: You have unstaged changes.';
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'rebase-local-changes');
  assert.deepEqual(b.files, []);
  assert.equal(b.autoStashable, true);
});

test('classifyPullError: rebase-local-changes (index dirty)', () => {
  const stderr = 'error: Cannot rebase: Your index contains uncommitted changes.';
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'rebase-local-changes');
  assert.equal(b.autoStashable, true);
});

test('classifyPullError: untracked overwrite is NOT auto-stashable', () => {
  const stderr = [
    'error: The following untracked working tree files would be overwritten by merge:',
    '\tnew-thing.ts',
    'Please move or remove them before you merge.',
    'Aborting',
  ].join('\n');
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'untracked-overwrite');
  assert.deepEqual(b.files, ['new-thing.ts']);
  assert.equal(b.autoStashable, false);
});

test('classifyPullError: merge-in-progress sentinel', () => {
  const stderr = 'error: You have not concluded your merge (MERGE_HEAD exists).';
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'merge-in-progress');
  assert.equal(b.autoStashable, false);
});

test('classifyPullError: rebase-in-progress sentinel', () => {
  const stderr = 'error: rebase in progress; cannot do that until it ends.';
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'rebase-in-progress');
  assert.equal(b.autoStashable, false);
});

test('classifyPullError: no-tracking branch', () => {
  const stderr = 'There is no tracking information for the current branch.';
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'no-tracking');
  assert.equal(b.autoStashable, false);
});

test('classifyPullError: unknown error -> other', () => {
  const b = classifyPullError('something exploded')!;
  assert.equal(b.reason, 'other');
  assert.equal(b.autoStashable, false);
});

test('classifyPullError: strips hint: prefixes from file list', () => {
  const stderr = [
    'error: Your local changes to the following files would be overwritten by merge:',
    '\tsrc/auth.ts',
    'hint: Use --rebase to apply your changes',
    'Please commit your changes or stash them before you merge.',
  ].join('\n');
  const b = classifyPullError(stderr)!;
  assert.equal(b.reason, 'merge-local-changes');
  assert.ok(!b.files.some(f => f.startsWith('hint:')));
  assert.deepEqual(b.files, ['src/auth.ts']);
});

// ── suggestPrepullStashName ───────────────────────────────────────

test('suggestPrepullStashName: branch + top-level dir', () => {
  const n = suggestPrepullStashName('feature/auth-refactor', ['src/auth/login.ts', 'src/auth/logout.ts', 'src/billing/index.ts']);
  assert.ok(n.startsWith('auth-refactor-auth-prepull'));
});

test('suggestPrepullStashName: branch only when no dirty', () => {
  const n = suggestPrepullStashName('main', []);
  assert.equal(n, 'main-prepull');
});

test('suggestPrepullStashName: dirty single file when no branch', () => {
  const n = suggestPrepullStashName('', ['hot.ts']);
  assert.equal(n, 'hot-prepull');
});

test('suggestPrepullStashName: empty branch and empty paths', () => {
  assert.equal(suggestPrepullStashName('', []), 'prepull');
});

test('suggestPrepullStashName: caps at 40 chars', () => {
  const longBranch = 'feature/' + 'x'.repeat(80);
  const n = suggestPrepullStashName(longBranch, ['src/a.ts']);
  assert.ok(n.length <= 40, `expected <=40 chars got ${n.length}: ${n}`);
});

test('suggestPrepullStashName: trims feat/fix prefix', () => {
  const n = suggestPrepullStashName('feat/login-bug', []);
  assert.equal(n, 'login-bug-prepull');
});

test('suggestPrepullStashName: skips src/lib/app when picking top dir', () => {
  const n = suggestPrepullStashName('main', ['src/auth/x.ts', 'src/auth/y.ts']);
  assert.equal(n, 'main-auth-prepull');
});

test('suggestPrepullStashName: handles paths under different roots', () => {
  // Mixed roots -- counts winner: src/billing wins over src/auth
  const n = suggestPrepullStashName('main', ['src/auth/a.ts', 'src/billing/a.ts', 'src/billing/b.ts']);
  assert.equal(n, 'main-billing-prepull');
});

// ── summarisePullBlock ────────────────────────────────────────────

test('summarisePullBlock: merge-local with file list', () => {
  const s = summarisePullBlock({ reason: 'merge-local-changes', files: ['a.ts', 'b.ts'], autoStashable: true });
  assert.ok(s.includes('2 tracked'));
  assert.ok(s.includes('a.ts'));
});

test('summarisePullBlock: merge-local respects maxShown cap', () => {
  const s = summarisePullBlock({ reason: 'merge-local-changes', files: ['a', 'b', 'c', 'd', 'e'], autoStashable: true }, 2);
  assert.ok(s.includes('+3'));
});

test('summarisePullBlock: rebase-local has no file list', () => {
  const s = summarisePullBlock({ reason: 'rebase-local-changes', files: [], autoStashable: true });
  assert.ok(s.includes('rebase'));
});

test('summarisePullBlock: untracked surfaces "cannot auto-stash"', () => {
  const s = summarisePullBlock({ reason: 'untracked-overwrite', files: ['n.ts'], autoStashable: false });
  assert.ok(s.includes('cannot auto-stash'));
});

test('summarisePullBlock: no-tracking suggests git branch -u', () => {
  const s = summarisePullBlock({ reason: 'no-tracking', files: [], autoStashable: false });
  assert.ok(s.includes('git branch -u'));
});

// ── pullBlockHeadline ─────────────────────────────────────────────

test('pullBlockHeadline: merge-local headline mentions file count', () => {
  const h = pullBlockHeadline({ reason: 'merge-local-changes', files: ['a', 'b'], autoStashable: true });
  assert.ok(h.includes('2 tracked files'));
});

test('pullBlockHeadline: rebase-local headline calls out --rebase', () => {
  const h = pullBlockHeadline({ reason: 'rebase-local-changes', files: [], autoStashable: true });
  assert.ok(h.includes('--rebase'));
});

test('pullBlockHeadline: every reason returns a non-empty string', () => {
  const reasons = ['merge-local-changes', 'rebase-local-changes', 'untracked-overwrite',
                   'merge-in-progress', 'rebase-in-progress', 'no-tracking', 'other'] as const;
  for (const r of reasons) {
    const h = pullBlockHeadline({ reason: r, files: [], autoStashable: false });
    assert.ok(h && h.length > 5, `empty headline for ${r}`);
  }
});

// ── summariseRecovery ─────────────────────────────────────────────

test('summariseRecovery: fully successful', () => {
  const s = summariseRecovery({
    steps: [{ step: 'stash', outcome: 'ok' }, { step: 'pull', outcome: 'ok' }, { step: 'pop', outcome: 'ok' }],
    stashRef: 'stash@{0}',
    fullySuccessful: true,
  });
  assert.ok(s.includes('clean'));
});

test('summariseRecovery: pop conflict surfaces stash ref', () => {
  const s = summariseRecovery({
    steps: [{ step: 'stash', outcome: 'ok' }, { step: 'pull', outcome: 'ok' }, { step: 'pop', outcome: 'conflict' }],
    stashRef: 'stash@{0}',
    fullySuccessful: false,
  });
  assert.ok(s.includes('conflict'));
  assert.ok(s.includes('stash@{0}'));
});

test('summariseRecovery: pull failure mid-flight', () => {
  const s = summariseRecovery({
    steps: [{ step: 'stash', outcome: 'ok' }, { step: 'pull', outcome: 'fail', detail: 'network' }],
    stashRef: 'stash@{0}',
    fullySuccessful: false,
  });
  assert.ok(s.toLowerCase().includes('failed'));
  assert.ok(s.includes('pull'));
  assert.ok(s.includes('stash@{0}'));
});

test('summariseRecovery: stash failure (no stash ref to mention)', () => {
  const s = summariseRecovery({
    steps: [{ step: 'stash', outcome: 'fail', detail: 'permission denied' }],
    fullySuccessful: false,
  });
  assert.ok(s.toLowerCase().includes('failed'));
  assert.ok(s.includes('stash'));
});
