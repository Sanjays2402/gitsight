import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseIssueList,
  sortIssuesForPicker,
  describeIssueLabel,
  describeIssueDetail,
  formatCursorReference,
  appendIssueTrailer,
  appendIssueTrailerToScmInput,
  formatMarkdownLink,
  ISSUE_TRAILER_KINDS,
  IssueEntry,
} from '../../src/git/issueInsert';

function mkIssue(n: number, opts: Partial<IssueEntry> = {}): IssueEntry {
  return {
    number: n,
    title: opts.title ?? `Issue ${n}`,
    state: opts.state ?? 'OPEN',
    url: opts.url ?? `https://github.com/foo/bar/issues/${n}`,
    labels: opts.labels ?? [],
    authorLogin: opts.authorLogin ?? 'octocat',
    assignees: opts.assignees ?? [],
    updatedAt: opts.updatedAt ?? '2026-06-01T00:00:00Z',
    isPullRequest: opts.isPullRequest,
  };
}

test('parseIssueList: empty input', () => {
  assert.deepEqual(parseIssueList(''), []);
  assert.deepEqual(parseIssueList('not json'), []);
  assert.deepEqual(parseIssueList('"a string"'), []);
});

test('parseIssueList: drops rows without a valid number', () => {
  const raw = JSON.stringify([
    { number: 0, title: 'zero', state: 'OPEN' },
    { number: 5, title: 'real', state: 'OPEN' },
    { title: 'no number', state: 'OPEN' },
  ]);
  const out = parseIssueList(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 5);
});

test('parseIssueList: extracts labels from objects and strings', () => {
  const raw = JSON.stringify([
    { number: 1, title: 't', state: 'OPEN', labels: [{ name: 'bug' }, { name: 'p1' }] },
    { number: 2, title: 't', state: 'OPEN', labels: ['enhancement'] },
  ]);
  const out = parseIssueList(raw);
  assert.deepEqual(out[0].labels, ['bug', 'p1']);
  assert.deepEqual(out[1].labels, ['enhancement']);
});

test('parseIssueList: extracts author from {login} OR string', () => {
  const raw = JSON.stringify([
    { number: 1, title: 't', state: 'OPEN', author: { login: 'alice' } },
    { number: 2, title: 't', state: 'OPEN', author: 'bob' },
    { number: 3, title: 't', state: 'OPEN' },
  ]);
  const out = parseIssueList(raw);
  assert.equal(out[0].authorLogin, 'alice');
  assert.equal(out[1].authorLogin, 'bob');
  assert.equal(out[2].authorLogin, '');
});

test('parseIssueList: normalises state to OPEN or CLOSED', () => {
  const raw = JSON.stringify([
    { number: 1, title: 'a', state: 'open' },
    { number: 2, title: 'b', state: 'closed' },
    { number: 3, title: 'c', state: 'WEIRD' },
  ]);
  const out = parseIssueList(raw);
  assert.equal(out[0].state, 'OPEN');
  assert.equal(out[1].state, 'CLOSED');
  assert.equal(out[2].state, 'OPEN'); // unknown -> OPEN (safer default)
});

test('parseIssueList: extracts assignees', () => {
  const raw = JSON.stringify([
    { number: 1, title: 't', state: 'OPEN', assignees: [{ login: 'a' }, { login: 'b' }] },
  ]);
  const out = parseIssueList(raw);
  assert.deepEqual(out[0].assignees, ['a', 'b']);
});

test('parseIssueList: tolerates missing labels/assignees arrays', () => {
  const raw = JSON.stringify([{ number: 1, title: 't', state: 'OPEN' }]);
  const out = parseIssueList(raw);
  assert.deepEqual(out[0].labels, []);
  assert.deepEqual(out[0].assignees, []);
});

test('sortIssuesForPicker: OPEN before CLOSED', () => {
  const a = mkIssue(1, { state: 'CLOSED', updatedAt: '2026-06-10T00:00:00Z' });
  const b = mkIssue(2, { state: 'OPEN',   updatedAt: '2026-06-01T00:00:00Z' });
  const sorted = sortIssuesForPicker([a, b]);
  assert.deepEqual(sorted.map(i => i.number), [2, 1]);
});

test('sortIssuesForPicker: within state, most-recent first', () => {
  const a = mkIssue(1, { updatedAt: '2026-06-01T00:00:00Z' });
  const b = mkIssue(2, { updatedAt: '2026-06-05T00:00:00Z' });
  const c = mkIssue(3, { updatedAt: '2026-06-03T00:00:00Z' });
  const sorted = sortIssuesForPicker([a, b, c]);
  assert.deepEqual(sorted.map(i => i.number), [2, 3, 1]);
});

test('sortIssuesForPicker: PRs sunk to bottom', () => {
  const a = mkIssue(1, { isPullRequest: true });
  const b = mkIssue(2);
  const sorted = sortIssuesForPicker([a, b]);
  assert.deepEqual(sorted.map(i => i.number), [2, 1]);
});

test('sortIssuesForPicker: empty input', () => {
  assert.deepEqual(sortIssuesForPicker([]), []);
});

test('describeIssueLabel: #NN title', () => {
  assert.equal(describeIssueLabel(mkIssue(42, { title: 'Add foo' })), '#42 Add foo');
});

