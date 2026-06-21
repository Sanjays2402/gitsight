import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyCheckoutError, summariseBlock } from '../../src/git/autoStash';

const LOCAL_CHANGES_STDERR = [
  'error: Your local changes to the following files would be overwritten by checkout:',
  '\tsrc/auth.ts',
  '\tsrc/test.ts',
  'Please commit your changes or stash them before you switch branches.',
  'Aborting',
].join('\n');

test('classifyCheckoutError: recognises local-changes blocker', () => {
  const block = classifyCheckoutError(LOCAL_CHANGES_STDERR);
  assert.ok(block);
  assert.equal(block!.reason, 'local-changes');
  assert.equal(block!.autoStashable, true);
  assert.deepEqual(block!.files, ['src/auth.ts', 'src/test.ts']);
});

test('classifyCheckoutError: untracked is NOT auto-stashable', () => {
  const stderr = [
    'error: The following untracked working tree files would be overwritten by checkout:',
    '\tsrc/new.ts',
    'Please move or remove them before you switch branches.',
    'Aborting',
  ].join('\n');
  const block = classifyCheckoutError(stderr);
  assert.ok(block);
  assert.equal(block!.reason, 'untracked');
  assert.equal(block!.autoStashable, false);
  assert.deepEqual(block!.files, ['src/new.ts']);
});

test('classifyCheckoutError: rebase / merge in progress flagged as their reasons', () => {
  const rebase = classifyCheckoutError('error: cannot rebase: You have unstaged changes.\nrebase in progress; onto abc1234');
  assert.equal(rebase!.reason, 'rebase-in-progress');
  assert.equal(rebase!.autoStashable, false);

  const merge = classifyCheckoutError('error: merge in progress, cannot switch branches');
  assert.equal(merge!.reason, 'merge-in-progress');
});

test('classifyCheckoutError: empty stderr returns undefined', () => {
  assert.equal(classifyCheckoutError(''), undefined);
  assert.equal(classifyCheckoutError(undefined as any), undefined);
});

test('classifyCheckoutError: unrelated git errors land in "other"', () => {
  const block = classifyCheckoutError('error: pathspec did not match any file(s) known to git');
  assert.equal(block!.reason, 'other');
  assert.equal(block!.autoStashable, false);
});

test('classifyCheckoutError: handles the "switch" phrasing too', () => {
  const stderr = [
    'error: Your local changes to the following files would be overwritten by switch:',
    '\tREADME.md',
    'Please commit your changes or stash them before you switch branches.',
  ].join('\n');
  const block = classifyCheckoutError(stderr);
  assert.equal(block!.reason, 'local-changes');
  assert.deepEqual(block!.files, ['README.md']);
});

test('classifyCheckoutError: filters out hint: noise', () => {
  const stderr = [
    'error: Your local changes to the following files would be overwritten by checkout:',
    '\tsrc/auth.ts',
    'hint: Please commit your changes or stash them.',
    '\tsrc/test.ts',
    'Aborting',
  ].join('\n');
  const block = classifyCheckoutError(stderr);
  assert.deepEqual(block!.files, ['src/auth.ts', 'src/test.ts']);
});

test('summariseBlock: local-changes lists head files + count', () => {
  const block = classifyCheckoutError(LOCAL_CHANGES_STDERR)!;
  const out = summariseBlock(block);
  assert.ok(out.includes('2 tracked files'));
  assert.ok(out.includes('src/auth.ts'));
  assert.ok(out.includes('src/test.ts'));
});

test('summariseBlock: caps file list with +N suffix', () => {
  const block = {
    reason: 'local-changes' as const,
    files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    autoStashable: true,
  };
  const out = summariseBlock(block, 2);
  // Two head files + +3
  assert.ok(out.includes('a.ts'));
  assert.ok(out.includes('b.ts'));
  assert.ok(out.includes('+3'));
  assert.ok(!out.includes('c.ts'));
});

test('summariseBlock: untracked / merge / rebase / other have non-empty wording', () => {
  for (const reason of ['untracked', 'merge-in-progress', 'rebase-in-progress', 'other'] as const) {
    const out = summariseBlock({ reason, files: reason === 'untracked' ? ['x.ts'] : [], autoStashable: false });
    assert.ok(out.length > 0);
  }
});
