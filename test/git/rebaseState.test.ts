import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseRebaseState,
  parseConflictedFiles,
  shortRebaseLabel,
  describeRebase,
} from '../../src/git/rebaseState';

test('parseRebaseState: returns undefined when nothing is present', () => {
  assert.equal(parseRebaseState({}), undefined);
});

test('parseRebaseState: classic merge rebase populates current/total/branch', () => {
  const s = parseRebaseState({
    msgnum: '3\n',
    end: '7\n',
    'head-name': 'refs/heads/feature/x\n',
  });
  assert.ok(s);
  assert.equal(s!.kind, 'merge');
  assert.equal(s!.current, 3);
  assert.equal(s!.total, 7);
  assert.equal(s!.branch, 'feature/x');
  assert.equal(s!.currentSha, undefined);
});

test('parseRebaseState: interactive flag wins over merge classification', () => {
  const s = parseRebaseState({
    msgnum: '2',
    end: '5',
    interactive: '',
    'head-name': 'refs/heads/main',
    'stopped-sha': 'deadbeefcafe\n',
  });
  assert.equal(s!.kind, 'interactive');
  assert.equal(s!.currentSha, 'deadbeefcafe');
});

test('parseRebaseState: classic rebase-apply uses next/last', () => {
  const s = parseRebaseState({ next: '4', last: '9' });
  assert.equal(s!.kind, 'apply');
  assert.equal(s!.current, 4);
  assert.equal(s!.total, 9);
  assert.equal(s!.branch, undefined);
});

test('parseRebaseState: malformed numbers fall back to 0', () => {
  const s = parseRebaseState({ msgnum: 'xx', end: '', 'head-name': 'refs/heads/x' });
  assert.equal(s!.current, 0);
  assert.equal(s!.total, 0);
});

test('shortRebaseLabel: total known shows X/Y, unknown shows ?/?', () => {
  assert.equal(shortRebaseLabel({ kind: 'merge', current: 3, total: 7 }), 'rebase 3/7');
  assert.equal(shortRebaseLabel({ kind: 'interactive', current: 2, total: 5 }), 'rebase -i 2/5');
  assert.equal(shortRebaseLabel({ kind: 'apply', current: 0, total: 0 }), 'rebase ?/?');
});

test('parseConflictedFiles: detects U-prefixed and AA/DD states', () => {
  const porcelain = [
    'UU src/git/git.ts',
    'AU test/conflict.test.ts',
    'AA both_added.txt',
    'DD both_deleted.txt',
    ' M not_a_conflict.ts',
    '?? new_file.md',
    '',
  ].join('\n');
  const files = parseConflictedFiles(porcelain);
  assert.deepEqual(files, [
    'src/git/git.ts',
    'test/conflict.test.ts',
    'both_added.txt',
    'both_deleted.txt',
  ]);
});

test('parseConflictedFiles: empty input is empty array', () => {
  assert.deepEqual(parseConflictedFiles(''), []);
});

test('describeRebase: composes a clean human sentence', () => {
  const sentence = describeRebase(
    { kind: 'interactive', current: 3, total: 7, branch: 'feature/x' },
    2,
  );
  assert.match(sentence, /Interactive rebase in progress, step 3 of 7, 2 conflicted files \(was on feature\/x\)\./);
});

test('describeRebase: 0 conflicts and unknown total render politely', () => {
  const sentence = describeRebase({ kind: 'merge', current: 0, total: 0 }, 0);
  assert.match(sentence, /Rebase in progress, step \?, no conflicts\./);
});
