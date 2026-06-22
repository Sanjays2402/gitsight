import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseAuthoredPrs,
  parseReviewRequestedPrs,
  parseAssignedIssues,
  parseRecentCommits,
  classifyUrgency,
  glyphForItem,
  sortBySectionOrder,
  buildSections,
  describeSummary,
  describeItemLabel,
  describeItemDetail,
  DashboardItem,
} from '../../src/git/whatsMine';

test('parseAuthoredPrs: empty input', () => {
  assert.deepEqual(parseAuthoredPrs(''), []);
  assert.deepEqual(parseAuthoredPrs('not json'), []);
});

test('parseAuthoredPrs: parses repository.{owner,name} shape', () => {
  const raw = JSON.stringify([{
    number: 42,
    title: 'Fix the thing',
    url: 'https://github.com/foo/bar/pull/42',
    repository: { owner: { login: 'foo' }, name: 'bar' },
    updatedAt: '2026-06-20T00:00:00Z',
    state: 'OPEN',
    isDraft: false,
  }]);
  const out = parseAuthoredPrs(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'pr-authored');
  assert.equal(out[0].repoSlug, 'foo/bar');
  assert.equal(out[0].number, 42);
});

test('parseAuthoredPrs: parses nameWithOwner shape', () => {
  const raw = JSON.stringify([{
    number: 7,
    title: 't',
    repository: { nameWithOwner: 'org/repo' },
  }]);
  const out = parseAuthoredPrs(raw);
  assert.equal(out[0].repoSlug, 'org/repo');
});

test('parseAuthoredPrs: parses plain string repository', () => {
  const raw = JSON.stringify([{ number: 1, title: 't', repository: 'plain/string' }]);
  const out = parseAuthoredPrs(raw);
  assert.equal(out[0].repoSlug, 'plain/string');
});

test('parseAuthoredPrs: drops rows without valid number', () => {
  const raw = JSON.stringify([
    { number: 0, title: 'a' },
    { number: 5, title: 'b' },
    { title: 'c' },
  ]);
  const out = parseAuthoredPrs(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 5);
});

test('parseAuthoredPrs: normalises state', () => {
  const raw = JSON.stringify([
    { number: 1, title: 'a', state: 'merged' },
    { number: 2, title: 'b', state: 'CLOSED' },
    { number: 3, title: 'c', state: 'open' },
    { number: 4, title: 'd', state: 'weird' },
  ]);
  const out = parseAuthoredPrs(raw);
  assert.deepEqual(out.map(o => o.state), ['MERGED', 'CLOSED', 'OPEN', 'OPEN']);
});

test('parseReviewRequestedPrs: kind is pr-review', () => {
  const raw = JSON.stringify([{ number: 1, title: 't', reviewDecision: 'REVIEW_REQUIRED' }]);
  const out = parseReviewRequestedPrs(raw);
  assert.equal(out[0].kind, 'pr-review');
  assert.equal(out[0].reviewDecision, 'review-required');
});

test('parseReviewRequestedPrs: normalises review decisions', () => {
  const raw = JSON.stringify([
    { number: 1, title: 'a', reviewDecision: 'CHANGES_REQUESTED' },
    { number: 2, title: 'b', reviewDecision: 'APPROVED' },
    { number: 3, title: 'c', reviewDecision: 'COMMENTED' },
    { number: 4, title: 'd', reviewDecision: '' },
  ]);
  const out = parseReviewRequestedPrs(raw);
  assert.equal(out[0].reviewDecision, 'changes-requested');
  assert.equal(out[1].reviewDecision, 'approved');
  assert.equal(out[2].reviewDecision, 'commented');
  assert.equal(out[3].reviewDecision, 'unknown');
});

test('parseAssignedIssues: kind is issue-assigned', () => {
  const raw = JSON.stringify([{ number: 10, title: 'bug', state: 'open' }]);
  const out = parseAssignedIssues(raw);
  assert.equal(out[0].kind, 'issue-assigned');
  assert.equal(out[0].state, 'OPEN');
});

