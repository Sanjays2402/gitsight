import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyEnqueue,
  classifyDequeue,
  buildEnqueueArgs,
  buildDequeueArgs,
  actionHeadline,
  formatVerdictHints,
  normaliseStrategy,
  PrSnapshot,
} from '../../src/git/mergeQueueActions';

function pr(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 42,
    title: 'feat: do the thing',
    baseRefName: 'main',
    headRepoSlug: 'me/repo',
    baseRepoSlug: 'me/repo',
    mergeStateStatus: 'CLEAN',
    alreadyQueued: false,
    autoMergeEnabled: false,
    baseBranchSupportsQueue: true,
    isDraft: false,
    ...overrides,
  };
}

test('classifyEnqueue: clean PR returns ok with no warnings', () => {
  const v = classifyEnqueue({ pr: pr(), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.deepEqual(v.warnings, []);
});

test('classifyEnqueue: draft PR is blocked', () => {
  const v = classifyEnqueue({ pr: pr({ isDraft: true }), strategy: 'merge' });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /draft/);
});

test('classifyEnqueue: cross-repo PR is blocked', () => {
  const v = classifyEnqueue({ pr: pr({ headRepoSlug: 'fork/repo' }), strategy: 'merge' });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /cross-repo/);
});

test('classifyEnqueue: already-queued PR returns noop', () => {
  const v = classifyEnqueue({ pr: pr({ alreadyQueued: true }), strategy: 'merge' });
  assert.equal(v.kind, 'noop');
  if (v.kind === 'noop') assert.match(v.reason, /already in the merge queue/);
});

test('classifyEnqueue: DIRTY merge state is blocked', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: 'DIRTY' }), strategy: 'merge' });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /conflicts/);
});

test('classifyEnqueue: BEHIND merge state is blocked with update hint', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: 'BEHIND' }), strategy: 'merge' });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /update branch/);
});

test('classifyEnqueue: BLOCKED state surfaces a warning but allows enqueue', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: 'BLOCKED' }), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') {
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /BLOCKED/);
  }
});

test('classifyEnqueue: HAS_HOOKS state surfaces a warning', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: 'HAS_HOOKS' }), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.match(v.warnings[0], /HAS_HOOKS/);
});

test('classifyEnqueue: UNSTABLE state surfaces a warning', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: 'UNSTABLE' }), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.match(v.warnings[0], /UNSTABLE/);
});

test('classifyEnqueue: UNKNOWN state surfaces a warning to verify', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: 'UNKNOWN' }), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.match(v.warnings[0], /unknown/i);
});

test('classifyEnqueue: empty mergeStateStatus also surfaces verify warning', () => {
  const v = classifyEnqueue({ pr: pr({ mergeStateStatus: '' }), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.match(v.warnings[0], /unknown/i);
});

test('classifyEnqueue: autoMerge already on surfaces replace-warning', () => {
  const v = classifyEnqueue({ pr: pr({ autoMergeEnabled: true }), strategy: 'merge' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') {
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /auto-merge/);
  }
});

test('classifyEnqueue: base branch without queue support is blocked', () => {
  const v = classifyEnqueue({ pr: pr({ baseBranchSupportsQueue: false }), strategy: 'merge' });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /merge queue enabled/);
});

test('classifyEnqueue: multiple warnings accumulate', () => {
  const v = classifyEnqueue({
    pr: pr({ mergeStateStatus: 'BLOCKED', autoMergeEnabled: true }),
    strategy: 'merge',
  });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.warnings.length, 2);
});

test('classifyDequeue: PR not in queue + no auto-merge is noop', () => {
  const v = classifyDequeue(pr());
  assert.equal(v.kind, 'noop');
});

test('classifyDequeue: in-queue PR is ok', () => {
  const v = classifyDequeue(pr({ alreadyQueued: true }));
  assert.equal(v.kind, 'ok');
});

test('classifyDequeue: auto-merge on but not queued still acts', () => {
  const v = classifyDequeue(pr({ autoMergeEnabled: true }));
  assert.equal(v.kind, 'ok');
});

