import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parsePrTimeline,
  findLatestReview,
  commitsSinceLastReview,
  commentsSinceLastReview,
  summariseTimeline,
  glyphForPillState,
  describeTimeline,
  PrTimeline,
} from '../../src/git/prTimeline';

function mk(over: Partial<PrTimeline> = {}): PrTimeline {
  return {
    number: 42,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: '',
    pendingReviewers: [],
    baseRefName: 'main',
    updatedAt: '2026-06-22T00:00:00Z',
    commits: [],
    reviews: [],
    comments: [],
    ...over,
  };
}

// ── parsePrTimeline ───────────────────────────────────────────────

test('parsePrTimeline: empty/garbage', () => {
  assert.equal(parsePrTimeline(''), undefined);
  assert.equal(parsePrTimeline('not json'), undefined);
});

test('parsePrTimeline: minimal', () => {
  const t = parsePrTimeline('{"number":42,"state":"OPEN"}')!;
  assert.equal(t.number, 42);
  assert.equal(t.state, 'OPEN');
});

test('parsePrTimeline: state lowercase normalisation', () => {
  const t = parsePrTimeline('{"number":1,"state":"merged"}')!;
  assert.equal(t.state, 'MERGED');
});

test('parsePrTimeline: missing arrays default to []', () => {
  const t = parsePrTimeline('{"number":1}')!;
  assert.deepEqual(t.commits, []);
  assert.deepEqual(t.reviews, []);
});

test('parsePrTimeline: review-request normalisation user', () => {
  const t = parsePrTimeline(JSON.stringify({
    number: 1,
    reviewRequests: [{ login: 'alice' }, { slug: 'security', organization: { login: 'foo' } }],
  }))!;
  assert.deepEqual(t.pendingReviewers, ['alice', 'foo/security']);
});

test('parsePrTimeline: commit shape A (top-level fields)', () => {
  const t = parsePrTimeline(JSON.stringify({
    number: 1,
    commits: [{ oid: 'abc', authoredDate: '2026-06-20T00:00:00Z', messageHeadline: 'fix: thing' }],
  }))!;
  assert.equal(t.commits.length, 1);
  assert.equal(t.commits[0].messageHeadline, 'fix: thing');
});

test('parsePrTimeline: commit shape B (nested commit object)', () => {
  const t = parsePrTimeline(JSON.stringify({
    number: 1,
    commits: [{ commit: { oid: 'xyz', authoredDate: '2026-06-21T00:00:00Z', messageHeadline: 'feat: new' } }],
  }))!;
  assert.equal(t.commits[0].oid, 'xyz');
});

test('parsePrTimeline: invalid commits dropped (missing date)', () => {
  const t = parsePrTimeline(JSON.stringify({
    number: 1,
    commits: [{ oid: 'a' }, { oid: 'b', authoredDate: '2026-06-20T00:00:00Z' }],
  }))!;
  assert.equal(t.commits.length, 1);
});

test('parsePrTimeline: mergeable conflicting', () => {
  const t = parsePrTimeline('{"number":1,"mergeable":"CONFLICTING"}')!;
  assert.equal(t.mergeable, 'CONFLICTING');
});

test('parsePrTimeline: reviewDecision normalisation rejects unknown', () => {
  const t = parsePrTimeline('{"number":1,"reviewDecision":"WHATEVER"}')!;
  assert.equal(t.reviewDecision, '');
});

// ── findLatestReview ──────────────────────────────────────────────

test('findLatestReview: empty', () => {
  assert.equal(findLatestReview(mk()), undefined);
});

test('findLatestReview: returns most recent non-pending review', () => {
  const t = mk({
    reviews: [
      { authorLogin: 'a', state: 'APPROVED', submittedAt: '2026-06-10T00:00:00Z' },
      { authorLogin: 'b', state: 'COMMENTED', submittedAt: '2026-06-15T00:00:00Z' },
    ],
  });
  assert.equal(findLatestReview(t)?.authorLogin, 'b');
});

test('findLatestReview: ignores PENDING and DISMISSED', () => {
  const t = mk({
    reviews: [
      { authorLogin: 'a', state: 'APPROVED', submittedAt: '2026-06-10T00:00:00Z' },
      { authorLogin: 'b', state: 'PENDING', submittedAt: '2026-06-20T00:00:00Z' },
      { authorLogin: 'c', state: 'DISMISSED', submittedAt: '2026-06-25T00:00:00Z' },
    ],
  });
  assert.equal(findLatestReview(t)?.authorLogin, 'a');
});

// ── commitsSinceLastReview ────────────────────────────────────────