test('parseAssignedIssues: closed issue keeps state', () => {
  const raw = JSON.stringify([{ number: 10, title: 'old', state: 'CLOSED' }]);
  const out = parseAssignedIssues(raw);
  assert.equal(out[0].state, 'CLOSED');
});

test('parseRecentCommits: one line per commit', () => {
  const raw = [
    'abcdef0123abcdef0123abcdef0123|abc1234|2026-06-22T00:00:00Z|feat: add x',
    'fedcba0987fedcba0987fedcba0987|fed5678|2026-06-21T00:00:00Z|chore: bump',
  ].join('\n');
  const out = parseRecentCommits(raw, { authorLogin: 'sanjay' });
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'recent-commit');
  assert.equal(out[0].shortSha, 'abc1234');
  assert.equal(out[0].title, 'feat: add x');
  assert.equal(out[0].authorLogin, 'sanjay');
});

test('parseRecentCommits: pipe in subject survives the join', () => {
  const raw = 'abc|abc|2026-06-22T00:00:00Z|fix: pipe | in subject';
  const out = parseRecentCommits(raw);
  assert.equal(out[0].title, 'fix: pipe | in subject');
});

test('parseRecentCommits: empty + malformed rows skipped', () => {
  const raw = '\n\nincomplete\n||||\n';
  const out = parseRecentCommits(raw);
  assert.equal(out.length, 0);
});

function mkItem(overrides: Partial<DashboardItem>): DashboardItem {
  return {
    kind: 'pr-authored',
    title: 't',
    updatedAt: '2026-06-22T00:00:00Z',
    ...overrides,
  };
}

test('classifyUrgency: pr-review review-required > 3 days = overdue', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({
    kind: 'pr-review',
    reviewDecision: 'review-required',
    updatedAt: '2026-06-18T00:00:00Z', // 4 days ago
  });
  assert.equal(classifyUrgency(item, now), 'overdue');
});

test('classifyUrgency: < 24h = today', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  const item = mkItem({ updatedAt: '2026-06-22T00:00:00Z' });
  assert.equal(classifyUrgency(item, now), 'today');
});

test('classifyUrgency: 1-7 days = this-week', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({ updatedAt: '2026-06-19T00:00:00Z' });
  assert.equal(classifyUrgency(item, now), 'this-week');
});

test('classifyUrgency: > 7 days = idle', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({ updatedAt: '2026-06-10T00:00:00Z' });
  assert.equal(classifyUrgency(item, now), 'idle');
});

test('classifyUrgency: missing updatedAt = idle', () => {
  assert.equal(classifyUrgency(mkItem({ updatedAt: '' })), 'idle');
});

test('classifyUrgency: only PR-review review-required can be overdue (others escalate later)', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  // 4-day-old authored PR is "idle" not "overdue" - that's the user's own ball.
  const item = mkItem({ kind: 'pr-authored', updatedAt: '2026-06-18T00:00:00Z' });
  assert.equal(classifyUrgency(item, now), 'this-week');
});

test('glyphForItem: pr-authored returns git-pull-request', () => {
  assert.equal(glyphForItem(mkItem({ kind: 'pr-authored' })), 'git-pull-request');
});

test('glyphForItem: draft PR returns git-pull-request-draft', () => {
  assert.equal(glyphForItem(mkItem({ kind: 'pr-authored', isDraft: true })), 'git-pull-request-draft');
});

test('glyphForItem: merged PR returns git-merge', () => {
  assert.equal(glyphForItem(mkItem({ kind: 'pr-authored', state: 'MERGED' })), 'git-merge');
});

test('glyphForItem: pr-review changes-requested returns request-changes', () => {
  assert.equal(
    glyphForItem(mkItem({ kind: 'pr-review', reviewDecision: 'changes-requested' })),
    'request-changes',
  );
});

