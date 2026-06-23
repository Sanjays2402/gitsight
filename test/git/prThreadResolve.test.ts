import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseReviewThreads,
  selectResolvable,
  describeThreadLabel,
  describeThreadDescription,
  describeThreadsSummary,
  buildResolveMutation,
  classifyResolveResponse,
  MAX_BATCH,
} from '../../src/git/prThreadResolve';

// ── parseReviewThreads ────────────────────────────────────────────

test('parseReviewThreads: empty / garbage returns empty', () => {
  assert.deepEqual(parseReviewThreads(''), []);
  assert.deepEqual(parseReviewThreads('   '), []);
  assert.deepEqual(parseReviewThreads('null'), []);
  assert.deepEqual(parseReviewThreads('not json'), []);
  assert.deepEqual(parseReviewThreads('[]'), []);
  assert.deepEqual(parseReviewThreads('{}'), []);
});

test('parseReviewThreads: parses gh JSON shape with nodes wrapper', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      {
        id: 'PRT_kwDOABC1',
        isResolved: false,
        isOutdated: false,
        path: 'src/git/foo.ts',
        line: 42,
        comments: { nodes: [
          { author: { login: 'alice' }, body: 'this is odd', createdAt: '2026-06-22T01:00:00Z' },
          { author: { login: 'bob' }, body: 'I agree', createdAt: '2026-06-22T02:00:00Z' },
        ] },
      },
    ],
  });
  const t = parseReviewThreads(raw);
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'PRT_kwDOABC1');
  assert.equal(t[0].path, 'src/git/foo.ts');
  assert.equal(t[0].line, 42);
  assert.equal(t[0].comments.length, 2);
  assert.equal(t[0].comments[1].author, 'bob');
});

test('parseReviewThreads: parses comments-as-bare-array fallback', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      {
        id: 'PRT_1',
        isResolved: true,
        comments: [
          { user: { login: 'old' }, body: 'old', created_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ],
  });
  const t = parseReviewThreads(raw);
  assert.equal(t.length, 1);
  assert.equal(t[0].comments[0].author, 'old');
});

test('parseReviewThreads: drops threads without an id', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      { isResolved: false, comments: { nodes: [] } },
      { id: '', isResolved: false },
      { id: 'PRT_X', isResolved: false, comments: { nodes: [] } },
    ],
  });
  const t = parseReviewThreads(raw);
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'PRT_X');
});

test('parseReviewThreads: missing reviewThreads key returns empty', () => {
  assert.deepEqual(parseReviewThreads('{"other": 1}'), []);
});

test('parseReviewThreads: tolerates numeric line as string', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      { id: 'PRT_1', isResolved: false, line: '17', comments: { nodes: [] } },
    ],
  });
  const t = parseReviewThreads(raw);
  assert.equal(t[0].line, 17);
});

test('parseReviewThreads: skips negative / zero line', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      { id: 'PRT_1', isResolved: false, line: 0, comments: { nodes: [] } },
      { id: 'PRT_2', isResolved: false, line: -1, comments: { nodes: [] } },
    ],
  });
  const t = parseReviewThreads(raw);
  assert.equal(t[0].line, undefined);
  assert.equal(t[1].line, undefined);
});

// ── selectResolvable ──────────────────────────────────────────────

test('selectResolvable: drops resolved threads', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      { id: 'a', isResolved: true, comments: { nodes: [] } },
      { id: 'b', isResolved: false, comments: { nodes: [] } },
    ],
  });
  const t = parseReviewThreads(raw);
  const sel = selectResolvable(t);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].id, 'b');
});

test('selectResolvable: outdated sink to bottom', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      { id: 'old', isResolved: false, isOutdated: true, comments: { nodes: [{ author: { login: 'a' }, body: 'x', createdAt: '2026-06-22T05:00:00Z' }] } },
      { id: 'new', isResolved: false, isOutdated: false, comments: { nodes: [{ author: { login: 'a' }, body: 'x', createdAt: '2026-06-22T03:00:00Z' }] } },
    ],
  });
  const t = parseReviewThreads(raw);
  const sel = selectResolvable(t);
  assert.equal(sel.length, 2);
  assert.equal(sel[0].id, 'new');
  assert.equal(sel[1].id, 'old');
});