test('describeIssueDetail: closed marker', () => {
  const detail = describeIssueDetail(mkIssue(1, { state: 'CLOSED' }));
  assert.match(detail, /closed/);
});

test('describeIssueDetail: assignee suppresses author', () => {
  const detail = describeIssueDetail(mkIssue(1, { assignees: ['alice'], authorLogin: 'bob' }));
  assert.match(detail, /@alice/);
  assert.doesNotMatch(detail, /by @bob/);
});

test('describeIssueDetail: labels truncated at 3', () => {
  const detail = describeIssueDetail(mkIssue(1, { labels: ['a', 'b', 'c', 'd'] }));
  assert.match(detail, /\[a\] \[b\] \[c\]/);
  assert.doesNotMatch(detail, /\[d\]/);
});

test('formatCursorReference: bare form', () => {
  assert.equal(formatCursorReference(42), '#42');
});

test('formatCursorReference: qualified form needs repoSlug', () => {
  assert.equal(formatCursorReference(42, { qualified: true, repoSlug: 'foo/bar' }), 'foo/bar#42');
  // Qualified without slug falls back to bare.
  assert.equal(formatCursorReference(42, { qualified: true }), '#42');
});

test('appendIssueTrailer: empty body -> just the trailer', () => {
  const r = appendIssueTrailer('', 'Closes', 42);
  assert.equal(r.result, 'Closes: #42');
  assert.equal(r.appended, true);
});

test('appendIssueTrailer: body without trailer -> blank line then trailer', () => {
  const r = appendIssueTrailer('feat: add the thing', 'Closes', 42);
  assert.equal(r.result, 'feat: add the thing\n\nCloses: #42');
});

test('appendIssueTrailer: body with existing trailer -> directly joined', () => {
  const r = appendIssueTrailer(
    'feat: add the thing\n\nSigned-off-by: Alice <alice@example.com>',
    'Closes', 42,
  );
  assert.equal(
    r.result,
    'feat: add the thing\n\nSigned-off-by: Alice <alice@example.com>\nCloses: #42',
  );
});

test('appendIssueTrailer: dedup same kind+number', () => {
  const existing = 'feat: x\n\nCloses: #42';
  const r = appendIssueTrailer(existing, 'Closes', 42);
  assert.equal(r.appended, false);
  assert.equal(r.result, existing);
});

test('appendIssueTrailer: case-insensitive kind for dedup', () => {
  const existing = 'feat: x\n\ncloses: #42';
  const r = appendIssueTrailer(existing, 'Closes', 42);
  assert.equal(r.appended, false);
});

test('appendIssueTrailer: different number is NOT a dedup', () => {
  const existing = 'feat: x\n\nCloses: #42';
  const r = appendIssueTrailer(existing, 'Closes', 99);
  assert.equal(r.appended, true);
  assert.match(r.result, /Closes: #42/);
  assert.match(r.result, /Closes: #99/);
});

test('appendIssueTrailer: comma-separated dedup', () => {
  const existing = 'feat: x\n\nCloses: #42, #43';
  const r = appendIssueTrailer(existing, 'Closes', 42);
  assert.equal(r.appended, false);
});

test('appendIssueTrailer: different kind appends even for same number', () => {
  const existing = 'feat: x\n\nFixes: #42';
  const r = appendIssueTrailer(existing, 'Closes', 42);
  assert.equal(r.appended, true);
  assert.match(r.result, /Fixes: #42/);
  assert.match(r.result, /Closes: #42/);
});

test('appendIssueTrailer: trailing whitespace in body collapses correctly', () => {
  const r = appendIssueTrailer('feat: x\n\n\n', 'Closes', 42);
  assert.equal(r.result, 'feat: x\n\nCloses: #42');
});

test('appendIssueTrailer: qualified form in trailer', () => {
  const r = appendIssueTrailer('feat: x', 'Closes', 42, { qualified: true, repoSlug: 'foo/bar' });
  assert.equal(r.result, 'feat: x\n\nCloses: foo/bar#42');
});

test('appendIssueTrailerToScmInput: thin wrapper preserves trailer logic', () => {
  const r = appendIssueTrailerToScmInput('', 'Fixes', 5);
  assert.equal(r.result, 'Fixes: #5');
});

test('ISSUE_TRAILER_KINDS: all five canonical kinds', () => {
  assert.deepEqual(ISSUE_TRAILER_KINDS, ['Closes', 'Fixes', 'Resolves', 'Refs', 'Related']);
});

test('formatMarkdownLink: bare form', () => {
  const link = formatMarkdownLink(mkIssue(42, { url: 'https://github.com/foo/bar/issues/42' }));
  assert.equal(link, '[#42](https://github.com/foo/bar/issues/42)');
});

test('formatMarkdownLink: qualified form', () => {
  const link = formatMarkdownLink(
    mkIssue(42, { url: 'https://github.com/foo/bar/issues/42' }),
    { qualified: true, repoSlug: 'foo/bar' },
  );
  assert.equal(link, '[foo/bar#42](https://github.com/foo/bar/issues/42)');
});

test('formatMarkdownLink: empty URL still produces the markdown shape', () => {
  const link = formatMarkdownLink(mkIssue(7, { url: '' }));
  assert.equal(link, '[#7]()');
});
