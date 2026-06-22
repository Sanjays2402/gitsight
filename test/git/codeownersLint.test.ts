import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  tokeniseCodeowners,
  classifyOwner,
  codeownersGlobToRegex,
  findDeadPatterns,
  findShadowedRules,
  findDuplicatePatterns,
  lintCodeowners,
  summariseFindings,
} from '../../src/git/codeownersLint';

test('tokeniseCodeowners: empty body', () => {
  assert.deepEqual(tokeniseCodeowners(''), []);
});

test('tokeniseCodeowners: simple pattern + owners', () => {
  const rules = tokeniseCodeowners('* @alice @bob');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].pattern, '*');
  assert.deepEqual(rules[0].owners.map(o => o.value), ['@alice', '@bob']);
});

test('tokeniseCodeowners: skips comments and blank lines', () => {
  const body = [
    '# header comment',
    '',
    'src/api/ @api-team',
    '',
    '# another note',
    'docs/ @docs-team',
  ].join('\n');
  const rules = tokeniseCodeowners(body);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].pattern, 'src/api/');
  assert.equal(rules[1].pattern, 'docs/');
});

test('tokeniseCodeowners: line numbers reflect original file positions', () => {
  const body = [
    '# line 0',
    '',
    '* @alice',         // line 2
    'src/ @bob',        // line 3
  ].join('\n');
  const rules = tokeniseCodeowners(body);
  assert.equal(rules[0].line, 2);
  assert.equal(rules[1].line, 3);
});

test('tokeniseCodeowners: trailing inline comment is stripped', () => {
  const rules = tokeniseCodeowners('* @alice # the catch-all rule');
  assert.equal(rules[0].pattern, '*');
  assert.deepEqual(rules[0].owners.map(o => o.value), ['@alice']);
});

test('tokeniseCodeowners: # at column 0 is a comment', () => {
  const rules = tokeniseCodeowners('# not a rule\n* @alice');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].pattern, '*');
});

test('tokeniseCodeowners: # without leading whitespace is NOT a comment marker', () => {
  // GitHub doesn't have escaped-# semantics in patterns, but anything
  // before the first whitespace-then-# stays as content.
  const rules = tokeniseCodeowners('*#weird @alice');
  assert.equal(rules[0].pattern, '*#weird');
});

test('tokeniseCodeowners: column info for owners', () => {
  const rules = tokeniseCodeowners('src/api/ @api @team');
  assert.equal(rules[0].patternColumn, 0);
  assert.equal(rules[0].owners[0].column, 9);
  assert.equal(rules[0].owners[1].column, 14);
});

test('classifyOwner: @user', () => {
  assert.equal(classifyOwner('@sanjay'), 'user');
  assert.equal(classifyOwner('@s'), 'user');
  assert.equal(classifyOwner('@user-with-dashes'), 'user');
});

test('classifyOwner: @org/team', () => {
  assert.equal(classifyOwner('@gitsight/maintainers'), 'team');
  assert.equal(classifyOwner('@org/sub-team-1'), 'team');
});

test('classifyOwner: email', () => {
  assert.equal(classifyOwner('alice@example.com'), 'email');
  assert.equal(classifyOwner('user+filter@sub.domain.io'), 'email');
});

test('classifyOwner: invalid shapes', () => {
  assert.equal(classifyOwner(''), 'invalid');
  assert.equal(classifyOwner('@'), 'invalid');
  assert.equal(classifyOwner('alice'), 'invalid');           // no @
  assert.equal(classifyOwner('@-bad'), 'invalid');           // leading -
  assert.equal(classifyOwner('@bad/'), 'invalid');           // empty team
  assert.equal(classifyOwner('not.an.email'), 'invalid');    // no @
  assert.equal(classifyOwner('foo@bar'), 'invalid');         // no dot in domain
  assert.equal(classifyOwner('@alice,@bob'), 'invalid');     // comma separated
});

test('codeownersGlobToRegex: simple basename', () => {
  const re = codeownersGlobToRegex('*.ts');
  assert.ok(re!.test('/foo/bar.ts'));
  assert.ok(re!.test('/bar.ts'));
  assert.ok(!re!.test('/bar.js'));
});

test('codeownersGlobToRegex: anchored leading slash', () => {
  const re = codeownersGlobToRegex('/src/');
  assert.ok(re!.test('/src/api/foo.ts'));
  assert.ok(!re!.test('/lib/src/foo.ts'));
});

test('codeownersGlobToRegex: doublestar matches any depth', () => {
  const re = codeownersGlobToRegex('docs/**');
  assert.ok(re!.test('/docs/intro.md'));
  assert.ok(re!.test('/docs/api/v1/spec.md'));
});

test('codeownersGlobToRegex: dir-only suffix matches dir contents', () => {
  const re = codeownersGlobToRegex('docs/');
  assert.ok(re!.test('/docs/x'));
  assert.ok(re!.test('/docs/sub/file.md'));
  // Bare `/docs` also matches because the regex is anchored on (/|$).
  // CODEOWNERS treats `docs/` as the path token; the matcher is permissive.
});

test('codeownersGlobToRegex: escapes regex metachars', () => {
  const re = codeownersGlobToRegex('a.b+c');
  assert.ok(re!.test('/a.b+c'));
  assert.ok(!re!.test('/aab+c'));
});

test('findDuplicatePatterns: same pattern twice', () => {
  const rules = tokeniseCodeowners('* @alice\n* @bob');
  const dupes = findDuplicatePatterns(rules);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].line, 0);
  assert.equal(dupes[0].supersededBy, 1);
});

