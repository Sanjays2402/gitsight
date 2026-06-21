import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  cleanStashSubject,
  isNamedStash,
  extractStashBranch,
  sortStashesForPicker,
  describeStash,
} from '../../src/git/stashSort';

test('cleanStashSubject: strips WIP prefix + sha', () => {
  assert.equal(
    cleanStashSubject('WIP on feature/x: 3a97b28 add coach pill'),
    'add coach pill',
  );
});

test('cleanStashSubject: keeps named-stash message after On <branch>:', () => {
  assert.equal(
    cleanStashSubject('On main: refactor commit graph'),
    'refactor commit graph',
  );
});

test('cleanStashSubject: tolerates "(no branch)" (detached HEAD)', () => {
  assert.equal(
    cleanStashSubject('WIP on (no branch): abcdef1 oops'),
    'oops',
  );
});

test('cleanStashSubject: returns input verbatim when it does not match either form', () => {
  assert.equal(cleanStashSubject('something else entirely'), 'something else entirely');
});

test('isNamedStash: true only for "On <branch>:" form', () => {
  assert.equal(isNamedStash('On main: real message'), true);
  assert.equal(isNamedStash('WIP on main: 1234567 wip'), false);
  assert.equal(isNamedStash('nothing'), false);
});

test('extractStashBranch: pulls branch from both forms', () => {
  assert.equal(extractStashBranch('WIP on feature/x: 1234567 wip'), 'feature/x');
  assert.equal(extractStashBranch('On main: message'), 'main');
  assert.equal(extractStashBranch('WIP on (no branch): a b c'), undefined);
  assert.equal(extractStashBranch('not a stash subject'), undefined);
});

test('sortStashesForPicker: newest-first by date', () => {
  const stashes = [
    { index: 0, ref: 'stash@{0}', subject: 'WIP on main: a 1', branch: 'main', date: new Date('2024-01-01') },
    { index: 1, ref: 'stash@{1}', subject: 'WIP on main: b 2', branch: 'main', date: new Date('2024-06-01') },
    { index: 2, ref: 'stash@{2}', subject: 'WIP on main: c 3', branch: 'main', date: new Date('2023-12-01') },
  ];
  const sorted = sortStashesForPicker(stashes as any).map(s => s.index);
  assert.deepEqual(sorted, [1, 0, 2]);
});

test('sortStashesForPicker: same date → named beats unnamed', () => {
  const d = new Date('2024-05-01');
  const stashes = [
    { index: 0, ref: 'stash@{0}', subject: 'WIP on main: aaaaaaa wip', branch: 'main', date: d },
    { index: 1, ref: 'stash@{1}', subject: 'On main: a named message', branch: 'main', date: d },
  ];
  const sorted = sortStashesForPicker(stashes as any).map(s => s.index);
  assert.deepEqual(sorted, [1, 0]);
});

test('sortStashesForPicker: same date + both named → lower index wins', () => {
  const d = new Date('2024-05-01');
  const stashes = [
    { index: 5, ref: 'stash@{5}', subject: 'On main: msg b', branch: 'main', date: d },
    { index: 2, ref: 'stash@{2}', subject: 'On main: msg a', branch: 'main', date: d },
  ];
  const sorted = sortStashesForPicker(stashes as any).map(s => s.index);
  assert.deepEqual(sorted, [2, 5]);
});

test('describeStash: surfaces branch + ISO date + isNamed flag', () => {
  const d = describeStash({
    index: 0, ref: 'stash@{0}',
    subject: 'On feature/x: typed message', branch: 'feature/x',
    date: new Date('2024-08-09T10:11:12Z'),
  } as any);
  assert.equal(d.branch, 'feature/x');
  assert.equal(d.date, '2024-08-09');
  assert.equal(d.isNamed, true);
});

test('describeStash: undefined date when missing', () => {
  const d = describeStash({
    index: 0, ref: 'stash@{0}',
    subject: 'WIP on main: 1234567 x', branch: 'main',
    date: new Date(NaN),
  } as any);
  assert.equal(d.date, undefined);
  assert.equal(d.branch, 'main');
  assert.equal(d.isNamed, false);
});
