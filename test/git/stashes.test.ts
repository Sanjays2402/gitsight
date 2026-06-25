import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  stashStatusFromCode,
  isValidStashIndex,
  stashRefForIndex,
  stashBranch,
  parseStashList,
  parseStashNumstat,
  parseStashNameStatus,
  buildStashFiles,
  stashSummary,
  STASH_LIST_FORMAT,
} from '../../src/shared/stashes';

const F = '\x1f';
const R = '\x1e';

// ── stashStatusFromCode ──────────────────────────────────────────────

test('stashStatusFromCode maps git letters', () => {
  assert.equal(stashStatusFromCode('A'), 'added');
  assert.equal(stashStatusFromCode('M'), 'modified');
  assert.equal(stashStatusFromCode('D'), 'deleted');
  assert.equal(stashStatusFromCode('R100'), 'renamed');
  assert.equal(stashStatusFromCode('C75'), 'copied');
  assert.equal(stashStatusFromCode('?'), 'unknown');
});

// ── index validation + ref construction (security gate) ──────────────

test('isValidStashIndex accepts non-negative integers in range', () => {
  assert.equal(isValidStashIndex(0), true);
  assert.equal(isValidStashIndex(42), true);
  assert.equal(isValidStashIndex(-1), false);
  assert.equal(isValidStashIndex(1.5), false);
  assert.equal(isValidStashIndex(99999), false);
  assert.equal(isValidStashIndex('0'), false);
  assert.equal(isValidStashIndex(NaN), false);
});

test('stashRefForIndex builds stash@{N} and rejects bad indices', () => {
  assert.equal(stashRefForIndex(0), 'stash@{0}');
  assert.equal(stashRefForIndex(7), 'stash@{7}');
  assert.throws(() => stashRefForIndex(-1), /invalid stash index/);
  assert.throws(() => stashRefForIndex(1.2), /invalid stash index/);
});

// ── stashBranch ──────────────────────────────────────────────────────

test('stashBranch parses the branch from WIP/On subjects', () => {
  assert.equal(stashBranch('WIP on main: 1a2b3c subject'), 'main');
  assert.equal(stashBranch('On feature/foo: custom message'), 'feature/foo');
  assert.equal(stashBranch('no recognised prefix'), '');
});

// ── parseStashList ───────────────────────────────────────────────────

test('parseStashList parses entries with index, ref, branch, date', () => {
  const stdout =
    ['stash@{0}', 'WIP on main: abc subject', '2026-06-20T09:00:00Z'].join(F) + R +
    ['stash@{1}', 'On feature: hand-named', '2026-06-19T09:00:00Z'].join(F) + R;
  const list = parseStashList(stdout);
  assert.equal(list.length, 2);
  assert.equal(list[0].index, 0);
  assert.equal(list[0].ref, 'stash@{0}');
  assert.equal(list[0].branch, 'main');
  assert.equal(list[1].index, 1);
  assert.equal(list[1].branch, 'feature');
});

test('parseStashList tolerates empty output', () => {
  assert.deepEqual(parseStashList(''), []);
  assert.deepEqual(parseStashList(R), []);
});

// ── numstat / name-status ────────────────────────────────────────────

test('parseStashNumstat reads counts, binary, and renames', () => {
  const stdout = `5\t2\tsrc/a.ts\0` + `-\t-\tlogo.png\0` + `3\t1\t\0old.ts\0new.ts\0`;
  const rows = parseStashNumstat(stdout);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].insertions, 5);
  assert.equal(rows[1].binary, true);
  assert.equal(rows[2].path, 'new.ts');
  assert.equal(rows[2].oldPath, 'old.ts');
});

test('parseStashNameStatus keys by destination path + handles renames', () => {
  const stdout = `M\0a.ts\0A\0new.ts\0R100\0old.ts\0moved.ts\0`;
  const map = parseStashNameStatus(stdout);
  assert.equal(map.get('a.ts')!.status, 'modified');
  assert.equal(map.get('new.ts')!.status, 'added');
  assert.equal(map.get('moved.ts')!.status, 'renamed');
  assert.equal(map.get('moved.ts')!.oldPath, 'old.ts');
});

// ── buildStashFiles ──────────────────────────────────────────────────

test('buildStashFiles correlates status + churn and sorts by churn desc', () => {
  const numstat = `1\t1\tsmall.ts\0` + `40\t10\tbig.ts\0`;
  const nameStatus = `M\0small.ts\0M\0big.ts\0`;
  const { files, insertions, deletions } = buildStashFiles(numstat, nameStatus);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'big.ts'); // 50 churn sorts first
  assert.equal(insertions, 41);
  assert.equal(deletions, 11);
});

test('buildStashFiles ignores binary churn in totals', () => {
  const { files, insertions } = buildStashFiles(`-\t-\tlogo.png\0` + `2\t0\ttext.txt\0`, `M\0logo.png\0A\0text.txt\0`);
  assert.equal(insertions, 2);
  assert.equal(files.find(f => f.path === 'logo.png')!.binary, true);
});

test('buildStashFiles falls back to numstat when name-status is empty', () => {
  const { files } = buildStashFiles(`3\t0\tonly.ts\0`, '');
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'only.ts');
  assert.equal(files[0].status, 'modified');
});

// ── stashSummary ─────────────────────────────────────────────────────

test('stashSummary pluralises + omits zero churn segments', () => {
  assert.equal(stashSummary({ filesChanged: 1, insertions: 5, deletions: 0 }), '1 file \u00b7 +5');
  assert.equal(stashSummary({ filesChanged: 3, insertions: 18, deletions: 4 }), '3 files \u00b7 +18 \u00b7 -4');
  assert.equal(stashSummary({ filesChanged: 0, insertions: 0, deletions: 0 }), '0 files');
});

test('STASH_LIST_FORMAT carries the three fields + record terminator', () => {
  assert.ok(STASH_LIST_FORMAT.includes('%gd'));
  assert.ok(STASH_LIST_FORMAT.includes('%gs'));
  assert.ok(STASH_LIST_FORMAT.endsWith('%x1e'));
});
