import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestSuggestion,
  commonPrefix,
  dirtyPaths,
  kebab,
  shortenBranch,
  suggestStashNames,
} from '../../src/git/stashNaming';

test('kebab: lowercases, swaps separators, trims dashes', () => {
  assert.equal(kebab('Hello World'), 'hello-world');
  assert.equal(kebab('Auth_Refactor/Bug-fix'), 'auth-refactor-bug-fix');
  assert.equal(kebab('  trim me  '), 'trim-me');
  assert.equal(kebab('strip$$$weird___chars'), 'strip-weird-chars');
  assert.equal(kebab(''), '');
});

test('shortenBranch: drops feature/feat/fix/etc prefixes', () => {
  assert.equal(shortenBranch('feature/auth-refactor'), 'auth-refactor');
  assert.equal(shortenBranch('feat/SAN-1234/login-bug'), 'login-bug');
  assert.equal(shortenBranch('fix/oops'), 'oops');
  assert.equal(shortenBranch('release/v1.2.3'), 'v1-2-3');
  assert.equal(shortenBranch('main'), 'main');
  assert.equal(shortenBranch(''), '');
});

test('commonPrefix: directory only — not the full path', () => {
  assert.equal(commonPrefix(['src/auth/login.ts', 'src/auth/logout.ts']), 'src/auth');
  assert.equal(commonPrefix(['src/auth/login.ts', 'src/billing/index.ts']), 'src');
  assert.equal(commonPrefix(['README.md', 'src/foo.ts']), '');
  assert.equal(commonPrefix(['src/foo.ts', 'src/foo.ts']), 'src');
  assert.equal(commonPrefix([]), '');
});

test('commonPrefix: single path returns its parent dir', () => {
  // Single path: prefix == path itself, but we shave off the basename to
  // produce a *directory*. Otherwise the suggestion would be "src/auth"
  // for a single file in src/auth and "src/auth/login" for nothing useful.
  assert.equal(commonPrefix(['src/auth/login.ts']), 'src/auth');
});

test('dirtyPaths: excludes untracked / ignored', () => {
  const porcelain = [
    ' M src/a.ts',
    'M  src/b.ts',
    '?? newfile.txt',
    '!! ignored.lock',
    ' D src/c.ts',
  ].join('\n');
  assert.deepEqual(dirtyPaths(porcelain).sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
});

test('suggestStashNames: branch + folder produces compound suggestion', () => {
  const out = suggestStashNames({
    branch: 'feature/auth-refactor',
    dirtyPaths: ['src/auth/login.ts', 'src/auth/logout.ts'],
    activeFile: 'src/auth/login.ts',
  });
  assert.equal(out[0].name, 'auth-refactor-auth-wip');
  assert.match(out[0].source, /folder under src\/auth/);
});

test('suggestStashNames: branch only when paths span the repo', () => {
  const out = suggestStashNames({
    branch: 'fix/login-bug',
    dirtyPaths: ['README.md', 'src/auth/foo.ts'],
  });
  // commonPrefix is '' across these, so we fall back to branch-only.
  assert.equal(out[0].name, 'login-bug-wip');
  assert.equal(out[0].source, 'current branch');
});

test('suggestStashNames: single file appends file-only suggestion', () => {
  const out = suggestStashNames({
    branch: 'main',
    dirtyPaths: ['src/auth/login.ts'],
  });
  assert.ok(out.some(s => s.name === 'login-wip'));
});

test('suggestStashNames: two-file pair joins both basenames', () => {
  const out = suggestStashNames({
    branch: 'main',
    dirtyPaths: ['src/auth/login.ts', 'src/auth/logout.ts'],
  });
  assert.ok(out.some(s => s.name === 'login-logout-wip'));
});

test('suggestStashNames: dedupes identical names', () => {
  const out = suggestStashNames({
    branch: 'wip',
    dirtyPaths: ['wip.ts'],
    activeFile: 'wip.ts',
    repoName: 'wip',
  });
  // "wip-wip" should appear once even though multiple sources produce it.
  const names = out.map(s => s.name);
  assert.equal(names.length, new Set(names).size);
});

test('suggestStashNames: no branch and no paths falls back to repo name', () => {
  const out = suggestStashNames({ repoName: 'gitsight' });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'gitsight-wip');
  assert.match(out[0].source, /fallback/);
});

test('suggestStashNames: no inputs at all returns empty list', () => {
  const out = suggestStashNames({});
  assert.deepEqual(out, []);
});

test('bestSuggestion: returns top pick or "wip" fallback', () => {
  assert.equal(bestSuggestion({ branch: 'feature/x', dirtyPaths: ['a.ts'] }), 'x-wip');
  assert.equal(bestSuggestion({}), 'wip');
});

test('suggestStashNames: branchPart trims TICKET tags from the start', () => {
  const out = suggestStashNames({
    branch: 'TICKET-1234/login-bug',
    dirtyPaths: ['src/login.ts'],
  });
  // shortenBranch keeps the descriptive half of TICKET-1234/desc.
  // Top suggestion includes branch + common folder ("src"), file-only is also offered.
  assert.match(out[0].name, /^login-bug-/);
  assert.ok(out.some(s => s.name === 'login-wip'));
});