test('commitsSinceLastReview: no reviews -> all commits returned', () => {
  const t = mk({
    commits: [
      { oid: '1', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' },
      { oid: '2', authoredDate: '2026-06-15T00:00:00Z', messageHeadline: 'b' },
    ],
  });
  assert.equal(commitsSinceLastReview(t).length, 2);
});

test('commitsSinceLastReview: commits before review excluded', () => {
  const t = mk({
    commits: [
      { oid: 'old', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' },
      { oid: 'new', authoredDate: '2026-06-20T00:00:00Z', messageHeadline: 'b' },
    ],
    reviews: [{ authorLogin: 'r', state: 'APPROVED', submittedAt: '2026-06-15T00:00:00Z' }],
  });
  const after = commitsSinceLastReview(t);
  assert.equal(after.length, 1);
  assert.equal(after[0].oid, 'new');
});

test('commitsSinceLastReview: empty when no commits after review', () => {
  const t = mk({
    commits: [{ oid: 'old', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' }],
    reviews: [{ authorLogin: 'r', state: 'APPROVED', submittedAt: '2026-06-15T00:00:00Z' }],
  });
  assert.equal(commitsSinceLastReview(t).length, 0);
});

// ── commentsSinceLastReview ───────────────────────────────────────

test('commentsSinceLastReview: comments newer than latest review', () => {
  const t = mk({
    reviews: [{ authorLogin: 'r', state: 'APPROVED', submittedAt: '2026-06-15T00:00:00Z' }],
    comments: [
      { authorLogin: 'x', createdAt: '2026-06-10T00:00:00Z' },
      { authorLogin: 'y', createdAt: '2026-06-20T00:00:00Z' },
    ],
  });
  assert.equal(commentsSinceLastReview(t).length, 1);
});

test('commentsSinceLastReview: no reviews -> all comments', () => {
  const t = mk({
    comments: [
      { authorLogin: 'x', createdAt: '2026-06-10T00:00:00Z' },
      { authorLogin: 'y', createdAt: '2026-06-20T00:00:00Z' },
    ],
  });
  assert.equal(commentsSinceLastReview(t).length, 2);
});

// ── summariseTimeline ─────────────────────────────────────────────

test('summariseTimeline: draft -> draft state', () => {
  const r = summariseTimeline(mk({ isDraft: true }));
  assert.equal(r.state, 'draft');
  assert.ok(r.pillLabel.includes('#42 draft'));
});

test('summariseTimeline: conflicts wins over other rules', () => {
  const r = summariseTimeline(mk({
    mergeable: 'CONFLICTING',
    reviewDecision: 'APPROVED',
  }));
  assert.equal(r.state, 'conflicts');
});

test('summariseTimeline: CHANGES_REQUESTED', () => {
  const r = summariseTimeline(mk({ reviewDecision: 'CHANGES_REQUESTED' }));
  assert.equal(r.state, 'changes-requested');
});

test('summariseTimeline: commits-since-review when there was a prior review', () => {
  const r = summariseTimeline(mk({
    commits: [
      { oid: 'old', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' },
      { oid: 'new', authoredDate: '2026-06-20T00:00:00Z', messageHeadline: 'b' },
    ],
    reviews: [{ authorLogin: 'r', state: 'APPROVED', submittedAt: '2026-06-15T00:00:00Z' }],
  }));
  assert.equal(r.state, 'commits-since-review');
  assert.ok(r.pillLabel.includes('+1'));
});

test('summariseTimeline: no prior review + commits -> NOT commits-since-review', () => {
  const r = summariseTimeline(mk({
    commits: [{ oid: 'one', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' }],
    pendingReviewers: ['alice'],
  }));
  assert.equal(r.state, 'review-needed');
});

test('summariseTimeline: APPROVED + no new commits -> ready', () => {
  const r = summariseTimeline(mk({
    reviewDecision: 'APPROVED',
    commits: [{ oid: 'old', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' }],
    reviews: [{ authorLogin: 'r', state: 'APPROVED', submittedAt: '2026-06-15T00:00:00Z' }],
  }));
  assert.equal(r.state, 'ready');
  assert.ok(r.pillLabel.includes('ready'));
});

test('summariseTimeline: REVIEW_REQUIRED + pending reviewers -> waiting label', () => {
  const r = summariseTimeline(mk({
    reviewDecision: 'REVIEW_REQUIRED',
    pendingReviewers: ['alice', 'bob'],
  }));
  assert.equal(r.state, 'review-needed');
  assert.ok(r.pillLabel.includes('waiting on 2'));
});

test('summariseTimeline: state=MERGED -> unknown pill', () => {
  const r = summariseTimeline(mk({ state: 'MERGED' }));
  assert.equal(r.state, 'unknown');
  assert.ok(r.pillLabel.includes('merged'));
});

test('summariseTimeline: counts surface in result', () => {
  const r = summariseTimeline(mk({
    commits: [
      { oid: 'old', authoredDate: '2026-06-10T00:00:00Z', messageHeadline: 'a' },
      { oid: 'new', authoredDate: '2026-06-20T00:00:00Z', messageHeadline: 'b' },
    ],
    reviews: [{ authorLogin: 'r', state: 'APPROVED', submittedAt: '2026-06-15T00:00:00Z' }],
    pendingReviewers: ['alice'],
  }));
  assert.equal(r.counts.commitsSinceLastReview, 1);
  assert.equal(r.counts.totalCommits, 2);
  assert.equal(r.counts.totalReviews, 1);
  assert.equal(r.counts.pendingReviewers, 1);
});

test('summariseTimeline: open with no reviewers and no review decision -> unknown', () => {
  const r = summariseTimeline(mk());
  assert.equal(r.state, 'unknown');
});

// ── glyphForPillState ─────────────────────────────────────────────

test('glyphForPillState: each state has a glyph', () => {
  const states = ['ready', 'review-needed', 'commits-since-review', 'conflicts', 'changes-requested', 'draft', 'unknown'] as const;
  for (const s of states) {
    const g = glyphForPillState(s);
    assert.ok(g && g.length > 0, `glyph for ${s} should exist`);
  }
});

// ── describeTimeline (tooltip body) ───────────────────────────────

test('describeTimeline: includes base + mergeable + counts', () => {
  const t = mk({
    commits: [{ oid: '1', authoredDate: '2026-06-20T00:00:00Z', messageHeadline: 'a' }],
    pendingReviewers: ['alice'],
  });
  const s = summariseTimeline(t);
  const md = describeTimeline(t, s);
  assert.ok(md.includes('PR #42'));
  assert.ok(md.includes('Base: `main`'));
  assert.ok(md.includes('Pending reviewers: alice'));
});

test('describeTimeline: omits "commits since last review" when zero', () => {
  const md = describeTimeline(mk(), summariseTimeline(mk()));
  assert.ok(!md.includes('Commits since last review'));
});
