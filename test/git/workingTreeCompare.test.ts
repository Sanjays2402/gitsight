import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommitPickRows,
  buildFileDiffRows,
  describeStatus,
  formatMarkdownReport,
  parseDiffNameStatus,
  summariseChanges,
  truncate,
} from '../../src/git/workingTreeCompare';
import type { Commit, FileChange } from '../../src/git/git';

const C = (overrides: Partial<Commit> = {}): Commit => ({
  sha: 'abc1234567890abcdef1234567890abcdef12345',
  shortSha: 'abc1234',
  parents: [],
  author: 'Alice',
  email: 'a@a.com',
  date: new Date('2026-06-20T10:00:00Z'),
  subject: 'feat: do a thing',
  body: 'A short body explaining the rationale.',
  refs: [],
  ...overrides,
});

test('truncate: long strings get ellipsis, short strings unchanged', () => {
  assert.equal(truncate('hello', 5), 'hello');
  assert.equal(truncate('hello world', 5), 'hell…');
  assert.equal(truncate('', 10), '');
});

test('describeStatus: known codes', () => {
  assert.equal(describeStatus('M'), 'modified');
  assert.equal(describeStatus('A'), 'added');
  assert.equal(describeStatus('D'), 'deleted');
  assert.equal(describeStatus('R'), 'renamed');
  assert.equal(describeStatus('C'), 'copied');
  assert.equal(describeStatus('T'), 'type-changed');
  assert.equal(describeStatus('?'), 'untracked');
});

test('describeStatus: unknown code passes through', () => {
  assert.equal(describeStatus('X'), 'X');
});

test('buildCommitPickRows: includes shortSha + author + age', () => {
  const ago = (_d: Date) => '2h ago';
  const rows = buildCommitPickRows([C()], ago);
  assert.equal(rows.length, 1);
  assert.match(rows[0].label, /\$\(git-commit\) feat: do a thing/);
  assert.match(rows[0].description, /abc1234.*Alice.*2h ago/);
});

test('buildCommitPickRows: empty body falls back to full sha as detail', () => {
  const rows = buildCommitPickRows([C({ body: '' })], () => 'now');
  assert.equal(rows[0].detail, 'abc1234567890abcdef1234567890abcdef12345');
});

test('buildCommitPickRows: long body line gets truncated', () => {
  const long = 'x'.repeat(200);
  const rows = buildCommitPickRows([C({ body: long })], () => 'now');
  assert.ok(rows[0].detail.length <= 120);
  assert.ok(rows[0].detail.endsWith('…'));
});

test('buildFileDiffRows: icons + label + flags per status', () => {
  const ch: FileChange[] = [
    { status: 'M', path: 'src/a.ts' },
    { status: 'A', path: 'src/b.ts' },
    { status: 'D', path: 'src/c.ts' },
  ];
  const out = buildFileDiffRows(ch);
  assert.match(out[0].label, /diff-modified/);
  assert.equal(out[0].deleted, false);
  assert.equal(out[0].added, false);
  assert.match(out[1].label, /diff-added/);
  assert.equal(out[1].added, true);
  assert.match(out[2].label, /diff-removed/);
  assert.equal(out[2].deleted, true);
  assert.equal(out[1].description, 'added');
});

test('summariseChanges: zero changes', () => {
  assert.equal(summariseChanges('abc1234', []), 'Working tree matches abc1234 — no differences');
});

test('summariseChanges: counts grouped by status with canonical order', () => {
  const out = summariseChanges('abc1234', [
    { status: 'D', path: 'x' },
    { status: 'M', path: 'y' },
    { status: 'A', path: 'z' },
    { status: 'M', path: 'q' },
  ]);
  assert.match(out, /Working tree vs abc1234 — 4 files \(2 modified, 1 added, 1 deleted\)/);
});

test('summariseChanges: singular "file" when exactly one', () => {
  const out = summariseChanges('abc1234', [{ status: 'M', path: 'x' }]);
  assert.match(out, /1 file \(/);
  assert.doesNotMatch(out, /1 files/);
});

test('parseDiffNameStatus: handles M/A/D plus rename arrow', () => {
  const out = parseDiffNameStatus([
    'M\tsrc/a.ts',
    'A\tsrc/b.ts',
    'D\tsrc/c.ts',
    'R100\tsrc/old.ts\tsrc/new.ts',
  ].join('\n'));
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { status: 'M', path: 'src/a.ts' });
  assert.deepEqual(out[1], { status: 'A', path: 'src/b.ts' });
  assert.deepEqual(out[2], { status: 'D', path: 'src/c.ts' });
  assert.deepEqual(out[3], { status: 'R', oldPath: 'src/old.ts', path: 'src/new.ts' });
});

test('parseDiffNameStatus: empty / blank lines safely ignored', () => {
  assert.deepEqual(parseDiffNameStatus(''), []);
  assert.deepEqual(parseDiffNameStatus('\n\n'), []);
  assert.deepEqual(parseDiffNameStatus('garbage-without-tab'), []);
});

test('formatMarkdownReport: header includes subject; body lists files', () => {
  const md = formatMarkdownReport('abc1234', 'feat: do a thing', [
    { status: 'M', path: 'src/a.ts' },
    { status: 'D', path: 'src/b.ts' },
  ]);
  assert.match(md, /# Working tree vs abc1234 \("feat: do a thing"\)/);
  assert.match(md, /\*\*modified\*\* `src\/a\.ts`/);
  assert.match(md, /\*\*deleted\*\* `src\/b\.ts`/);
});

test('formatMarkdownReport: empty changes shows "no differences" body', () => {
  const md = formatMarkdownReport('abc1234', 'feat: x', []);
  assert.match(md, /_No differences/);
});

test('formatMarkdownReport: escapes double quotes in subject', () => {
  const md = formatMarkdownReport('abc1234', 'fix the "broken" thing', [
    { status: 'M', path: 'a.ts' },
  ]);
  assert.match(md, /\\"broken\\"/);
});