test('selectResolvable: within tier, newest comment first', () => {
  const raw = JSON.stringify({
    reviewThreads: [
      { id: 'older', isResolved: false, comments: { nodes: [{ author: { login: 'a' }, body: 'x', createdAt: '2026-06-20T00:00:00Z' }] } },
      { id: 'newer', isResolved: false, comments: { nodes: [{ author: { login: 'a' }, body: 'x', createdAt: '2026-06-22T00:00:00Z' }] } },
      { id: 'middle', isResolved: false, comments: { nodes: [{ author: { login: 'a' }, body: 'x', createdAt: '2026-06-21T00:00:00Z' }] } },
    ],
  });
  const sel = selectResolvable(parseReviewThreads(raw));
  assert.deepEqual(sel.map(t => t.id), ['newer', 'middle', 'older']);
});

// ── describeThreadLabel ───────────────────────────────────────────

test('describeThreadLabel: file:line + last author', () => {
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [{
      id: 'a', isResolved: false, path: 'src/foo.ts', line: 42,
      comments: { nodes: [{ author: { login: 'alice' }, body: 'this looks wrong', createdAt: '2026-06-22T00:00:00Z' }] },
    }],
  }))[0];
  const label = describeThreadLabel(t);
  assert.ok(label.includes('src/foo.ts:42'));
  assert.ok(label.includes('alice'));
  assert.ok(label.includes('this looks wrong'));
});

test('describeThreadLabel: truncates long bodies', () => {
  const longBody = 'x'.repeat(200);
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [{
      id: 'a', isResolved: false, path: 'p',
      comments: { nodes: [{ author: { login: 'a' }, body: longBody, createdAt: '2026-06-22T00:00:00Z' }] },
    }],
  }))[0];
  const label = describeThreadLabel(t);
  assert.ok(label.length < 200);
  assert.ok(label.includes('\u2026'));
});

test('describeThreadLabel: handles missing path / line / body', () => {
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [{ id: 'a', isResolved: false, comments: { nodes: [] } }],
  }))[0];
  const label = describeThreadLabel(t);
  assert.ok(label.includes('thread'));
  assert.ok(label.includes('unknown'));
  assert.ok(label.includes('(no body)'));
});

// ── describeThreadDescription ─────────────────────────────────────

test('describeThreadDescription: comment count', () => {
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [{ id: 'a', isResolved: false, comments: { nodes: [
      { author: { login: 'a' }, body: 'x', createdAt: '2026-06-22T00:00:00Z' },
      { author: { login: 'b' }, body: 'y', createdAt: '2026-06-22T01:00:00Z' },
    ] } }],
  }))[0];
  assert.equal(describeThreadDescription(t), '2 comments');
});

test('describeThreadDescription: outdated flag appears', () => {
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [{ id: 'a', isResolved: false, isOutdated: true, comments: { nodes: [
      { author: { login: 'a' }, body: 'x', createdAt: '2026-06-22T00:00:00Z' },
    ] } }],
  }))[0];
  assert.ok(describeThreadDescription(t).includes('outdated'));
});

// ── describeThreadsSummary ────────────────────────────────────────

test('describeThreadsSummary: counts and resolvable / outdated breakdown', () => {
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [
      { id: 'a', isResolved: false, isOutdated: false, comments: { nodes: [] } },
      { id: 'b', isResolved: false, isOutdated: true, comments: { nodes: [] } },
      { id: 'c', isResolved: true, isOutdated: false, comments: { nodes: [] } },
    ],
  }));
  const s = describeThreadsSummary(t);
  assert.ok(s.includes('3 threads'));
  assert.ok(s.includes('1 resolvable'));
  assert.ok(s.includes('1 outdated'));
});

test('describeThreadsSummary: all resolved hint', () => {
  const t = parseReviewThreads(JSON.stringify({
    reviewThreads: [
      { id: 'a', isResolved: true, comments: { nodes: [] } },
      { id: 'b', isResolved: true, comments: { nodes: [] } },
    ],
  }));
  assert.ok(describeThreadsSummary(t).includes('all resolved'));
});

// ── buildResolveMutation ──────────────────────────────────────────

test('buildResolveMutation: empty input returns empty string', () => {
  assert.equal(buildResolveMutation([]), '');
  assert.equal(buildResolveMutation(['', '']), '');
});

test('buildResolveMutation: single id uses bare form', () => {
  const m = buildResolveMutation(['PRT_kwDOABC1']);
  assert.ok(m.includes('resolveReviewThread(input: {threadId: "PRT_kwDOABC1"})'));
  assert.ok(!m.includes('t0:'));
});

