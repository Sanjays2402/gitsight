import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parsePrActivity,
  normaliseReviewRequest,
  classifyReviewerActivities,
  buildReviewerStatuses,
  findInactiveReviewers,
  composeReminderComment,
  summariseInactive,
} from '../../src/git/inactiveReviewers';

const FIXED_NOW = new Date('2026-06-22T16:00:00Z');

// ── parsePrActivity ───────────────────────────────────────────────

test('parsePrActivity: empty/garbage', () => {
  assert.equal(parsePrActivity(''), undefined);
  assert.equal(parsePrActivity('not json'), undefined);
});

test('parsePrActivity: minimal valid', () => {
  const a = parsePrActivity('{"createdAt":"2026-06-15T00:00:00Z","updatedAt":"2026-06-15T00:00:00Z","isDraft":false,"reviewRequests":[],"reviews":[]}');
  assert.equal(a?.createdAt, '2026-06-15T00:00:00Z');
  assert.equal(a?.isDraft, false);
});

test('parsePrActivity: missing arrays default to []', () => {
  const a = parsePrActivity('{"createdAt":"2026-01-01T00:00:00Z"}');
  assert.deepEqual(a?.reviewRequests, []);
  assert.deepEqual(a?.reviews, []);
});

// ── normaliseReviewRequest ────────────────────────────────────────

test('normaliseReviewRequest: string handle', () => {
  assert.deepEqual(normaliseReviewRequest('alice'), { login: 'alice', isTeam: false });
});

test('normaliseReviewRequest: @ stripped from string', () => {
  assert.deepEqual(normaliseReviewRequest('@alice'), { login: 'alice', isTeam: false });
});

test('normaliseReviewRequest: org/team string detected as team', () => {
  assert.deepEqual(normaliseReviewRequest('foo/security'), { login: 'foo/security', isTeam: true });
});

test('normaliseReviewRequest: User typename', () => {
  assert.deepEqual(normaliseReviewRequest({ __typename: 'User', login: 'alice' }), { login: 'alice', isTeam: false });
});

test('normaliseReviewRequest: Team with org slug', () => {
  assert.deepEqual(
    normaliseReviewRequest({ __typename: 'Team', slug: 'security', organization: { login: 'foo' } }),
    { login: 'foo/security', isTeam: true },
  );
});

test('normaliseReviewRequest: malformed returns undefined', () => {
  assert.equal(normaliseReviewRequest('' as any), undefined);
  assert.equal(normaliseReviewRequest({} as any), undefined);
});

// ── classifyReviewerActivities ───────────────────────────────────

test('classifyReviewerActivities: latest review wins', () => {
  const activity = {
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    isDraft: false,
    reviewRequests: [],
    reviews: [
      { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-05T00:00:00Z' },
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-10T00:00:00Z' },
    ],
  };
  const acts = classifyReviewerActivities(activity);
  assert.equal(acts.get('alice'), 'approved');
});

test('classifyReviewerActivities: ignores PENDING', () => {
  const activity = {
    createdAt: '', updatedAt: '', isDraft: false, reviewRequests: [],
    reviews: [{ author: { login: 'bob' }, state: 'PENDING', submittedAt: '' }],
  };
  assert.equal(classifyReviewerActivities(activity).has('bob'), false);
});

test('classifyReviewerActivities: COMMENTED maps to commented', () => {
  const acts = classifyReviewerActivities({
    createdAt: '', updatedAt: '', isDraft: false, reviewRequests: [],
    reviews: [{ author: { login: 'c' }, state: 'COMMENTED', submittedAt: '2026-06-01' }],
  });
  assert.equal(acts.get('c'), 'commented');
});

test('classifyReviewerActivities: string-author shape', () => {
  const acts = classifyReviewerActivities({
    createdAt: '', updatedAt: '', isDraft: false, reviewRequests: [],
    reviews: [{ author: 'eve' as any, state: 'APPROVED', submittedAt: '2026-06-01' }],
  });
  assert.equal(acts.get('eve'), 'approved');
});

// ── buildReviewerStatuses ────────────────────────────────────────

test('buildReviewerStatuses: silent reviewer counted', () => {
  const activity = {
    createdAt: '2026-06-15T00:00:00Z',
    updatedAt: '2026-06-15T00:00:00Z',
    isDraft: false,
    reviewRequests: [{ __typename: 'User' as const, login: 'alice' }],
    reviews: [],
  };
  const r = buildReviewerStatuses(activity, FIXED_NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].login, 'alice');
  assert.equal(r[0].activity, 'silent');
  assert.equal(r[0].daysSinceRequest, 7);
});

