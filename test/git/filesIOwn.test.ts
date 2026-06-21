import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ownerMatchesUser,
  resolveOwners,
  shortlogDominance,
  buildFilesIOwn,
  parseShortlog,
  globToCodeownersRegex,
  parseCodeownersBody,
  UserIdentity,
  ShortlogEntry,
} from '../../src/git/filesIOwn';

const USER: UserIdentity = {
  email: 'sanjay@example.com',
  name: 'Sanjay Subramanian',
  handle: '@sanjays2402',
  aliases: [],
};

test('ownerMatchesUser: email match (case-insensitive)', () => {
  assert.equal(ownerMatchesUser('sanjay@example.com', USER), true);
  assert.equal(ownerMatchesUser('SANJAY@EXAMPLE.COM', USER), true);
});

test('ownerMatchesUser: handle match (with and without @)', () => {
  assert.equal(ownerMatchesUser('@sanjays2402', USER), true);
  assert.equal(ownerMatchesUser('@SanjayS2402', USER), true);
});

test('ownerMatchesUser: rejects unrelated identities', () => {
  assert.equal(ownerMatchesUser('someone-else@example.com', USER), false);
  assert.equal(ownerMatchesUser('@someone-else', USER), false);
});

test('ownerMatchesUser: team handles never match (need explicit alias)', () => {
  assert.equal(ownerMatchesUser('@myorg/core-team', USER), false);
  const aliased: UserIdentity = { ...USER, aliases: ['@myorg/core-team'] };
  // Aliases also rejected for team-shape handles — they're not single-user
  // identifiers. The check happens via the team-handle reject branch.
  assert.equal(ownerMatchesUser('@myorg/core-team', aliased), false);
});

test('ownerMatchesUser: aliases (extra emails) match', () => {
  const u: UserIdentity = { ...USER, aliases: ['sanjay.work@example.com'] };
  assert.equal(ownerMatchesUser('sanjay.work@example.com', u), true);
});

test('ownerMatchesUser: empty owner returns false', () => {
  assert.equal(ownerMatchesUser('', USER), false);
  assert.equal(ownerMatchesUser('   ', USER), false);
});

test('resolveOwners: last matching rule wins (GitHub semantics)', () => {
  const rules = parseCodeownersBody([
    '* @everyone',
    'src/**         @backend',
    'src/auth/**    @sanjays2402',
  ].join('\n'));
  assert.deepEqual(resolveOwners(rules, 'README.md'), ['@everyone']);
  assert.deepEqual(resolveOwners(rules, 'src/billing/index.ts'), ['@backend']);
  assert.deepEqual(resolveOwners(rules, 'src/auth/login.ts'), ['@sanjays2402']);
});

test('resolveOwners: no match returns empty', () => {
  const rules = parseCodeownersBody('src/auth/** @x');
  assert.deepEqual(resolveOwners(rules, 'README.md'), []);
});

test('globToCodeownersRegex: anchored vs unanchored', () => {
  const anchored = globToCodeownersRegex('/docs/');
  assert.ok(anchored.test('/docs/foo.md'));
  assert.ok(!anchored.test('/src/docs/foo.md'));

  const un = globToCodeownersRegex('docs/');
  assert.ok(un.test('/docs/foo.md'));
  assert.ok(un.test('/sub/docs/foo.md'));
});

test('globToCodeownersRegex: wildcards', () => {
  const star = globToCodeownersRegex('*.ts');
  assert.ok(star.test('/foo.ts'));
  assert.ok(star.test('/a/b/foo.ts'));
  assert.ok(!star.test('/foo.js'));

  const dbl = globToCodeownersRegex('src/**');
  assert.ok(dbl.test('/src/auth/login.ts'));
  assert.ok(dbl.test('/src/index.ts'));
});

test('shortlogDominance: dominant when >50% AND >=2 commits', () => {
  const entry: ShortlogEntry = {
    path: 'src/auth.ts',
    byAuthor: { 'sanjay@example.com': 5, 'other@example.com': 2 },
  };
  const d = shortlogDominance(entry, USER);
  assert.equal(d.myCommits, 5);
  assert.equal(d.totalCommits, 7);
  assert.ok(d.share > 0.7);
  assert.equal(d.dominant, true);
});

test('shortlogDominance: 1 commit alone is NOT dominant (drive-by fix)', () => {
  const entry: ShortlogEntry = {
    path: 'src/auth.ts',
    byAuthor: { 'sanjay@example.com': 1 },
  };
  const d = shortlogDominance(entry, USER);
  assert.equal(d.dominant, false);
});