test('buildResolveMutation: multi-id uses aliased mutations', () => {
  const m = buildResolveMutation(['PRT_1', 'PRT_2', 'PRT_3']);
  assert.ok(m.startsWith('mutation {'));
  assert.ok(m.includes('t0: resolveReviewThread'));
  assert.ok(m.includes('t1: resolveReviewThread'));
  assert.ok(m.includes('t2: resolveReviewThread'));
  assert.ok(m.trimEnd().endsWith('}'));
});

test('buildResolveMutation: caps batch at MAX_BATCH', () => {
  const ids = Array.from({ length: MAX_BATCH + 10 }, (_, i) => `PRT_${i}`);
  const m = buildResolveMutation(ids);
  const matches = m.match(/t\d+: resolveReviewThread/g) || [];
  assert.equal(matches.length, MAX_BATCH);
});

test('buildResolveMutation: escapes embedded quotes in ids', () => {
  const m = buildResolveMutation(['PRT_"weird"']);
  assert.ok(m.includes('"PRT_\\"weird\\""'));
});

test('buildResolveMutation: drops empty / non-string ids', () => {
  const m = buildResolveMutation(['', 'PRT_1', '', 'PRT_2'] as any);
  assert.ok(m.includes('"PRT_1"'));
  assert.ok(m.includes('"PRT_2"'));
});

// ── classifyResolveResponse ───────────────────────────────────────

test('classifyResolveResponse: every id resolved -> all', () => {
  const raw = JSON.stringify({
    data: {
      t0: { thread: { id: 'a', isResolved: true } },
      t1: { thread: { id: 'b', isResolved: true } },
    },
  });
  const s = classifyResolveResponse(raw, ['a', 'b']);
  assert.equal(s.outcome, 'all');
  assert.deepEqual(s.resolvedIds.sort(), ['a', 'b']);
  assert.deepEqual(s.failedIds, []);
});

test('classifyResolveResponse: single-form (no alias)', () => {
  const raw = JSON.stringify({
    data: { resolveReviewThread: { thread: { id: 'a', isResolved: true } } },
  });
  const s = classifyResolveResponse(raw, ['a']);
  assert.equal(s.outcome, 'all');
  assert.deepEqual(s.resolvedIds, ['a']);
});

test('classifyResolveResponse: nothing resolved -> none', () => {
  const raw = JSON.stringify({ data: null, errors: [{ message: 'permission denied' }] });
  const s = classifyResolveResponse(raw, ['a', 'b']);
  assert.equal(s.outcome, 'none');
  assert.deepEqual(s.resolvedIds, []);
  assert.deepEqual(s.failedIds.sort(), ['a', 'b']);
  assert.ok(s.errorMessages.includes('permission denied'));
});

test('classifyResolveResponse: partial -> some resolved, some failed', () => {
  const raw = JSON.stringify({
    data: {
      t0: { thread: { id: 'a', isResolved: true } },
      t1: { thread: { id: 'b', isResolved: false } },
    },
    errors: [{ message: 'thread b is locked' }],
  });
  const s = classifyResolveResponse(raw, ['a', 'b']);
  assert.equal(s.outcome, 'partial');
  assert.deepEqual(s.resolvedIds, ['a']);
  assert.deepEqual(s.failedIds, ['b']);
  assert.ok(s.errorMessages[0].includes('locked'));
});

test('classifyResolveResponse: non-JSON response -> none + error', () => {
  const s = classifyResolveResponse('boom', ['a']);
  assert.equal(s.outcome, 'none');
  assert.deepEqual(s.failedIds, ['a']);
  assert.ok(s.errorMessages[0].includes('not JSON'));
});

test('classifyResolveResponse: empty requested ids returns none with no churn', () => {
  const s = classifyResolveResponse('{}', []);
  assert.equal(s.outcome, 'none');
  assert.deepEqual(s.resolvedIds, []);
  assert.deepEqual(s.failedIds, []);
});

test('classifyResolveResponse: isResolved=false treated as not resolved', () => {
  const raw = JSON.stringify({
    data: { t0: { thread: { id: 'a', isResolved: false } } },
  });
  const s = classifyResolveResponse(raw, ['a']);
  assert.equal(s.outcome, 'none');
  assert.deepEqual(s.failedIds, ['a']);
});