test('findDuplicatePatterns: three duplicates -> all earlier flagged', () => {
  const rules = tokeniseCodeowners('a @a\na @b\na @c');
  const dupes = findDuplicatePatterns(rules);
  assert.deepEqual(dupes.map(d => d.line).sort(), [0, 1]);
  assert.equal(dupes[0].supersededBy, 2);
});

test('findDuplicatePatterns: no duplicates', () => {
  const rules = tokeniseCodeowners('a @a\nb @b');
  assert.equal(findDuplicatePatterns(rules).length, 0);
});

test('findShadowedRules: foo/* shadowed by foo/**', () => {
  const rules = tokeniseCodeowners('foo/* @alice\nfoo/** @bob');
  const shadowed = findShadowedRules(rules);
  assert.equal(shadowed.length, 1);
  assert.equal(shadowed[0].line, 0);
  assert.equal(shadowed[0].shadowedBy, 1);
});

test('findShadowedRules: identical patterns flagged as shadow too', () => {
  const rules = tokeniseCodeowners('* @a\n* @b');
  const shadowed = findShadowedRules(rules);
  assert.equal(shadowed.length, 1);
});

test('findShadowedRules: more-specific later does NOT count', () => {
  // Real shadow goes the other way - foo/** doesn't shadow foo/*.
  const rules = tokeniseCodeowners('foo/** @alice\nfoo/* @bob');
  const shadowed = findShadowedRules(rules);
  assert.equal(shadowed.length, 0);
});

test('findDeadPatterns: pattern with no matches', () => {
  const rules = tokeniseCodeowners('nonexistent/ @alice\nsrc/ @bob');
  const dead = findDeadPatterns(rules, ['src/index.ts', 'docs/intro.md']);
  assert.deepEqual(dead, [0]);
});

test('findDeadPatterns: empty file list = no dead findings', () => {
  const rules = tokeniseCodeowners('nonexistent/ @alice');
  assert.deepEqual(findDeadPatterns(rules, []), []);
});

test('lintCodeowners: invalid owner emits error', () => {
  const findings = lintCodeowners('* alice');
  assert.ok(findings.some(f => f.category === 'invalid-owner' && f.severity === 'error'));
});

test('lintCodeowners: empty owner list emits info', () => {
  const findings = lintCodeowners('src/legacy/');
  assert.ok(findings.some(f => f.category === 'empty-owner-list' && f.severity === 'info'));
});

test('lintCodeowners: negation leading ! flagged as syntax warning', () => {
  const findings = lintCodeowners('!docs/ @alice');
  assert.ok(findings.some(f => f.category === 'syntax-warning' && f.message.includes('negation')));
});

test('lintCodeowners: duplicate-pattern flagged on earlier rule only', () => {
  const findings = lintCodeowners('* @a\n* @b');
  const dupes = findings.filter(f => f.category === 'duplicate-pattern');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].line, 0);
});

test('lintCodeowners: unreachable-rule not double-reported alongside duplicate', () => {
  // Identical patterns are duplicate-pattern (warning), NOT also unreachable.
  const findings = lintCodeowners('* @a\n* @b');
  const unreachable = findings.filter(f => f.category === 'unreachable-rule');
  assert.equal(unreachable.length, 0);
});

test('lintCodeowners: dead-pattern emits info when file list given', () => {
  const findings = lintCodeowners('nonexistent/ @alice', ['src/index.ts']);
  assert.ok(findings.some(f => f.category === 'dead-pattern'));
});

test('lintCodeowners: dead-pattern NOT emitted when file list empty', () => {
  const findings = lintCodeowners('nonexistent/ @alice', []);
  assert.ok(!findings.some(f => f.category === 'dead-pattern'));
});

test('lintCodeowners: column points to the bad token', () => {
  // `* @alice bogus_email` - bogus_email starts at column 9.
  const findings = lintCodeowners('* @alice bogus_email');
  const invalidFinding = findings.find(f => f.category === 'invalid-owner');
  assert.ok(invalidFinding);
  assert.equal(invalidFinding!.column, 9);
  assert.equal(invalidFinding!.length, 'bogus_email'.length);
});

test('lintCodeowners: findings sorted by line then column', () => {
  const body = [
    '* @alice bogus1',   // line 0 - invalid-owner
    'src/ bogus2',       // line 1 - invalid-owner
    '!docs/ @alice',     // line 2 - syntax-warning
  ].join('\n');
  const findings = lintCodeowners(body);
  // Lines 0, 1, 2 in order.
  const lines = findings.map(f => f.line);
  const sorted = lines.slice().sort((a, b) => a - b);
  assert.deepEqual(lines, sorted);
});

test('lintCodeowners: clean file produces no findings', () => {
  const body = [
    '# Catch-all',
    '* @alice',
    '',
    '# API',
    'src/api/ @api-team',
  ].join('\n');
  const findings = lintCodeowners(body, ['src/api/v1.ts']);
  assert.equal(findings.length, 0);
});

test('lintCodeowners: valid email owner does NOT flag', () => {
  const findings = lintCodeowners('* alice@example.com');
  assert.ok(!findings.some(f => f.category === 'invalid-owner'));
});

test('lintCodeowners: team handle does NOT flag', () => {
  const findings = lintCodeowners('* @org/sub-team');
  assert.ok(!findings.some(f => f.category === 'invalid-owner'));
});

test('summariseFindings: counts by severity', () => {
  const findings = lintCodeowners('* alice\n* @bob bogus\nsrc/legacy/');
  const s = summariseFindings(findings);
  assert.ok(s.errors >= 1);
  assert.ok(s.info >= 1);
});

test('summariseFindings: empty input', () => {
  const s = summariseFindings([]);
  assert.deepEqual(s, { errors: 0, warnings: 0, info: 0 });
});