test('glyphForItem: issue-assigned open returns issues', () => {
  assert.equal(glyphForItem(mkItem({ kind: 'issue-assigned', state: 'OPEN' })), 'issues');
});

test('glyphForItem: recent-commit returns git-commit', () => {
  assert.equal(glyphForItem(mkItem({ kind: 'recent-commit' })), 'git-commit');
});

test('sortBySectionOrder: overdue first, then today, then week, then idle', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const idle = mkItem({ title: 'idle', updatedAt: '2026-06-10T00:00:00Z' });
  const week = mkItem({ title: 'week', updatedAt: '2026-06-19T00:00:00Z' });
  const today = mkItem({ title: 'today', updatedAt: '2026-06-22T00:00:00Z' });
  const overdue = mkItem({
    title: 'overdue',
    kind: 'pr-review',
    reviewDecision: 'review-required',
    updatedAt: '2026-06-15T00:00:00Z',
  });
  const sorted = sortBySectionOrder([idle, today, week, overdue], now);
  assert.deepEqual(sorted.map(s => s.title), ['overdue', 'today', 'week', 'idle']);
});

test('buildSections: emits all four sections in canonical order', () => {
  const items = [mkItem({ kind: 'pr-review' }), mkItem({ kind: 'recent-commit' })];
  const sections = buildSections(items);
  assert.deepEqual(sections.map(s => s.kind), ['pr-review', 'pr-authored', 'issue-assigned', 'recent-commit']);
});

test('buildSections: empty input still emits all four sections', () => {
  const sections = buildSections([]);
  assert.equal(sections.length, 4);
  for (const s of sections) assert.equal(s.items.length, 0);
});

test('describeSummary: pluralisation', () => {
  const sections = buildSections([
    mkItem({ kind: 'pr-review' }),
    mkItem({ kind: 'pr-authored' }),
    mkItem({ kind: 'pr-authored' }),
    mkItem({ kind: 'recent-commit' }),
  ]);
  const out = describeSummary(sections);
  assert.match(out, /^1 PR needs your review/);
  assert.match(out, /2 authored/);
  assert.match(out, /0 issues assigned/);
  assert.match(out, /1 recent commit/);
});

test('describeItemLabel: PR includes repoSlug#NN', () => {
  const item = mkItem({ kind: 'pr-authored', number: 42, repoSlug: 'foo/bar', title: 'Fix x' });
  assert.equal(describeItemLabel(item), 'foo/bar#42  Fix x');
});

test('describeItemLabel: PR without repoSlug falls back to bare #NN', () => {
  const item = mkItem({ kind: 'pr-authored', number: 42, title: 'Fix x' });
  assert.equal(describeItemLabel(item), '#42  Fix x');
});

test('describeItemLabel: recent-commit uses shortSha', () => {
  const item = mkItem({ kind: 'recent-commit', shortSha: 'abc1234', title: 'feat: x' });
  assert.equal(describeItemLabel(item), 'abc1234  feat: x');
});

test('describeItemDetail: includes urgency word', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({ kind: 'pr-authored', updatedAt: '2026-06-22T00:00:00Z' });
  const detail = describeItemDetail(item, now);
  assert.match(detail, /today/);
});

test('describeItemDetail: draft PR labelled', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({ kind: 'pr-authored', isDraft: true, updatedAt: '2026-06-22T00:00:00Z' });
  assert.match(describeItemDetail(item, now), /draft/);
});

test('describeItemDetail: review changes-requested labelled', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({
    kind: 'pr-review',
    reviewDecision: 'changes-requested',
    updatedAt: '2026-06-22T00:00:00Z',
  });
  assert.match(describeItemDetail(item, now), /changes requested/);
});

test('describeItemDetail: recent-commit shows author', () => {
  const now = new Date('2026-06-22T00:00:00Z');
  const item = mkItem({
    kind: 'recent-commit',
    authorLogin: 'sanjay',
    updatedAt: '2026-06-22T00:00:00Z',
  });
  assert.match(describeItemDetail(item, now), /sanjay/);
});
