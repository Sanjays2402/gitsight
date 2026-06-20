import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePorcelain, shortCounts, describeCounts, isConflict } from '../../src/git/workingTreeStatus';

test('parsePorcelain: counts staged, modified, untracked', () => {
  const out = [
    'M  src/a.ts',     // staged modify
    ' M src/b.ts',     // worktree modify
    'A  src/c.ts',     // staged add
    'MM src/d.ts',     // both staged + modified
    '?? src/e.ts',     // untracked
    '!! ignored.log',  // ignored - drop
    '',                // blank
  ].join('\n');
  const c = parsePorcelain(out);
  assert.equal(c.staged, 3, 'M, A, MM staged');
  assert.equal(c.modified, 2, 'M (worktree on b) + MM (worktree on d)');
  assert.equal(c.untracked, 1);
  assert.equal(c.conflicted, 0);
});

test('parsePorcelain: detects merge conflicts (UU, AA, DD, AU, UA, DU, UD)', () => {
  for (const xy of ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']) {
    const c = parsePorcelain(`${xy} conflict.ts\n`);
    assert.equal(c.conflicted, 1, `expected ${xy} → conflict`);
    assert.equal(c.staged, 0, `${xy} should not count as staged`);
    assert.equal(c.modified, 0, `${xy} should not count as modified`);
  }
});

test('parsePorcelain: empty output → all zero', () => {
  const c = parsePorcelain('');
  assert.deepEqual(c, { staged: 0, modified: 0, untracked: 0, conflicted: 0 });
});

test('isConflict: pure helper agrees with the table', () => {
  assert.ok(isConflict('U', 'U'));
  assert.ok(isConflict('A', 'A'));
  assert.ok(isConflict('D', 'D'));
  assert.ok(isConflict('A', 'U'));
  assert.ok(isConflict('U', 'A'));
  assert.ok(!isConflict('M', ' '));
  assert.ok(!isConflict(' ', 'M'));
  assert.ok(!isConflict('?', '?'));
});

test('shortCounts / describeCounts: render in canonical order', () => {
  const c = { staged: 2, modified: 3, untracked: 1, conflicted: 1 };
  assert.equal(shortCounts(c), '!1 +2 ~3 ?1');
  assert.equal(describeCounts(c), '1 conflicted  ·  2 staged  ·  3 modified  ·  1 untracked');
});

test('shortCounts: omits zero buckets', () => {
  assert.equal(shortCounts({ staged: 1, modified: 0, untracked: 0, conflicted: 0 }), '+1');
  assert.equal(shortCounts({ staged: 0, modified: 0, untracked: 0, conflicted: 0 }), '');
});
