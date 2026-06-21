import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  lintCommitMessage,
  topSeverity,
  summariseProblems,
} from '../../src/git/commitLint';

test('clean conventional commit → no problems', () => {
  const msg = [
    'feat(scope): add the thing',
    '',
    'A short body explaining why the thing was added.',
  ].join('\n');
  assert.deepEqual(lintCommitMessage(msg), []);
});

test('subject too long → error with byte count', () => {
  const subj = 'feat: ' + 'x'.repeat(80);
  const problems = lintCommitMessage(subj);
  const tooLong = problems.find(p => p.code === 'subjectTooLong');
  assert.ok(tooLong);
  assert.equal(tooLong!.severity, 'error');
  assert.match(tooLong!.message, /max 72/);
});

test('WIP / fixup! / squash! prefixes are errors', () => {
  for (const subj of ['WIP: still working', 'fixup! something', 'squash! merge me', 'amend! tweak']) {
    const problems = lintCommitMessage(subj);
    assert.ok(problems.some(p => p.code === 'wipPrefix' && p.severity === 'error'), subj);
  }
});

test('missing blank line after subject is a warning', () => {
  const msg = 'feat: x\nbody starts immediately';
  const problems = lintCommitMessage(msg);
  assert.ok(problems.some(p => p.code === 'missingBlankLine' && p.severity === 'warning'));
});

test('subject ends with ":" but no body → missingBody warning', () => {
  const problems = lintCommitMessage('refactor:');
  assert.ok(problems.some(p => p.code === 'missingBody' && p.severity === 'warning'));
});

test('trailing whitespace and long body lines are warnings only', () => {
  const msg = [
    'feat: x',
    '',
    'this body has trailing spaces   ',
    'a'.repeat(120),
  ].join('\n');
  const problems = lintCommitMessage(msg);
  assert.equal(topSeverity(problems), 'warning');
  assert.ok(problems.some(p => p.code === 'trailingWhitespace'));
  assert.ok(problems.some(p => p.code === 'bodyLineTooLong'));
});

test('warnLowercaseSubject is opt-in (default off) and respects CC types', () => {
  // default: no warning for lowercase
  let problems = lintCommitMessage('add the thing');
  assert.equal(problems.find(p => p.code === 'subjectStartsLower'), undefined);
  // opt-in: warns on plain lowercase
  problems = lintCommitMessage('add the thing', { warnLowercaseSubject: true });
  assert.ok(problems.some(p => p.code === 'subjectStartsLower'));
  // opt-in: but Conventional Commits prefix is fine
  problems = lintCommitMessage('feat: add the thing', { warnLowercaseSubject: true });
  assert.equal(problems.find(p => p.code === 'subjectStartsLower'), undefined);
  // opt-in: scope + ! also fine
  problems = lintCommitMessage('refactor(api)!: break it', { warnLowercaseSubject: true });
  assert.equal(problems.find(p => p.code === 'subjectStartsLower'), undefined);
});

test('summariseProblems & topSeverity reflect counts', () => {
  const ok = lintCommitMessage('feat: ok\n\nbody');
  assert.equal(summariseProblems(ok), 'Commit message looks good.');
  assert.equal(topSeverity(ok), undefined);
  const bad = lintCommitMessage('WIP\nbody');
  const s = summariseProblems(bad);
  assert.match(s, /error|warning/);
  assert.equal(topSeverity(bad), 'error');
});

test('empty / whitespace message → no problems', () => {
  assert.deepEqual(lintCommitMessage(''), []);
  assert.deepEqual(lintCommitMessage('   \n\n   '), []);
});
