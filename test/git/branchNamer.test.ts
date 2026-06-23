import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  kebab,
  parseSubject,
  composeBranchName,
  capBranchName,
  suggestBranchNames,
  bestBranchSuggestion,
  validateBranchName,
} from '../../src/git/branchNamer';

// ── kebab ─────────────────────────────────────────────────────────

test('kebab: lowercases + swaps separators', () => {
  assert.equal(kebab('Hello World'), 'hello-world');
  assert.equal(kebab('Add LOGIN page'), 'add-login-page');
  assert.equal(kebab('  trim me  '), 'trim-me');
  assert.equal(kebab('strip$$$weird___chars'), 'strip-weird-chars');
  assert.equal(kebab(''), '');
});

// ── parseSubject ──────────────────────────────────────────────────

test('parseSubject: conventional with scope + breaking', () => {
  const p = parseSubject('feat(auth)!: rip out cookies');
  assert.equal(p.type, 'feat');
  assert.equal(p.scope, 'auth');
  assert.equal(p.breaking, true);
  assert.equal(p.subject, 'rip out cookies');
});

test('parseSubject: conventional without scope', () => {
  const p = parseSubject('fix: handle empty array');
  assert.equal(p.type, 'fix');
  assert.equal(p.scope, undefined);
  assert.equal(p.breaking, false);
});

test('parseSubject: unknown type prefix becomes a plain subject', () => {
  const p = parseSubject('WIP: hack the planet');
  assert.equal(p.type, undefined);
  assert.equal(p.subject, 'WIP: hack the planet');
});

test('parseSubject: leading ticket marker', () => {
  const p = parseSubject('PROJ-123 add logout');
  assert.equal(p.ticket, 'PROJ-123');
  assert.equal(p.subject, 'add logout');
  assert.equal(p.type, undefined);
});

test('parseSubject: bracketed ticket marker', () => {
  const p = parseSubject('[PROJ-123] fix oops');
  assert.equal(p.ticket, 'PROJ-123');
  assert.equal(p.subject, 'fix oops');
});

test('parseSubject: ticket inside a conventional subject', () => {
  const p = parseSubject('fix(auth): PROJ-123 handle 401');
  assert.equal(p.type, 'fix');
  assert.equal(p.scope, 'auth');
  assert.equal(p.ticket, 'PROJ-123');
  assert.equal(p.subject, 'handle 401');
});

test('parseSubject: empty / whitespace', () => {
  assert.equal(parseSubject('').subject, '');
  assert.equal(parseSubject('   \n   ').subject, '');
});

test('parseSubject: drops body, keeps first line only', () => {
  const p = parseSubject('feat: add logout\n\nThis adds a logout button.');
  assert.equal(p.subject, 'add logout');
});

// ── composeBranchName ─────────────────────────────────────────────

test('composeBranchName: type/subject', () => {
  assert.equal(composeBranchName({ type: 'feat', subject: 'add logout', breaking: false }), 'feat/add-logout');
});

test('composeBranchName: type-subject when separator=kebab', () => {
  assert.equal(composeBranchName({ type: 'feat', subject: 'add logout', breaking: false }, 'kebab'), 'feat-add-logout');
});

test('composeBranchName: type+ticket+subject', () => {
  assert.equal(
    composeBranchName({ type: 'fix', subject: 'handle 401', breaking: false, ticket: 'PROJ-123' }),
    'fix/proj-123-handle-401',
  );
});

test('composeBranchName: no type returns the slug', () => {
  assert.equal(composeBranchName({ subject: 'misc', breaking: false }), 'misc');
});

test('composeBranchName: separator=none drops type entirely', () => {
  // 'none' means: the slug alone (no type prefix at all). Documented in
  // composeBranchName's contract. When there's no slug, the type alone
  // becomes the name (better than empty string).
  assert.equal(composeBranchName({ type: 'feat', subject: 'add logout', breaking: false }, 'none'), 'add-logout');
  assert.equal(composeBranchName({ type: 'feat', subject: '', breaking: false }, 'none'), 'feat');
});

test('composeBranchName: no subject falls back to wip', () => {
  assert.equal(composeBranchName({ subject: '', breaking: false }), 'wip');
});

// ── capBranchName ─────────────────────────────────────────────────

test('capBranchName: under cap returns unchanged', () => {
  assert.equal(capBranchName('feat/x'), 'feat/x');
});

test('capBranchName: trims trailing dash after slice', () => {
  const long = 'feat/' + 'x'.repeat(100);
  const out = capBranchName(long, 12);
  assert.ok(out.length <= 12);
  assert.ok(!out.endsWith('-'));
});