test('buildReviewerStatuses: days clamped to non-negative', () => {
  const activity = {
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    isDraft: false,
    reviewRequests: [{ __typename: 'User' as const, login: 'x' }],
    reviews: [],
  };
  const r = buildReviewerStatuses(activity, FIXED_NOW);
  assert.equal(r[0].daysSinceRequest, 0);
});

test('buildReviewerStatuses: mixes silent + approved correctly', () => {
  const activity = {
    createdAt: '2026-06-15T00:00:00Z',
    updatedAt: '2026-06-22T00:00:00Z',
    isDraft: false,
    reviewRequests: [
      { __typename: 'User' as const, login: 'alice' },
      { __typename: 'User' as const, login: 'bob' },
    ],
    reviews: [{ author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T00:00:00Z' }],
  };
  const r = buildReviewerStatuses(activity, FIXED_NOW);
  assert.equal(r.find(x => x.login === 'alice')?.activity, 'approved');
  assert.equal(r.find(x => x.login === 'bob')?.activity, 'silent');
});

// ── findInactiveReviewers ────────────────────────────────────────

test('findInactiveReviewers: silent + over threshold returned', () => {
  const activity = {
    createdAt: '2026-06-15T00:00:00Z',
    updatedAt: '2026-06-15T00:00:00Z',
    isDraft: false,
    reviewRequests: [{ __typename: 'User' as const, login: 'alice' }],
    reviews: [],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  const r = findInactiveReviewers(activity, statuses, { staleAfterDays: 3 });
  assert.equal(r.length, 1);
  assert.equal(r[0].login, 'alice');
});

test('findInactiveReviewers: filters out approved/changes-requested', () => {
  const activity = {
    createdAt: '2026-06-15T00:00:00Z', updatedAt: '2026-06-15T00:00:00Z', isDraft: false,
    reviewRequests: [
      { __typename: 'User' as const, login: 'a' },
      { __typename: 'User' as const, login: 'b' },
    ],
    reviews: [
      { author: { login: 'a' }, state: 'APPROVED', submittedAt: '2026-06-20T00:00:00Z' },
      { author: { login: 'b' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-20T00:00:00Z' },
    ],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  const r = findInactiveReviewers(activity, statuses, { staleAfterDays: 3 });
  assert.equal(r.length, 0);
});

test('findInactiveReviewers: draft PR returns no inactive even with old reviewers', () => {
  const activity = {
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-15T00:00:00Z', isDraft: true,
    reviewRequests: [{ __typename: 'User' as const, login: 'alice' }],
    reviews: [],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  assert.deepEqual(findInactiveReviewers(activity, statuses, { staleAfterDays: 3 }), []);
});

test('findInactiveReviewers: under threshold filtered', () => {
  const activity = {
    createdAt: '2026-06-21T00:00:00Z', // 1 day ago
    updatedAt: '2026-06-21T00:00:00Z',
    isDraft: false,
    reviewRequests: [{ __typename: 'User' as const, login: 'alice' }],
    reviews: [],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  assert.deepEqual(findInactiveReviewers(activity, statuses, { staleAfterDays: 3 }), []);
});

test('findInactiveReviewers: includeTeams=false drops team handles', () => {
  const activity = {
    createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', isDraft: false,
    reviewRequests: [
      { __typename: 'User' as const, login: 'alice' },
      { __typename: 'Team' as const, slug: 'security', organization: { login: 'foo' } },
    ],
    reviews: [],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  const r = findInactiveReviewers(activity, statuses, { staleAfterDays: 3, includeTeams: false });
  assert.equal(r.length, 1);
  assert.equal(r[0].login, 'alice');
});

test('findInactiveReviewers: includeCommented=true keeps commented-only reviewers', () => {
  const activity = {
    createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', isDraft: false,
    reviewRequests: [{ __typename: 'User' as const, login: 'alice' }],
    reviews: [{ author: { login: 'alice' }, state: 'COMMENTED', submittedAt: '2026-06-10T00:00:00Z' }],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  const off = findInactiveReviewers(activity, statuses, { staleAfterDays: 3 });
  assert.equal(off.length, 0);
  const on = findInactiveReviewers(activity, statuses, { staleAfterDays: 3, includeCommented: true });
  assert.equal(on.length, 1);
});

test('findInactiveReviewers: sorted by daysSinceRequest desc then login', () => {
  const activity = {
    createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', isDraft: false,
    reviewRequests: [
      { __typename: 'User' as const, login: 'zoe' },
      { __typename: 'User' as const, login: 'alice' },
    ],
    reviews: [],
  };
  const statuses = buildReviewerStatuses(activity, FIXED_NOW);
  const r = findInactiveReviewers(activity, statuses, { staleAfterDays: 3 });
  // Same daysSinceRequest -> alphabetical
  assert.equal(r[0].login, 'alice');
  assert.equal(r[1].login, 'zoe');
});

// ── composeReminderComment ───────────────────────────────────────

test('composeReminderComment: empty list returns empty string', () => {
  assert.equal(composeReminderComment([]), '');
});

test('composeReminderComment: gentle default tone', () => {
  const out = composeReminderComment([
    { login: 'alice', isTeam: false, activity: 'silent', daysSinceRequest: 5 },
  ]);
  assert.ok(out.startsWith('Gentle ping on this.'));
  assert.ok(out.includes('@alice'));
  assert.ok(out.includes('5 day'));
});

test('composeReminderComment: firm tone', () => {
  const out = composeReminderComment(
    [{ login: 'bob', isTeam: false, activity: 'silent', daysSinceRequest: 10 }],
    { tone: 'firm' },
  );
  assert.ok(out.startsWith('Bumping this for review.'));
});

test('composeReminderComment: custom prefix overrides tone', () => {
  const out = composeReminderComment(
    [{ login: 'bob', isTeam: false, activity: 'silent', daysSinceRequest: 2 }],
    { prefix: 'Quick nudge:' },
  );
  assert.ok(out.startsWith('Quick nudge:'));
});

test('composeReminderComment: team handle preserved', () => {
  const out = composeReminderComment([
    { login: 'foo/security', isTeam: true, activity: 'silent', daysSinceRequest: 3 },
  ]);
  assert.ok(out.includes('@foo/security'));
});

test('composeReminderComment: multi-reviewer joined with spaces', () => {
  const out = composeReminderComment([
    { login: 'a', isTeam: false, activity: 'silent', daysSinceRequest: 7 },
    { login: 'b', isTeam: false, activity: 'silent', daysSinceRequest: 3 },
  ]);
  assert.ok(out.includes('@a @b'));
  // Highest daysSinceRequest used.
  assert.ok(out.includes('7 day'));
});

test('composeReminderComment: 1-day singular', () => {
  const out = composeReminderComment([
    { login: 'a', isTeam: false, activity: 'silent', daysSinceRequest: 1 },
  ]);
  assert.ok(out.includes('1 day.') && !out.includes('1 days'));
});

test('composeReminderComment: 0-day case has no tail', () => {
  const out = composeReminderComment([
    { login: 'a', isTeam: false, activity: 'silent', daysSinceRequest: 0 },
  ]);
  assert.ok(!out.includes('pending after'));
});

// ── summariseInactive ────────────────────────────────────────────

test('summariseInactive: empty', () => {
  assert.equal(summariseInactive([]), 'all reviewers active');
});

test('summariseInactive: one reviewer', () => {
  const s = summariseInactive([
    { login: 'alice', isTeam: false, activity: 'silent', daysSinceRequest: 5 },
  ]);
  assert.equal(s, '1 inactive (alice 5d)');
});

test('summariseInactive: three reviewers truncates with +N', () => {
  const s = summariseInactive([
    { login: 'a', isTeam: false, activity: 'silent', daysSinceRequest: 7 },
    { login: 'b', isTeam: false, activity: 'silent', daysSinceRequest: 5 },
    { login: 'c', isTeam: false, activity: 'silent', daysSinceRequest: 3 },
  ]);
  assert.ok(s.startsWith('3 inactive'));
  assert.ok(s.includes('+1'));
});
