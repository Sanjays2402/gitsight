import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePorcelain,
  stagedPaths,
  dirtyWorktreePaths,
  parseRecentTouches,
  findForgottenFiles,
  summariseForgotten,
} from '../../src/git/forgottenFiles';

test('parsePorcelain: extracts x/y/path; handles rename arrow', () => {
  const out = parsePorcelain([
    ' M src/a.ts',
    'MM src/b.ts',
    'A  src/c.ts',
    '?? newfile.txt',
    'R  src/old.ts -> src/new.ts',
    '',
    ' D src/dead.ts',
  ].join('\n'));
  assert.equal(out.length, 6);
  assert.deepEqual(out[0], { x: ' ', y: 'M', path: 'src/a.ts' });
  assert.deepEqual(out[1], { x: 'M', y: 'M', path: 'src/b.ts' });
  assert.deepEqual(out[2], { x: 'A', y: ' ', path: 'src/c.ts' });
  assert.deepEqual(out[3], { x: '?', y: '?', path: 'newfile.txt' });
  assert.equal(out[4].path, 'src/new.ts');
  assert.deepEqual(out[5], { x: ' ', y: 'D', path: 'src/dead.ts' });
});

test('stagedPaths: only includes X != " " / "?"', () => {
  const rows = parsePorcelain([
    ' M src/a.ts', 'M  src/b.ts', 'MM src/c.ts', '?? src/d.ts',
  ].join('\n'));
  assert.deepEqual(stagedPaths(rows).sort(), ['src/b.ts', 'src/c.ts']);
});

test('dirtyWorktreePaths: only includes Y dirty (skips untracked and ignored)', () => {
  const rows = parsePorcelain([
    ' M src/a.ts', 'M  src/b.ts', '?? src/c.txt', '!! src/d.txt', ' D src/e.ts',
  ].join('\n'));
  assert.deepEqual(dirtyWorktreePaths(rows).sort(), ['src/a.ts', 'src/e.ts']);
});

test('parseRecentTouches: keeps newest timestamp per path', () => {
  const out = parseRecentTouches([
    'abcd|2026-06-20T09:00:00Z',
    'src/a.ts',
    'src/b.ts',
    '',
    'efgh|2026-06-18T12:00:00Z',
    'src/a.ts',
    'src/c.ts',
  ].join('\n'));
  const byPath = Object.fromEntries(out.map(o => [o.path, o.lastTouchedIso]));
  assert.equal(byPath['src/a.ts'], '2026-06-20T09:00:00Z');
  assert.equal(byPath['src/b.ts'], '2026-06-20T09:00:00Z');
  assert.equal(byPath['src/c.ts'], '2026-06-18T12:00:00Z');
});

test('parseRecentTouches: empty / garbage returns empty', () => {
  assert.deepEqual(parseRecentTouches(''), []);
  assert.deepEqual(parseRecentTouches('not-a-commit-line\n'), []);
});

test('findForgottenFiles: dirty-but-unstaged surfaces; staged excluded', () => {
  const out = findForgottenFiles({
    recent: [
      { path: 'src/a.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
      { path: 'src/b.ts', lastTouchedIso: '2026-06-19T09:00:00Z' },
      { path: 'src/c.ts', lastTouchedIso: '2026-06-18T09:00:00Z' },
    ],
    staged: ['src/b.ts'],
    dirtyWorktree: ['src/a.ts', 'src/c.ts'],
  });
  assert.deepEqual(out.map(f => f.path), ['src/a.ts', 'src/c.ts']);
  assert.equal(out[0].dirtyButUnstaged, true);
});

test('findForgottenFiles: ignoreClean default true — clean recents skipped', () => {
  const out = findForgottenFiles({
    recent: [
      { path: 'src/clean.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
    ],
    staged: [],
    dirtyWorktree: [],
  });
  assert.deepEqual(out, []);
});

test('findForgottenFiles: ignoreClean=false includes clean recents', () => {
  const out = findForgottenFiles({
    recent: [
      { path: 'src/clean.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
    ],
    staged: [],
    dirtyWorktree: [],
    ignoreClean: false,
  });
  assert.deepEqual(out.map(f => f.path), ['src/clean.ts']);
  assert.equal(out[0].dirtyButUnstaged, false);
});

test('findForgottenFiles: dirty-first ordering, then newest-first', () => {
  const out = findForgottenFiles({
    recent: [
      { path: 'src/clean-old.ts', lastTouchedIso: '2026-06-15T09:00:00Z' },
      { path: 'src/dirty-old.ts', lastTouchedIso: '2026-06-15T09:00:00Z' },
      { path: 'src/clean-new.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
      { path: 'src/dirty-new.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
    ],
    staged: [],
    dirtyWorktree: ['src/dirty-old.ts', 'src/dirty-new.ts'],
    ignoreClean: false,
  });
  assert.deepEqual(out.map(f => f.path), [
    'src/dirty-new.ts', 'src/dirty-old.ts',  // dirty first
    'src/clean-new.ts', 'src/clean-old.ts',  // then clean, newest-first
  ]);
});

test('findForgottenFiles: excludePaths respected', () => {
  const out = findForgottenFiles({
    recent: [
      { path: 'src/a.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
      { path: 'src/b.ts', lastTouchedIso: '2026-06-20T09:00:00Z' },
    ],
    staged: [],
    dirtyWorktree: ['src/a.ts', 'src/b.ts'],
    excludePaths: ['src/b.ts'],
  });
  assert.deepEqual(out.map(f => f.path), ['src/a.ts']);
});

test('summariseForgotten: 0/1/2/3+ wording', () => {
  assert.match(summariseForgotten([]), /No forgotten edits/);
  assert.match(
    summariseForgotten([{ path: 'a.ts', lastTouchedIso: 'x', dirtyButUnstaged: true }]),
    /1 file edited recently isn't staged: a\.ts/,
  );
  assert.match(
    summariseForgotten([
      { path: 'a.ts', lastTouchedIso: 'x', dirtyButUnstaged: true },
      { path: 'b.ts', lastTouchedIso: 'x', dirtyButUnstaged: true },
    ]),
    /2 files edited recently aren't staged: a\.ts, b\.ts$/,
  );
  assert.match(
    summariseForgotten([
      { path: 'a.ts', lastTouchedIso: 'x', dirtyButUnstaged: true },
      { path: 'b.ts', lastTouchedIso: 'x', dirtyButUnstaged: true },
      { path: 'c.ts', lastTouchedIso: 'x', dirtyButUnstaged: true },
      { path: 'd.ts', lastTouchedIso: 'x', dirtyButUnstaged: true },
    ]),
    /4 files edited recently aren't staged: a\.ts, b\.ts \+2$/,
  );
});
