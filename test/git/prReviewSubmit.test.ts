import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyReviewSubmission,
  buildReviewArgs,
  actionHeadline,
  summariseReviewBody,
  buildReviewPreview,
  normaliseVerdict,
} from '../../src/git/prReviewSubmit';

test('classifyReviewSubmission: clean approve is ok with no warnings', () => {
  const v = classifyReviewSubmission({ verdict: 'approve', prNumber: 42 });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.deepEqual(v.warnings, []);
});

test('classifyReviewSubmission: invalid PR number blocked', () => {
  for (const n of [0, -1, NaN, Infinity]) {
    const v = classifyReviewSubmission({ verdict: 'approve', prNumber: n });
    assert.equal(v.kind, 'blocked', `pr=${n}`);
  }
});

test('classifyReviewSubmission: request-changes without body blocked', () => {
  const v = classifyReviewSubmission({ verdict: 'request-changes', prNumber: 1 });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /needs a body/);
});

test('classifyReviewSubmission: request-changes with whitespace-only body blocked', () => {
  const v = classifyReviewSubmission({ verdict: 'request-changes', prNumber: 1, body: '   \n  \t' });
  assert.equal(v.kind, 'blocked');
});

test('classifyReviewSubmission: comment without body blocked', () => {
  const v = classifyReviewSubmission({ verdict: 'comment', prNumber: 1 });
  assert.equal(v.kind, 'blocked');
});

test('classifyReviewSubmission: comment WITH body is ok', () => {
  const v = classifyReviewSubmission({ verdict: 'comment', prNumber: 1, body: 'some thoughts' });
  assert.equal(v.kind, 'ok');
});

test('classifyReviewSubmission: body over 65000 chars blocked regardless of verdict', () => {
  const body = 'a'.repeat(65_001);
  const v = classifyReviewSubmission({ verdict: 'comment', prNumber: 1, body });
  assert.equal(v.kind, 'blocked');
  if (v.kind === 'blocked') assert.match(v.reason, /65,000/);
});

test('classifyReviewSubmission: approve with "please fix" body surfaces verdict-mismatch warning', () => {
  const v = classifyReviewSubmission({ verdict: 'approve', prNumber: 1, body: 'please fix this nit' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') {
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0], /request changes/);
  }
});

