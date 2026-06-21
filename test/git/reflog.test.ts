import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReflog,
  filterReflog,
  summariseReflog,
  glyphForKind,
  isHeadMove,
  FILTER_KIND_ORDER,
} from '../../src/git/reflog';

const FIXTURE = [
  'a1b2c3d HEAD@{2026-06-21T10:00:00-07:00}: commit: fix(parser): handle empty input',
  'b2c3d4e HEAD@{2026-06-21T09:30:00-07:00}: commit (amend): fix(parser): handle empty input cleaner',
  'c3d4e5f HEAD@{2026-06-21T09:00:00-07:00}: reset: moving to HEAD~3',
  'd4e5f60 HEAD@{2026-06-21T08:30:00-07:00}: rebase -i (start): checkout origin/main',
  'e5f6071 HEAD@{2026-06-21T08:25:00-07:00}: rebase -i (pick): a1b2c3d fix(parser)',
  'f607182 HEAD@{2026-06-21T08:20:00-07:00}: rebase -i (finish): returning to refs/heads/feature-x',
  '0718293 HEAD@{2026-06-21T08:00:00-07:00}: merge develop: Fast-forward',
  '17182a4 HEAD@{2026-06-21T07:45:00-07:00}: cherry-pick: abcdef0 chore(release): tag v1.2.3',
  '8293ab5 HEAD@{2026-06-21T07:30:00-07:00}: revert: feat(foo): regretted thing',
  '93abcd6 HEAD@{2026-06-21T07:00:00-07:00}: pull --rebase: Fast-forward',
  'abcde7f HEAD@{2026-06-21T06:00:00-07:00}: checkout: moving from main to feature-x',
  'bcdef80 HEAD@{2026-06-21T05:00:00-07:00}: clone: from https://github.com/example/example.git',
  'cdef801 HEAD@{2026-06-21T04:30:00-07:00}: something exotic happened',
].join('\n');

test('parseReflog: extracts shape (sha, dateIso, action, kind, summary, index)', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out.length, 13);
  assert.equal(out[0].sha, 'a1b2c3d');
  assert.equal(out[0].dateIso, '2026-06-21T10:00:00-07:00');
  assert.equal(out[0].kind, 'commit');
  assert.match(out[0].summary, /fix\(parser\)/);
  assert.equal(out[0].index, 0);
  assert.equal(out[12].index, 12);
});

test('parseReflog: classifies amend before plain commit', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[1].kind, 'amend');
  assert.match(out[1].summary, /cleaner/);
});

test('parseReflog: classifies reset', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[2].kind, 'reset');
  assert.match(out[2].summary, /reset to HEAD~3/);
});

test('parseReflog: classifies rebase variants (start/pick/finish)', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[3].kind, 'rebase');
  assert.match(out[3].summary, /\(start\)/);
  assert.equal(out[4].kind, 'rebase');
  assert.match(out[4].summary, /\(pick\)/);
  assert.equal(out[5].kind, 'rebase');
  assert.match(out[5].summary, /\(finish\)/);
});

test('parseReflog: classifies merge with branch name', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[6].kind, 'merge');
  assert.match(out[6].summary, /merge develop/);
});

test('parseReflog: classifies cherry-pick and revert', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[7].kind, 'cherry-pick');
  assert.match(out[7].summary, /cherry-pick/);
  assert.equal(out[8].kind, 'revert');
  assert.match(out[8].summary, /revert/);
});

test('parseReflog: classifies pull (--rebase included)', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[9].kind, 'pull');
  assert.match(out[9].summary, /pull/);
});

test('parseReflog: classifies checkout (from \u2192 to)', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[10].kind, 'checkout');
  assert.match(out[10].summary, /main/);
  assert.match(out[10].summary, /feature-x/);
});

test('parseReflog: classifies clone', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[11].kind, 'clone');
});

test('parseReflog: unrecognised action falls through to "other"', () => {
  const out = parseReflog(FIXTURE);
  assert.equal(out[12].kind, 'other');
  assert.match(out[12].summary, /something exotic/);
});

test('parseReflog: empty input returns []', () => {
  assert.deepEqual(parseReflog(''), []);
});

test('parseReflog: malformed lines are skipped', () => {
  const out = parseReflog('garbage line\n\nstill garbage\nabc HEAD@{X}: commit: ok');
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, 'abc');
});

test('filterReflog: empty kinds set returns everything', () => {
  const all = parseReflog(FIXTURE);
  const out = filterReflog(all, new Set());
  assert.equal(out.length, all.length);
});

test('filterReflog: subset by kinds', () => {
  const all = parseReflog(FIXTURE);
  const out = filterReflog(all, new Set(['reset', 'rebase']));
  assert.equal(out.length, 4); // 1 reset + 3 rebase
});

test('summariseReflog: counts per kind', () => {
  const all = parseReflog(FIXTURE);
  const s = summariseReflog(all);
  assert.equal(s.total, 13);
  assert.equal(s.byKind.commit, 1);
  assert.equal(s.byKind.amend, 1);
  assert.equal(s.byKind.rebase, 3);
  assert.equal(s.byKind.other, 1);
});

test('glyphForKind: returns codicon names (no emoji)', () => {
  for (const k of FILTER_KIND_ORDER) {
    const g = glyphForKind(k);
    assert.match(g, /^[a-z-]+$/);
  }
});

test('isHeadMove: covers reset/rebase/merge/pull, excludes commits/checkouts', () => {
  assert.equal(isHeadMove('reset'), true);
  assert.equal(isHeadMove('rebase'), true);
  assert.equal(isHeadMove('merge'), true);
  assert.equal(isHeadMove('pull'), true);
  assert.equal(isHeadMove('commit'), false);
  assert.equal(isHeadMove('checkout'), false);
  assert.equal(isHeadMove('amend'), false);
});

test('FILTER_KIND_ORDER: undo-friendly kinds appear first', () => {
  const first = FILTER_KIND_ORDER[0];
  assert.equal(first, 'reset');
  // commit should come after undo-friendly kinds.
  const resetIdx = FILTER_KIND_ORDER.indexOf('reset');
  const commitIdx = FILTER_KIND_ORDER.indexOf('commit');
  assert.ok(commitIdx > resetIdx, 'commit should come after reset');
});
