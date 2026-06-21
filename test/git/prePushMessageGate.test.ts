import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintCommitMessages,
  summariseCommitGate,
  describeCommitGate,
  parseCommitMessageLog,
} from '../../src/git/prePushMessageGate';

test('lintCommitMessages: skips clean commits', () => {
  const out = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'feat(x): clean and short', message: 'feat(x): clean and short' },
  ]);
  assert.equal(out.length, 0);
});

test('lintCommitMessages: catches long subject (error)', () => {
  const long = 'feat(parser): ' + 'x'.repeat(120);
  const out = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: long, message: long },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].topSeverity, 'error');
  assert.ok(out[0].problems.some(p => p.code === 'subjectTooLong'));
});

test('lintCommitMessages: catches WIP prefix (error)', () => {
  const out = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'WIP try something', message: 'WIP try something' },
  ]);
  assert.equal(out[0].topSeverity, 'error');
  assert.ok(out[0].problems.some(p => p.code === 'wipPrefix'));
});

test('lintCommitMessages: warns on trailing period (warning only)', () => {
  const out = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'feat: do x.', message: 'feat: do x.' },
  ]);
  assert.equal(out[0].topSeverity, 'warning');
});

test('lintCommitMessages: catches body-line too long', () => {
  const body = 'x'.repeat(120);
  const msg = `feat: short subject\n\n${body}`;
  const out = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'feat: short subject', message: msg },
  ]);
  assert.equal(out[0].problems.some(p => p.code === 'bodyLineTooLong'), true);
});

test('lintCommitMessages: catches missing blank line after subject', () => {
  const msg = 'feat: subject\nbody immediately';
  const out = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'feat: subject', message: msg },
  ]);
  assert.equal(out[0].problems.some(p => p.code === 'missingBlankLine'), true);
});

test('lintCommitMessages: threads LintOptions through', () => {
  const msg = 'feat: ' + 'x'.repeat(40); // 46 chars
  const tight = lintCommitMessages(
    [{ sha: 'a', shortSha: 'a', subject: msg, message: msg }],
    { maxSubjectLength: 30 },
  );
  assert.equal(tight[0].problems.some(p => p.code === 'subjectTooLong'), true);
  const lax = lintCommitMessages(
    [{ sha: 'a', shortSha: 'a', subject: msg, message: msg }],
    { maxSubjectLength: 80 },
  );
  assert.equal(lax.length, 0);
});

test('summariseCommitGate: counts by severity and decides blocking', () => {
  const findings = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'feat: do x.', message: 'feat: do x.' }, // warning
    { sha: 'b', shortSha: 'b', subject: 'WIP', message: 'WIP' }, // error
  ]);
  const sErr = summariseCommitGate(findings, 5, 'error');
  assert.equal(sErr.totalCommits, 5);
  assert.equal(sErr.commitsWithErrors, 1);
  assert.equal(sErr.commitsWithWarnings, 1);
  assert.equal(sErr.blocking, true);

  const sWarn = summariseCommitGate(findings, 5, 'warning');
  assert.equal(sWarn.blocking, true);

  const sNever = summariseCommitGate(findings, 5, 'never');
  assert.equal(sNever.blocking, false);
});

test('summariseCommitGate: blockAt=error ignores warning-only', () => {
  const findings = lintCommitMessages([
    { sha: 'a', shortSha: 'a', subject: 'feat: do x.', message: 'feat: do x.' }, // warning
  ]);
  const s = summariseCommitGate(findings, 1, 'error');
  assert.equal(s.commitsWithWarnings, 1);
  assert.equal(s.commitsWithErrors, 0);
  assert.equal(s.blocking, false);
});

test('describeCommitGate: pluralisation', () => {
  const oneErr = describeCommitGate({ totalCommits: 1, commitsWithErrors: 1, commitsWithWarnings: 0, totalProblems: 1, blocking: true });
  assert.match(oneErr, /1 commit has/);
  assert.match(oneErr, /1 error/);

  const mixed = describeCommitGate({ totalCommits: 5, commitsWithErrors: 2, commitsWithWarnings: 3, totalProblems: 10, blocking: true });
  assert.match(mixed, /5 commits have/);
  assert.match(mixed, /2 errors/);
  assert.match(mixed, /3 warnings/);
});

test('describeCommitGate: clean state', () => {
  const s = describeCommitGate({ totalCommits: 3, commitsWithErrors: 0, commitsWithWarnings: 0, totalProblems: 0, blocking: false });
  assert.match(s, /clean/);
});

test('parseCommitMessageLog: one commit, no body', () => {
  const raw = 'a1\na1\nfeat: subject\n\x1e';
  const out = parseCommitMessageLog(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, 'a1');
  assert.equal(out[0].subject, 'feat: subject');
  assert.equal(out[0].message, 'feat: subject');
});

test('parseCommitMessageLog: one commit with body', () => {
  const raw = 'a1\na1\nfeat: subject\nbody line one\nbody line two\n\x1e';
  const out = parseCommitMessageLog(raw);
  assert.equal(out[0].message, 'feat: subject\n\nbody line one\nbody line two');
});

test('parseCommitMessageLog: multiple commits', () => {
  const raw = 'a1\na1\nfeat: first\n\x1eb2\nb2\nfeat: second\n\x1e';
  const out = parseCommitMessageLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].subject, 'feat: first');
  assert.equal(out[1].subject, 'feat: second');
});

test('parseCommitMessageLog: empty input', () => {
  assert.deepEqual(parseCommitMessageLog(''), []);
});

test('parseCommitMessageLog: subject containing |', () => {
  const raw = 'a1\na1\nfeat: handle a|b|c case\n\x1e';
  const out = parseCommitMessageLog(raw);
  assert.equal(out[0].subject, 'feat: handle a|b|c case');
});
