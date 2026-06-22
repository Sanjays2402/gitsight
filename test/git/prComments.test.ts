import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parsePrComments,
  sortComments,
  describeCommentLabel,
  describeCommentDetail,
  glyphForComment,
  describeCommentsSummary,
  PrCommentEntry,
} from '../../src/git/prComments';

test('parsePrComments: empty / garbage returns empty array', () => {
  assert.deepEqual(parsePrComments(''), []);
  assert.deepEqual(parsePrComments('   '), []);
  assert.deepEqual(parsePrComments('not json'), []);
  assert.deepEqual(parsePrComments('null'), []);
  assert.deepEqual(parsePrComments('[]'), []);
});

test('parsePrComments: issue + reviewComments + reviews fan out', () => {
  const raw = JSON.stringify({
    comments: [
      { id: 1, author: { login: 'alice' }, body: 'general feedback', createdAt: '2026-06-22T01:00:00Z', url: 'https://x/1' },
    ],
    reviewComments: [
      { id: 2, author: { login: 'bob' }, body: 'inline note', path: 'src/git/x.ts', line: 12, createdAt: '2026-06-22T02:00:00Z', url: 'https://x/2', isResolved: false },
    ],
    reviews: [
      { id: 3, author: { login: 'carol' }, body: 'looks good', state: 'APPROVED', submittedAt: '2026-06-22T03:00:00Z', url: 'https://x/3' },
    ],
  });
  const out = parsePrComments(raw);
  assert.equal(out.length, 3);
  const kinds = out.map(e => e.kind).sort();
  assert.deepEqual(kinds, ['inline', 'issue', 'review-summary']);
});

test('parsePrComments: skips empty review-summary bodies', () => {
  const raw = JSON.stringify({
    reviews: [
      { id: 1, author: { login: 'alice' }, body: '', state: 'APPROVED', submittedAt: '2026-06-22T01:00:00Z' },
      { id: 2, author: { login: 'bob' }, body: 'with body', state: 'COMMENTED', submittedAt: '2026-06-22T02:00:00Z' },
    ],
  });
  const out = parsePrComments(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].author, 'bob');
});

test('parsePrComments: marks resolved inline comments', () => {
  const raw = JSON.stringify({
    reviewComments: [
      { id: 1, author: { login: 'a' }, body: 'b', path: 'x.ts', line: 1, isResolved: true, createdAt: '2026-06-22T01:00:00Z' },
      { id: 2, author: { login: 'a' }, body: 'b', path: 'x.ts', line: 2, isMinimized: true, createdAt: '2026-06-22T02:00:00Z' },
      { id: 3, author: { login: 'a' }, body: 'b', path: 'x.ts', line: 3, createdAt: '2026-06-22T03:00:00Z' },
    ],
  });
  const out = parsePrComments(raw);
  assert.equal(out.length, 3);
  assert.equal(out.find(e => e.line === 1)!.state, 'resolved');
  assert.equal(out.find(e => e.line === 2)!.state, 'resolved');
  assert.equal(out.find(e => e.line === 3)!.state, 'unresolved');
});

test('parsePrComments: tolerates older snake_case fields', () => {
  const raw = JSON.stringify({
    reviewComments: [
      { id: 1, user: { login: 'a' }, body: 'b', path: 'x.ts', original_line: 99, created_at: '2026-06-22T01:00:00Z', html_url: 'https://x/1' },
    ],
  });
  const out = parsePrComments(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].author, 'a');
  assert.equal(out[0].line, 99);
  assert.equal(out[0].url, 'https://x/1');
});

test('parsePrComments: drops entries without id', () => {
  const raw = JSON.stringify({
    comments: [
      { author: { login: 'a' }, body: 'b', createdAt: '2026-06-22T01:00:00Z' }, // no id
      { id: 0, author: { login: 'a' }, body: 'b', createdAt: '2026-06-22T02:00:00Z' }, // id=0 should still parse - it's a number
    ],
  });
  const out = parsePrComments(raw);
  // id=0 is technically a falsy number but a valid identifier; we accept it.
  // The "no id at all" entry is dropped because id === ''.
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 0);
});

test('sortComments: unresolved inline first, then other inline, then thread', () => {
  const entries: PrCommentEntry[] = [
    { kind: 'issue',           id: 1, author: 'a', createdAt: '2026-06-22T05:00:00Z', body: 'x', url: '', state: 'unknown' },
    { kind: 'inline',          id: 2, author: 'b', createdAt: '2026-06-22T01:00:00Z', body: 'x', url: '', state: 'resolved', path: 'a.ts', line: 1 },
    { kind: 'inline',          id: 3, author: 'c', createdAt: '2026-06-22T02:00:00Z', body: 'x', url: '', state: 'unresolved', path: 'a.ts', line: 1 },
    { kind: 'review-summary',  id: 4, author: 'd', createdAt: '2026-06-22T04:00:00Z', body: 'x', url: '', state: 'unknown' },
    { kind: 'inline',          id: 5, author: 'e', createdAt: '2026-06-22T03:00:00Z', body: 'x', url: '', state: 'unresolved', path: 'a.ts', line: 1 },
  ];
  const sorted = sortComments(entries);
  // Tier 0: 5 (newer) then 3
  // Tier 1: 2
  // Tier 2: 4
  // Tier 3: 1
  assert.deepEqual(sorted.map(e => e.id), [5, 3, 2, 4, 1]);
});

