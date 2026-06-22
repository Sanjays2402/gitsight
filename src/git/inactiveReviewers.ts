/**
 * Pure helpers for inactive-reviewer detection (F105).
 *
 * Composes with F75 prReviewInbox. A PR can sit forever in
 * `review-required` because a requested reviewer is on PTO,
 * over-subscribed, or just lost the notification. This module:
 *
 *   1. Parses `gh pr view <num> --json reviewRequests,reviews,createdAt,
 *      isDraft,updatedAt` into a typed shape.
 *   2. Classifies each requested reviewer as `silent` / `active` /
 *      `commented` based on whether they appear in the reviews array.
 *   3. Computes the time-since-request in days from the PR's createdAt
 *      (the closest available proxy — gh doesn't expose the per-reviewer
 *      "requested at" timestamp without dropping into the GraphQL API,
 *      and the v1 slice should not require that).
 *   4. Returns a sorted list of inactive reviewers (silent + over the
 *      staleness threshold) the view layer can use to build a
 *      "remind via @-mention" picker.
 *
 * The reminder body is composed via composeReminderComment(), which
 * takes the reviewer list + an optional user prefix and emits a body
 * suitable for `gh pr comment <num> --body-file -`:
 *
 *   Gentle ping on this — @alice @bob still pending after 5 days.
 *
 * Pure - no fs, no vscode. Tests in test/git/inactiveReviewers.test.ts.
 */

export type ReviewerActivity = 'silent' | 'commented' | 'changes-requested' | 'approved';

export interface ReviewerStatus {
  login: string;
  /** True when the reviewer is a team handle (e.g. `org/security`). */
  isTeam: boolean;
  activity: ReviewerActivity;
  /** Days since the PR was created (proxy for "requested at"). */
  daysSinceRequest: number;
}

export interface ReviewRequestRaw {
  /** User row: { login: 'alice' } (or just 'alice' in older gh). */
  __typename?: 'User' | 'Team';
  login?: string;
  /** Team row: { slug: 'security', organization: { login: 'org' } }. */
  slug?: string;
  organization?: { login?: string };
}

export interface ReviewRaw {
  author?: { login?: string } | string;
  state?: string; // APPROVED / COMMENTED / CHANGES_REQUESTED / DISMISSED / PENDING
  submittedAt?: string;
}

export interface PrActivity {
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 — used to suppress stale checks on very-recently-touched PRs. */
  updatedAt: string;
  isDraft: boolean;
  reviewRequests: ReviewRequestRaw[];
  reviews: ReviewRaw[];
}

/**
 * Parse `gh pr view --json reviewRequests,reviews,createdAt,updatedAt,isDraft`.
 * Tolerates the gh JSON shape variations.
 */
export function parsePrActivity(raw: string): PrActivity | undefined {
  if (!raw || !raw.trim()) return undefined;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  if (!obj || typeof obj !== 'object') return undefined;
  return {
    createdAt: String(obj.createdAt ?? ''),
    updatedAt: String(obj.updatedAt ?? ''),
    isDraft: !!obj.isDraft,
    reviewRequests: Array.isArray(obj.reviewRequests) ? obj.reviewRequests : [],
    reviews: Array.isArray(obj.reviews) ? obj.reviews : [],
  };
}

/**
 * Normalise a review-request entry to a `{login, isTeam}` shape.
 * Returns undefined when the entry is malformed.
 */
export function normaliseReviewRequest(rr: ReviewRequestRaw | string): { login: string; isTeam: boolean } | undefined {
  if (typeof rr === 'string') {
    const trimmed = rr.trim();
    if (!trimmed) return undefined;
    return { login: trimmed.replace(/^@/, ''), isTeam: trimmed.includes('/') };
  }
  if (!rr || typeof rr !== 'object') return undefined;
  if (rr.slug && rr.organization?.login) {
    return { login: `${rr.organization.login}/${rr.slug}`, isTeam: true };
  }
  if (rr.login) {
    const tn = rr.__typename;
    return { login: rr.login, isTeam: tn === 'Team' };
  }
  // Some shapes have just `{slug}` (team without org) — sink to a label-only handle.
  if (rr.slug) return { login: rr.slug, isTeam: true };
  return undefined;
}

/**
 * Map a gh review-state string to an activity flag, biasing toward the
 * MOST RECENT review per author. The latest review wins (so an APPROVED
 * after CHANGES_REQUESTED counts as approved).
 */