test('classifyReviewSubmission: approve with "BLOCK" caps body surfaces warning', () => {
  const v = classifyReviewSubmission({ verdict: 'approve', prNumber: 1, body: 'this is a BLOCKER' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.warnings.length, 1);
});

test('classifyReviewSubmission: approve with "needs to fix" body surfaces warning', () => {
  const v = classifyReviewSubmission({ verdict: 'approve', prNumber: 1, body: 'this needs to fix the race condition' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.warnings.length, 1);
});

test('classifyReviewSubmission: request-changes with "LGTM" surfaces verdict-mismatch warning', () => {
  const v = classifyReviewSubmission({ verdict: 'request-changes', prNumber: 1, body: 'LGTM ship it' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.match(v.warnings[0], /approval/);
});

test('classifyReviewSubmission: request-changes with "looks good" surfaces warning', () => {
  const v = classifyReviewSubmission({ verdict: 'request-changes', prNumber: 1, body: 'looks good to me overall but tiny nit: rename foo' });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.warnings.length, 1);
});

test('classifyReviewSubmission: body > 10k chars surfaces split-into-comments warning', () => {
  const body = 'word '.repeat(2500); // ~12,500 chars
  const v = classifyReviewSubmission({ verdict: 'comment', prNumber: 1, body });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.ok(v.warnings.some(w => /split/i.test(w)));
});

test('classifyReviewSubmission: multiple warnings accumulate', () => {
  const v = classifyReviewSubmission({
    verdict: 'approve',
    prNumber: 1,
    body: 'please fix the bug ' + 'long content '.repeat(900),
  });
  assert.equal(v.kind, 'ok');
  if (v.kind === 'ok') assert.equal(v.warnings.length, 2);
});

test('buildReviewArgs: approve with no body omits --body-file', () => {
  const args = buildReviewArgs({ verdict: 'approve', prNumber: 42 });
  assert.deepEqual(args, ['pr', 'review', '42', '--approve']);
});

test('buildReviewArgs: approve with body includes --body-file -', () => {
  const args = buildReviewArgs({ verdict: 'approve', prNumber: 42, body: 'LGTM with notes' });
  assert.deepEqual(args, ['pr', 'review', '42', '--approve', '--body-file', '-']);
});

test('buildReviewArgs: request-changes always has body so --body-file -', () => {
  const args = buildReviewArgs({ verdict: 'request-changes', prNumber: 42, body: 'fix this' });
  assert.deepEqual(args, ['pr', 'review', '42', '--request-changes', '--body-file', '-']);
});

test('buildReviewArgs: comment uses --comment flag', () => {
  const args = buildReviewArgs({ verdict: 'comment', prNumber: 42, body: 'observation' });
  assert.deepEqual(args, ['pr', 'review', '42', '--comment', '--body-file', '-']);
});

test('buildReviewArgs: empty body (whitespace) treated as no-body for approve', () => {
  const args = buildReviewArgs({ verdict: 'approve', prNumber: 42, body: '   \n  ' });
  assert.deepEqual(args, ['pr', 'review', '42', '--approve']);
});

test('actionHeadline: approve headline', () => {
  assert.equal(actionHeadline({ verdict: 'approve', prNumber: 5 }), 'Approve PR #5?');
});

test('actionHeadline: request-changes headline', () => {
  assert.equal(actionHeadline({ verdict: 'request-changes', prNumber: 5 }), 'Request changes on PR #5?');
});

test('actionHeadline: comment headline', () => {
  assert.equal(actionHeadline({ verdict: 'comment', prNumber: 5 }), 'Comment on PR #5?');
});

test('summariseReviewBody: short body returned unchanged', () => {
  const body = 'short';
  assert.equal(summariseReviewBody(body), body);
});

test('summariseReviewBody: long body truncated with head+tail+omitted marker', () => {
  const body = 'a'.repeat(2000);
  const out = summariseReviewBody(body, { budget: 200 });
  assert.ok(out.length < body.length);
  assert.match(out, /omitted/);
  // Head + tail should both come from the original (mostly a's)
  assert.ok(out.startsWith('a'));
  assert.ok(out.endsWith('a'));
});

test('summariseReviewBody: custom budget honoured', () => {
  const body = 'xy'.repeat(500); // 1000 chars
  const out = summariseReviewBody(body, { budget: 400 });
  assert.ok(out.length < 1000);
});

test('summariseReviewBody: empty body returned unchanged', () => {
  assert.equal(summariseReviewBody(''), '');
});

test('buildReviewPreview: includes verdict + body section', () => {
  const md = buildReviewPreview({ verdict: 'request-changes', prNumber: 99, body: 'please fix X' });
  assert.match(md, /^# Review submission - PR #99/);
  assert.match(md, /\*\*Verdict:\*\* request-changes/);
  assert.match(md, /## Body/);
  assert.match(md, /please fix X/);
});

test('buildReviewPreview: no body renders sentinel', () => {
  const md = buildReviewPreview({ verdict: 'approve', prNumber: 1 });
  assert.match(md, /_No body\._/);
});

test('normaliseVerdict: approve / request-changes / comment pass through', () => {
  for (const v of ['approve', 'request-changes', 'comment']) {
    const out = normaliseVerdict(v);
    assert.equal(out.verdict, v);
    assert.equal(out.coerced, false);
  }
});

test('normaliseVerdict: "request changes" (space) normalised to hyphenated', () => {
  const out = normaliseVerdict('Request Changes');
  assert.equal(out.verdict, 'request-changes');
  assert.equal(out.coerced, false);
});

test('normaliseVerdict: "requestchanges" normalised too', () => {
  const out = normaliseVerdict('requestchanges');
  assert.equal(out.verdict, 'request-changes');
  assert.equal(out.coerced, false);
});

test('normaliseVerdict: case insensitivity (APPROVE -> approve)', () => {
  const out = normaliseVerdict('APPROVE');
  assert.equal(out.verdict, 'approve');
  assert.equal(out.coerced, false);
});

test('normaliseVerdict: unknown string falls back to comment with coerce flag', () => {
  const out = normaliseVerdict('decline');
  assert.equal(out.verdict, 'comment');
  assert.equal(out.coerced, true);
});

test('normaliseVerdict: non-string input falls back to comment with coerce', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    const out = normaliseVerdict(bad);
    assert.equal(out.verdict, 'comment');
    assert.equal(out.coerced, true);
  }
});