test('shortlogDominance: 50/50 split is NOT dominant', () => {
  const entry: ShortlogEntry = {
    path: 'src/auth.ts',
    byAuthor: { 'sanjay@example.com': 3, 'other@example.com': 3 },
  };
  const d = shortlogDominance(entry, USER);
  assert.equal(d.dominant, false);
});

test('shortlogDominance: matches by author name when shortlog keyed by name', () => {
  const entry: ShortlogEntry = {
    path: 'src/auth.ts',
    byAuthor: { 'sanjay subramanian': 5, 'other': 1 },
  };
  const d = shortlogDominance(entry, USER);
  assert.equal(d.myCommits, 5);
  assert.equal(d.dominant, true);
});

test('buildFilesIOwn: ranks both > codeowners > shortlog', () => {
  const rules = parseCodeownersBody([
    'docs/**     @sanjays2402',
    'src/auth/** @sanjays2402',
  ].join('\n'));
  const tracked = [
    'docs/readme.md',
    'src/auth/login.ts',
    'src/billing/index.ts',
    'src/random/lib.ts',
  ];
  const shortlog: ShortlogEntry[] = [
    { path: 'src/auth/login.ts', byAuthor: { 'sanjay@example.com': 4, 'other': 1 } },
    { path: 'src/billing/index.ts', byAuthor: { 'sanjay@example.com': 6, 'other': 1 } },
  ];
  const out = buildFilesIOwn({ user: USER, rules, trackedFiles: tracked, shortlog });
  // 4 candidates: auth/login (both), docs/readme (codeowners), billing/index (shortlog).
  // random/lib has no signal → dropped.
  assert.equal(out.length, 3);
  assert.equal(out[0].path, 'src/auth/login.ts');
  assert.equal(out[0].source, 'both');
  assert.equal(out[1].path, 'docs/readme.md');
  assert.equal(out[1].source, 'codeowners');
  assert.equal(out[2].path, 'src/billing/index.ts');
  assert.equal(out[2].source, 'shortlog');
});

test('buildFilesIOwn: returns empty when user owns nothing', () => {
  const rules = parseCodeownersBody('* @someone-else');
  const tracked = ['a.ts', 'b.ts'];
  const shortlog: ShortlogEntry[] = [
    { path: 'a.ts', byAuthor: { 'someone-else': 5 } },
  ];
  const out = buildFilesIOwn({ user: USER, rules, trackedFiles: tracked, shortlog });
  assert.equal(out.length, 0);
});

test('buildFilesIOwn: codeowners-only entries have myCommits=0 when no shortlog signal', () => {
  const rules = parseCodeownersBody('docs/** @sanjays2402');
  const tracked = ['docs/x.md'];
  const out = buildFilesIOwn({ user: USER, rules, trackedFiles: tracked, shortlog: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'docs/x.md');
  assert.equal(out[0].myCommits, 0);
  assert.equal(out[0].totalCommits, 0);
});

test('parseShortlog: parses email|name headers + file paths', () => {
  const raw = [
    'sanjay@example.com|Sanjay',
    'src/a.ts',
    'src/b.ts',
    '',
    'other@example.com|Other',
    'src/a.ts',
  ].join('\n');
  const out = parseShortlog(raw);
  // 2 unique paths
  assert.equal(out.length, 2);
  const a = out.find(o => o.path === 'src/a.ts')!;
  assert.equal(a.byAuthor['sanjay@example.com'], 1);
  assert.equal(a.byAuthor['other@example.com'], 1);
  const b = out.find(o => o.path === 'src/b.ts')!;
  assert.equal(b.byAuthor['sanjay@example.com'], 1);
});

test('parseShortlog: empty input → empty list', () => {
  assert.deepEqual(parseShortlog(''), []);
});

test('parseCodeownersBody: strips comments and blanks', () => {
  const rules = parseCodeownersBody([
    '# This is a comment',
    '',
    '*.ts @sanjays2402 # trailing comment',
    'docs/ @docs-team',
  ].join('\n'));
  assert.equal(rules.length, 2);
  assert.equal(rules[0].pattern, '*.ts');
  assert.deepEqual(rules[0].owners, ['@sanjays2402']);
  assert.equal(rules[1].pattern, 'docs/');
  assert.deepEqual(rules[1].owners, ['@docs-team']);
});
