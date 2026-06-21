import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseWalkLog,
  walkOrder,
  summariseRun,
  renderReport,
  formatMs,
  tailLines,
  RawCommit,
  RunResult,
} from '../../src/git/commitWalk';

function c(sha: string, subject: string, author = 'Cake', email = 'cake@example.com'): RawCommit {
  return { sha: sha + 'ffff', shortSha: sha, subject, author, authorEmail: email };
}

test('parseWalkLog: handles five-field rows', () => {
  const raw =
    'aaaaaaa|aaaaaa|Alice|alice@example.com|fix(parser): handle empty subjects\n' +
    'bbbbbbb|bbbbbb|Bob|bob@example.com|refactor(lexer): rename token kind\n';
  const out = parseWalkLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].author, 'Alice');
  assert.equal(out[0].subject, 'fix(parser): handle empty subjects');
});

test('parseWalkLog: subject containing | is preserved', () => {
  const raw = 'aaaaaaa|aaaaaa|Alice|alice@example.com|feat(x): a | b | c\n';
  const out = parseWalkLog(raw);
  assert.equal(out[0].subject, 'feat(x): a | b | c');
});

test('parseWalkLog: rows with fewer than 5 fields are skipped', () => {
  const out = parseWalkLog('garbage\naaaaaaa|aaaaaa|x\n');
  assert.equal(out.length, 0);
});

test('walkOrder: reverses newest-first into oldest-first', () => {
  const log = [c('aaaaaaa', 'new'), c('bbbbbbb', 'mid'), c('ccccccc', 'old')];
  const order = walkOrder(log);
  assert.equal(order[0].shortSha, 'ccccccc');
  assert.equal(order[2].shortSha, 'aaaaaaa');
  // Original list is not mutated.
  assert.equal(log[0].shortSha, 'aaaaaaa');
});

test('summariseRun: simple counts', () => {
  const r: RunResult[] = [
    { sha: 'a', status: 'pass' },
    { sha: 'b', status: 'pass' },
    { sha: 'c', status: 'fail', exitCode: 1 },
    { sha: 'd', status: 'fail', exitCode: 1 },
    { sha: 'e', status: 'skipped' },
    { sha: 'f', status: 'error', reason: 'checkout failed' },
  ];
  const s = summariseRun(r);
  assert.equal(s.total, 6);
  assert.equal(s.passed, 2);
  assert.equal(s.failed, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.errored, 1);
});

test('summariseRun: bisect candidate is the first failing commit after a pass', () => {
  const r: RunResult[] = [
    { sha: 'a', status: 'pass' },
    { sha: 'b', status: 'pass' },
    { sha: 'c', status: 'fail' },  // <- bisect candidate
    { sha: 'd', status: 'fail' },
  ];
  const s = summariseRun(r);
  assert.equal(s.bisectSha, 'c');
  assert.equal(s.firstFailingSha, 'c');
});

test('summariseRun: first failing without a prior pass leaves bisectSha undefined', () => {
  const r: RunResult[] = [
    { sha: 'a', status: 'fail' },
    { sha: 'b', status: 'fail' },
    { sha: 'c', status: 'pass' },  // weird, but possible if upstream itself fails
  ];
  const s = summariseRun(r);
  assert.equal(s.firstFailingSha, 'a');
  assert.equal(s.bisectSha, undefined);
});

test('summariseRun: all-pass and all-fail', () => {
  assert.equal(summariseRun([
    { sha: 'a', status: 'pass' }, { sha: 'b', status: 'pass' },
  ]).failed, 0);
  assert.equal(summariseRun([
    { sha: 'a', status: 'fail' }, { sha: 'b', status: 'fail' },
  ]).passed, 0);
});

test('summariseRun: empty input is fine', () => {
  const s = summariseRun([]);
  assert.equal(s.total, 0);
  assert.equal(s.firstFailingSha, undefined);
});

test('renderReport: includes header, command, summary line', () => {
  const commits = [c('aaaaaaa', 'one'), c('bbbbbbb', 'two')];
  const ordered = walkOrder(commits);
  const md = renderReport(
    ordered,
    [{ sha: ordered[0].sha, status: 'pass', durationMs: 1234 }, { sha: ordered[1].sha, status: 'fail', exitCode: 1, durationMs: 4567 }],
    { upstream: 'origin/main', head: 'HEAD', command: 'npm test' },
  );
  assert.match(md, /# Commit-by-commit test run/);
  assert.match(md, /\*\*Command\*\*:\s*`npm test`/);
  assert.match(md, /1 pass.*1 fail/);
  assert.match(md, /\u2713 pass/);
  assert.match(md, /\u2717 fail/);
});

test('renderReport: failure-details section appears with tail block', () => {
  const commits = [c('aaaaaaa', 'broken')];
  const md = renderReport(commits, [
    { sha: commits[0].sha, status: 'fail', exitCode: 1, durationMs: 12, tail: 'AssertionError: expected 2, got 3' },
  ], { upstream: 'origin/main', head: 'HEAD', command: 'npm test' });
  assert.match(md, /## Failure details/);
  assert.match(md, /AssertionError/);
  assert.match(md, /exit 1/);
});

test('renderReport: bisect candidate gets a "likely culprit" callout', () => {
  const commits = [c('aaaaaaa', 'breaks'), c('bbbbbbb', 'works')];
  const ordered = walkOrder(commits);
  const md = renderReport(
    ordered,
    [{ sha: ordered[0].sha, status: 'pass' }, { sha: ordered[1].sha, status: 'fail', exitCode: 1 }],
    { upstream: 'origin/main', head: 'HEAD', command: 'npm test' },
  );
  assert.match(md, /Likely culprit/);
});

test('renderReport: pipe in subjects is escaped to keep the table valid', () => {
  const commits = [c('aaaaaaa', 'a | b | c')];
  const md = renderReport(commits, [{ sha: commits[0].sha, status: 'pass' }], {
    upstream: 'main', head: 'HEAD', command: 'npm t',
  });
  assert.match(md, /a \\\| b \\\| c/);
});

test('formatMs: ms / s / m formatting', () => {
  assert.equal(formatMs(0), '0ms');
  assert.equal(formatMs(999), '999ms');
  assert.equal(formatMs(1500), '1.5s');
  assert.equal(formatMs(60_000), '1m00s');
  assert.equal(formatMs(125_500), '2m05s');
});

test('tailLines: keeps last N lines, trims trailing whitespace', () => {
  const raw = 'a\nb\nc\nd\ne\n';
  assert.equal(tailLines(raw, 3), 'c\nd\ne');
  assert.equal(tailLines(raw, 10), 'a\nb\nc\nd\ne');
  assert.equal(tailLines('', 5), '');
});