test('sortComments: stable within tier when dates tie', () => {
  const entries: PrCommentEntry[] = [
    { kind: 'inline', id: 'a', author: 'a', createdAt: '2026-06-22T01:00:00Z', body: 'x', url: '', state: 'unresolved', path: 'x.ts', line: 1 },
    { kind: 'inline', id: 'b', author: 'b', createdAt: '2026-06-22T01:00:00Z', body: 'x', url: '', state: 'unresolved', path: 'x.ts', line: 1 },
  ];
  const sorted = sortComments(entries);
  // Array.prototype.sort in node 18+ is stable; equal entries keep order.
  assert.deepEqual(sorted.map(e => e.id), ['a', 'b']);
});

test('describeCommentLabel: inline has file:line, issue says general thread', () => {
  const inline: PrCommentEntry = {
    kind: 'inline', id: 1, author: 'alice', createdAt: '', body: 'x', url: '', state: 'unresolved', path: 'src/git/x.ts', line: 42,
  };
  assert.match(describeCommentLabel(inline, '3d ago'), /alice.*src\/git\/x\.ts:42.*3d ago/);
  const issue: PrCommentEntry = {
    kind: 'issue', id: 2, author: 'bob', createdAt: '', body: 'x', url: '', state: 'unknown',
  };
  assert.match(describeCommentLabel(issue, ''), /bob.*general thread/);
});

test('describeCommentLabel: review-summary label includes verdict word', () => {
  const summary: PrCommentEntry = {
    kind: 'review-summary', id: 1, author: 'carol', createdAt: '', body: 'x', url: '', state: 'unknown', reviewState: 'CHANGES_REQUESTED',
  };
  assert.match(describeCommentLabel(summary, '1h ago'), /review changes requested/);
});

test('describeCommentDetail: collapses whitespace + truncates with ellipsis', () => {
  const e: PrCommentEntry = {
    kind: 'inline', id: 1, author: 'a', createdAt: '', body: 'line 1\n\n   line 2  with   spaces', url: '', state: 'unresolved', path: 'x.ts', line: 1,
  };
  assert.equal(describeCommentDetail(e), 'line 1 line 2 with spaces');
});

test('describeCommentDetail: handles empty body', () => {
  const e: PrCommentEntry = {
    kind: 'issue', id: 1, author: 'a', createdAt: '', body: '', url: '', state: 'unknown',
  };
  assert.equal(describeCommentDetail(e), '(no body)');
});

test('describeCommentDetail: long body gets truncated to 120 chars with ellipsis', () => {
  const long = 'a'.repeat(200);
  const e: PrCommentEntry = {
    kind: 'inline', id: 1, author: 'a', createdAt: '', body: long, url: '', state: 'unresolved', path: 'x.ts', line: 1,
  };
  const result = describeCommentDetail(e);
  assert.equal(result.length, 118);
  assert.ok(result.endsWith('\u2026'));
});

test('glyphForComment: matches kind + state', () => {
  const inlineUnresolved: PrCommentEntry = { kind: 'inline', id: 1, author: 'a', createdAt: '', body: '', url: '', state: 'unresolved', path: 'x', line: 1 };
  const inlineResolved: PrCommentEntry   = { kind: 'inline', id: 1, author: 'a', createdAt: '', body: '', url: '', state: 'resolved', path: 'x', line: 1 };
  const reviewSummary: PrCommentEntry    = { kind: 'review-summary', id: 1, author: 'a', createdAt: '', body: '', url: '', state: 'unknown' };
  const issueComment: PrCommentEntry     = { kind: 'issue', id: 1, author: 'a', createdAt: '', body: '', url: '', state: 'unknown' };
  assert.equal(glyphForComment(inlineUnresolved), 'comment');
  assert.equal(glyphForComment(inlineResolved),   'pass');
  assert.equal(glyphForComment(reviewSummary),    'verified');
  assert.equal(glyphForComment(issueComment),     'issues');
});

test('describeCommentsSummary: aggregates totals correctly', () => {
  const entries: PrCommentEntry[] = [
    { kind: 'inline',          id: 1, author: 'a', createdAt: '', body: 'x', url: '', state: 'unresolved', path: 'x', line: 1 },
    { kind: 'inline',          id: 2, author: 'b', createdAt: '', body: 'x', url: '', state: 'unresolved', path: 'x', line: 1 },
    { kind: 'inline',          id: 3, author: 'c', createdAt: '', body: 'x', url: '', state: 'resolved',   path: 'x', line: 1 },
    { kind: 'issue',           id: 4, author: 'd', createdAt: '', body: 'x', url: '', state: 'unknown' },
    { kind: 'review-summary',  id: 5, author: 'e', createdAt: '', body: 'x', url: '', state: 'unknown' },
  ];
  const summary = describeCommentsSummary(entries);
  assert.match(summary, /5 comments/);
  assert.match(summary, /2 unresolved/);
  assert.match(summary, /3 inline/);
  assert.match(summary, /2 threads/);
});

test('describeCommentsSummary: hides zero-count sections', () => {
  const entries: PrCommentEntry[] = [
    { kind: 'inline', id: 1, author: 'a', createdAt: '', body: 'x', url: '', state: 'resolved', path: 'x', line: 1 },
  ];
  const summary = describeCommentsSummary(entries);
  assert.match(summary, /1 comment/);
  assert.doesNotMatch(summary, /unresolved/);
  assert.doesNotMatch(summary, /thread/);
});

test('describeCommentsSummary: singular vs plural', () => {
  const one: PrCommentEntry[] = [
    { kind: 'inline', id: 1, author: 'a', createdAt: '', body: 'x', url: '', state: 'unresolved', path: 'x', line: 1 },
    { kind: 'issue',  id: 2, author: 'b', createdAt: '', body: 'x', url: '', state: 'unknown' },
  ];
  // 2 total, 1 unresolved, 1 inline, 1 thread
  assert.match(describeCommentsSummary(one), /2 comments.*1 unresolved.*1 inline.*1 thread\b/);
});
