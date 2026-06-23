import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  shouldOfferReviewSummary,
  buildReviewSummaryPrompt,
  parseReviewSummaryOutput,
  renderReviewSummary,
  REVIEW_SUMMARY_MIN_COMMENTS,
  REVIEW_SUMMARY_SYSTEM_PROMPT,
} from '../../src/git/reviewSummaryAi';
import type { PrCommentEntry } from '../../src/git/prComments';

function mkComment(over: Partial<PrCommentEntry>): PrCommentEntry {
  return {
    kind: 'inline',
    id: Math.floor(Math.random() * 1e9),
    author: 'alice',
    createdAt: '2026-06-22T10:00:00Z',
    body: 'looks good',
    url: 'https://github.com/x/y/pull/1#discussion_r1',
    state: 'unresolved',
    ...over,
  };
}

test('shouldOfferReviewSummary requires >= REVIEW_SUMMARY_MIN_COMMENTS real comments', () => {
  const few = Array.from({ length: REVIEW_SUMMARY_MIN_COMMENTS - 1 }, () => mkComment({}));
  assert.equal(shouldOfferReviewSummary(few), false);
  const many = Array.from({ length: REVIEW_SUMMARY_MIN_COMMENTS }, () => mkComment({}));
  assert.equal(shouldOfferReviewSummary(many), true);
});

test('shouldOfferReviewSummary ignores empty-body comments', () => {
  const noisy = Array.from({ length: 20 }, () => mkComment({ body: '' }));
  assert.equal(shouldOfferReviewSummary(noisy), false);
});

test('shouldOfferReviewSummary returns false for non-array input', () => {
  assert.equal(shouldOfferReviewSummary(undefined as any), false);
  assert.equal(shouldOfferReviewSummary(null as any), false);
});