// ── validateBranchName ────────────────────────────────────────────

test('validateBranchName: empty fails', () => {
  assert.ok(validateBranchName('')?.includes('empty'));
  assert.ok(validateBranchName('   ')?.includes('empty'));
});

test('validateBranchName: rejects leading / trailing slash', () => {
  assert.ok(validateBranchName('/foo')?.includes('/'));
  assert.ok(validateBranchName('foo/')?.includes('/'));
});

test('validateBranchName: rejects double slash', () => {
  assert.ok(validateBranchName('feat//x')?.includes('//'));
});

test('validateBranchName: rejects @{', () => {
  assert.ok(validateBranchName('foo@{x}')?.includes('@{'));
});

test('validateBranchName: rejects .lock suffix', () => {
  assert.ok(validateBranchName('feat/x.lock')?.includes('.lock'));
});

test('validateBranchName: rejects spaces and colons and stars', () => {
  assert.ok(validateBranchName('feat/foo bar'));
  assert.ok(validateBranchName('feat:x'));
  assert.ok(validateBranchName('feat/x*'));
});

test('validateBranchName: accepts a well-formed conventional name', () => {
  assert.equal(validateBranchName('feat/add-logout'), undefined);
  assert.equal(validateBranchName('fix/proj-123-handle-401'), undefined);
});

// ── suggestBranchNames ────────────────────────────────────────────

test('suggestBranchNames: SCM input drives best suggestion', () => {
  // The scope is NOT included in the slug -- only ticket + subject are.
  // So 'feat(auth): add logout' becomes feat/add-logout, NOT
  // feat/auth-add-logout. Matches GitHub Flow conventions where the
  // branch is named after the user-facing change, not the scope tag.
  const all = suggestBranchNames({ scmInput: 'feat(auth): add logout' });
  assert.ok(all.length > 0);
  assert.equal(all[0].name, 'feat/add-logout');
});

test('suggestBranchNames: ticket from SCM input becomes part of slug', () => {
  const all = suggestBranchNames({ scmInput: '[PROJ-12] fix login bug' });
  assert.equal(all[0].name, 'proj-12-fix-login-bug');
});

test('suggestBranchNames: selection text fallback', () => {
  const all = suggestBranchNames({ selectionText: 'Refactor the auth module to be testable.' });
  assert.ok(all.length > 0);
  assert.ok(all[0].name.includes('refactor'));
});

test('suggestBranchNames: dirty single file -> wip-<basename>', () => {
  const all = suggestBranchNames({ dirtyPaths: ['src/auth/login.ts'] });
  assert.ok(all.some(s => s.name === 'wip-login'));
});

test('suggestBranchNames: dirty many under one dir -> wip-<dir>', () => {
  const all = suggestBranchNames({ dirtyPaths: ['src/auth/a.ts', 'src/auth/b.ts', 'src/auth/c.ts'] });
  assert.ok(all.some(s => s.name === 'wip-auth'));
});

test('suggestBranchNames: active file as last-of-meaningful fallback', () => {
  const all = suggestBranchNames({ activeFile: 'src/index.ts' });
  assert.ok(all.some(s => s.name === 'wip-index'));
});

test('suggestBranchNames: repo name as absolute fallback', () => {
  const all = suggestBranchNames({ repoName: 'gitsight' });
  assert.ok(all.some(s => s.name === 'wip-gitsight'));
});

test('suggestBranchNames: SCM beats selection beats dirty', () => {
  const all = suggestBranchNames({
    scmInput: 'feat: x',
    selectionText: 'y z',
    dirtyPaths: ['src/foo.ts'],
  });
  assert.equal(all[0].name, 'feat/x');
});

test('suggestBranchNames: dedupe identical names', () => {
  const all = suggestBranchNames({
    scmInput: 'wip-foo',
    activeFile: 'foo.ts',
  });
  // Plain subject becomes 'wip-foo'; active file becomes 'wip-foo' too.
  const seen = new Set(all.map(s => s.name));
  assert.equal(seen.size, all.length);
});

test('suggestBranchNames: respects separator config (kebab)', () => {
  const all = suggestBranchNames({ scmInput: 'feat: bar', separator: 'kebab' });
  assert.equal(all[0].name, 'feat-bar');
});

// ── bestBranchSuggestion ──────────────────────────────────────────

test('bestBranchSuggestion: returns wip when nothing useful', () => {
  assert.equal(bestBranchSuggestion({}), 'wip');
});

test('bestBranchSuggestion: returns the first ranked', () => {
  const v = bestBranchSuggestion({ scmInput: 'feat: cool' });
  assert.equal(v, 'feat/cool');
});