test('classifyDequeue: cross-repo blocked', () => {
  const v = classifyDequeue(pr({ alreadyQueued: true, headRepoSlug: 'fork/repo' }));
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /cross-repo/);
});

test('buildEnqueueArgs: default strategy is --merge', () => {
  const args = buildEnqueueArgs({ pr: pr(), strategy: 'merge' });
  assert.deepEqual(args, ['pr', 'merge', '42', '--queue', '--merge']);
});

test('buildEnqueueArgs: squash strategy maps to --squash', () => {
  const args = buildEnqueueArgs({ pr: pr(), strategy: 'squash' });
  assert.deepEqual(args.slice(-2), ['--queue', '--squash']);
});

test('buildEnqueueArgs: rebase strategy maps to --rebase', () => {
  const args = buildEnqueueArgs({ pr: pr(), strategy: 'rebase' });
  assert.deepEqual(args.slice(-2), ['--queue', '--rebase']);
});

test('buildDequeueArgs: emits --disable-auto', () => {
  assert.deepEqual(buildDequeueArgs(pr()), ['pr', 'merge', '42', '--disable-auto']);
});

test('actionHeadline: dequeue ignores strategy', () => {
  assert.equal(actionHeadline('dequeue', pr(), 'squash'), 'Remove PR #42 from the merge queue?');
});

test('actionHeadline: enqueue merge omits strategy tag (default)', () => {
  assert.equal(actionHeadline('enqueue', pr(), 'merge'), 'Add PR #42 to the merge queue?');
});

test('actionHeadline: enqueue squash includes (squash) tag', () => {
  assert.equal(actionHeadline('enqueue', pr(), 'squash'), 'Add PR #42 to the merge queue (squash)?');
});

test('actionHeadline: enqueue rebase includes (rebase) tag', () => {
  assert.equal(actionHeadline('enqueue', pr(), 'rebase'), 'Add PR #42 to the merge queue (rebase)?');
});

test('formatVerdictHints: ok with no warnings renders sentinel', () => {
  assert.equal(formatVerdictHints({ kind: 'ok', warnings: [] }), '_No warnings._');
});

test('formatVerdictHints: ok with warnings renders bullet list', () => {
  const out = formatVerdictHints({ kind: 'ok', warnings: ['one', 'two'] });
  assert.equal(out, '- one\n- two');
});

test('formatVerdictHints: noop renders italics', () => {
  assert.equal(formatVerdictHints({ kind: 'noop', reason: 'already queued' }), '_already queued_');
});

test('formatVerdictHints: blocked renders bold prefix', () => {
  assert.equal(formatVerdictHints({ kind: 'blocked', reason: 'draft' }), '**Blocked:** draft');
});

test('normaliseStrategy: known strategies are passthrough (no coerce)', () => {
  for (const s of ['merge', 'squash', 'rebase']) {
    const out = normaliseStrategy(s);
    assert.equal(out.strategy, s);
    assert.equal(out.coerced, false);
  }
});

test('normaliseStrategy: case insensitivity (SQUASH -> squash)', () => {
  const out = normaliseStrategy('SQUASH');
  assert.equal(out.strategy, 'squash');
  assert.equal(out.coerced, false);
});

test('normaliseStrategy: unknown string falls back to merge with coerce flag', () => {
  const out = normaliseStrategy('mergerebase');
  assert.equal(out.strategy, 'merge');
  assert.equal(out.coerced, true);
});

test('normaliseStrategy: non-string input falls back to merge with coerce flag', () => {
  for (const bad of [undefined, null, 42, {}]) {
    const out = normaliseStrategy(bad);
    assert.equal(out.strategy, 'merge');
    assert.equal(out.coerced, true);
  }
});

test('normaliseStrategy: whitespace and case trimmed', () => {
  const out = normaliseStrategy('  Rebase ');
  assert.equal(out.strategy, 'rebase');
  assert.equal(out.coerced, false);
});