test('buildReviewSummaryPrompt includes PR header and comment index', () => {
  const comments = Array.from({ length: 3 }, (_, i) =>
    mkComment({ body: `Comment ${i + 1}`, author: `user${i + 1}`, path: `src/f${i}.ts`, line: 10 + i }));
  const out = buildReviewSummaryPrompt({ comments, prNumber: 42, branch: 'feat/x' });
  assert.match(out, /PR #42 on branch feat\/x/);
  assert.match(out, /\[1\] inline @user1 src\/f0\.ts:10/);
  assert.match(out, /\[3\] inline @user3 src\/f2\.ts:12/);
  assert.match(out, /Summarise the discussion/);
});

test('buildReviewSummaryPrompt sorts unresolved first then resolved', () => {
  const comments: PrCommentEntry[] = [
    mkComment({ body: 'older resolved', state: 'resolved', createdAt: '2026-06-20T10:00:00Z' }),
    mkComment({ body: 'newer unresolved', state: 'unresolved', createdAt: '2026-06-21T10:00:00Z' }),
  ];
  const out = buildReviewSummaryPrompt({ comments, prNumber: 1 });
  const unresolvedIdx = out.indexOf('newer unresolved');
  const resolvedIdx = out.indexOf('older resolved');
  assert.ok(unresolvedIdx > 0 && resolvedIdx > 0);
  assert.ok(unresolvedIdx < resolvedIdx);
});

test('buildReviewSummaryPrompt truncates long comment bodies', () => {
  const long = 'x'.repeat(2000);
  const comments = [mkComment({ body: long })];
  const out = buildReviewSummaryPrompt({ comments, prNumber: 1, maxBodyChars: 100 });
  assert.match(out, /truncated/);
  assert.ok(out.length < 2000 + 200, 'prompt should not contain the full long body');
});

test('buildReviewSummaryPrompt skips empty bodies in the content section', () => {
  const comments: PrCommentEntry[] = [
    mkComment({ body: '' }),
    mkComment({ body: 'real content' }),
  ];
  const out = buildReviewSummaryPrompt({ comments, prNumber: 1 });
  // Only one [N] marker should appear in the conversation section.
  const matches = out.match(/\n\[\d+\] /g);
  assert.equal(matches?.length, 1);
});

test('parseReviewSummaryOutput splits Summary + Open questions sections', () => {
  const raw = `
## Summary

The team converged on extracting a helper for the duplicate auth checks.

## Open questions

- Should we keep the legacy fallback?
- Is the new helper covered by tests?
`;
  const parsed = parseReviewSummaryOutput(raw);
  assert.match(parsed.paragraph, /The team converged/);
  assert.equal(parsed.questions.length, 2);
  assert.match(parsed.questions[0], /legacy fallback/);
});

test('parseReviewSummaryOutput tolerates Open issues / Unresolved variants', () => {
  for (const heading of ['Open issues', 'Unresolved threads', 'Action items']) {
    const raw = `## Summary\n\nbody\n\n## ${heading}\n- one\n- two`;
    const parsed = parseReviewSummaryOutput(raw);
    assert.equal(parsed.questions.length, 2, `failed for heading=${heading}`);
  }
});

test('parseReviewSummaryOutput: no section headers - whole body becomes paragraph', () => {
  const raw = 'Just a single paragraph from a sloppy model run.';
  const parsed = parseReviewSummaryOutput(raw);
  assert.equal(parsed.paragraph, raw);
  assert.equal(parsed.questions.length, 0);
});

test('parseReviewSummaryOutput: sentinel "All threads appear resolved" sets allResolved', () => {
  const raw = '## Summary\n\nbody\n\n## Open questions\n- All threads appear resolved.';
  const parsed = parseReviewSummaryOutput(raw);
  assert.equal(parsed.allResolved, true);
});

test('parseReviewSummaryOutput: bullets with *, - and 1. markers all parsed', () => {
  const raw = '## Summary\n\nbody\n\n## Open questions\n- dash\n* star\n1. numbered';
  const parsed = parseReviewSummaryOutput(raw);
  assert.deepEqual(parsed.questions, ['dash', 'star', 'numbered']);
});

test('parseReviewSummaryOutput: empty input returns empty parse', () => {
  const parsed = parseReviewSummaryOutput('');
  assert.equal(parsed.paragraph, '');
  assert.equal(parsed.questions.length, 0);
  assert.equal(parsed.allResolved, false);
});

test('renderReviewSummary stamps PR number and comment count', () => {
  const parsed = { paragraph: 'good discussion', questions: ['q1', 'q2'], allResolved: false };
  const md = renderReviewSummary(parsed, { prNumber: 42, commentCount: 15 });
  assert.match(md, /PR #42/);
  assert.match(md, /15 comments/);
  assert.match(md, /good discussion/);
  assert.match(md, /- q1/);
  assert.match(md, /- q2/);
});

test('renderReviewSummary: allResolved produces "All threads appear resolved" bullet', () => {
  const parsed = { paragraph: 'wrapping up', questions: [], allResolved: true };
  const md = renderReviewSummary(parsed, { prNumber: 1, commentCount: 20 });
  assert.match(md, /All threads appear resolved\./);
});

test('renderReviewSummary: empty paragraph falls back to no-summary placeholder', () => {
  const parsed = { paragraph: '', questions: [], allResolved: false };
  const md = renderReviewSummary(parsed, { prNumber: 1, commentCount: 0 });
  assert.match(md, /\(no summary produced\)/);
});

test('REVIEW_SUMMARY_MIN_COMMENTS threshold is the documented value', () => {
  assert.equal(REVIEW_SUMMARY_MIN_COMMENTS, 10);
});

test('REVIEW_SUMMARY_SYSTEM_PROMPT mentions both required sections', () => {
  assert.match(REVIEW_SUMMARY_SYSTEM_PROMPT, /## Summary/);
  assert.match(REVIEW_SUMMARY_SYSTEM_PROMPT, /## Open questions/);
});

test('buildReviewSummaryPrompt includes review-summary kind with reviewState', () => {
  const comments: PrCommentEntry[] = [
    mkComment({ kind: 'review-summary', reviewState: 'APPROVED', body: 'lgtm' }),
  ];
  const out = buildReviewSummaryPrompt({ comments, prNumber: 1 });
  assert.match(out, /review-summary/);
  assert.match(out, /\(approved\)/);
});

test('buildReviewSummaryPrompt marks resolved comments in the header', () => {
  const comments: PrCommentEntry[] = [
    mkComment({ body: 'fixed in 5b6', state: 'resolved' }),
  ];
  const out = buildReviewSummaryPrompt({ comments, prNumber: 1 });
  assert.match(out, /\(resolved\)/);
});