export function classifyReviewerActivities(
  activity: PrActivity,
): Map<string, ReviewerActivity> {
  const out = new Map<string, ReviewerActivity>();
  // Sort reviews by submittedAt ascending so the last one wins.
  const sorted = activity.reviews.slice().sort((a, b) => {
    const ad = Date.parse(a.submittedAt ?? '') || 0;
    const bd = Date.parse(b.submittedAt ?? '') || 0;
    return ad - bd;
  });
  for (const r of sorted) {
    const login = typeof r.author === 'string' ? r.author : (r.author?.login ?? '');
    if (!login) continue;
    const state = String(r.state ?? '').toUpperCase();
    let act: ReviewerActivity = 'silent';
    if (state === 'APPROVED') act = 'approved';
    else if (state === 'CHANGES_REQUESTED') act = 'changes-requested';
    else if (state === 'COMMENTED') act = 'commented';
    else if (state === 'DISMISSED') act = 'silent';
    else if (state === 'PENDING') continue; // ignore pending (not submitted)
    out.set(login, act);
  }
  return out;
}

/**
 * Walk the PR's requested reviewers and assemble a ReviewerStatus[] view.
 * `now` is injectable for tests.
 */
export function buildReviewerStatuses(activity: PrActivity, now: Date = new Date()): ReviewerStatus[] {
  const acts = classifyReviewerActivities(activity);
  const createdAt = Date.parse(activity.createdAt) || now.getTime();
  const days = Math.max(0, Math.floor((now.getTime() - createdAt) / (1000 * 60 * 60 * 24)));

  const out: ReviewerStatus[] = [];
  for (const rr of activity.reviewRequests) {
    const norm = normaliseReviewRequest(rr);
    if (!norm) continue;
    const activityKind: ReviewerActivity = acts.get(norm.login) ?? 'silent';
    out.push({
      login: norm.login,
      isTeam: norm.isTeam,
      activity: activityKind,
      daysSinceRequest: days,
    });
  }
  return out;
}

/**
 * Filter to only the reviewers worth nagging. By default:
 *
 *   - activity === 'silent' (no review submitted)
 *   - daysSinceRequest >= staleAfterDays
 *   - PR is not a draft (don't nag on drafts; the author isn't asking)
 *
 * Teams are kept by default — they expand server-side and a single
 * @org/team mention reaches everyone. The view can offer a "skip
 * teams" toggle if the user prefers nudging individuals.
 */
export interface InactiveFilterOptions {
  staleAfterDays?: number;
  includeTeams?: boolean;
  includeCommented?: boolean;
}

export function findInactiveReviewers(
  activity: PrActivity,
  statuses: ReviewerStatus[],
  opts: InactiveFilterOptions = {},
): ReviewerStatus[] {
  const stale = opts.staleAfterDays ?? 3;
  const includeTeams = opts.includeTeams !== false;
  const includeCommented = !!opts.includeCommented;
  if (activity.isDraft) return [];

  return statuses
    .filter(s => {
      if (s.activity === 'approved') return false;
      if (s.activity === 'changes-requested') return false;
      if (s.activity === 'commented' && !includeCommented) return false;
      if (!includeTeams && s.isTeam) return false;
      if (s.daysSinceRequest < stale) return false;
      return true;
    })
    .sort((a, b) => b.daysSinceRequest - a.daysSinceRequest || a.login.localeCompare(b.login));
}

/**
 * Compose a reminder PR-comment body. Mentions every reviewer in the
 * list using their @-form (teams as `@org/team`, users as `@login`),
 * with a default lead-in that the user can override via `prefix`.
 *
 * Output:
 *
 *   Gentle ping on this — @alice @bob still pending after 5 days.
 *
 * `staleness` is the highest daysSinceRequest in the list. The
 * single-reviewer case rewrites to "still pending after N days".
 * Returns '' when reviewers is empty.
 */
export function composeReminderComment(
  reviewers: ReviewerStatus[],
  opts: { prefix?: string; tone?: 'gentle' | 'firm' } = {},
): string {
  if (!reviewers.length) return '';
  const tone = opts.tone ?? 'gentle';
  const lead = opts.prefix?.trim() || (tone === 'firm'
    ? 'Bumping this for review.'
    : 'Gentle ping on this.');
  const mentions = reviewers.map(r => '@' + r.login).join(' ');
  const days = reviewers.reduce((m, r) => Math.max(m, r.daysSinceRequest), 0);
  const tail = days > 0 ? ` Still pending after ${days} day${days === 1 ? '' : 's'}.` : '';
  return `${lead} ${mentions}${tail}`;
}

/**
 * Aggregate a quick summary suitable for the F75 picker description
 * column: "2 inactive (alice 5d, bob 4d)".
 */
export function summariseInactive(reviewers: ReviewerStatus[]): string {
  if (!reviewers.length) return 'all reviewers active';
  const top = reviewers.slice(0, 2)
    .map(r => `${r.login} ${r.daysSinceRequest}d`)
    .join(', ');
  const extra = reviewers.length > 2 ? ` +${reviewers.length - 2}` : '';
  return `${reviewers.length} inactive (${top}${extra})`;
}
