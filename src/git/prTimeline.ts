/**
 * Pure helpers for the PR ready-for-review timeline (F106).
 *
 * Pulls a slim status row for the CURRENT branch's open PR. Designed
 * to live in the status bar — one click reveals a detail picker.
 *
 * Powered by:
 *
 *   gh pr view --json number,state,isDraft,mergeable,reviewDecision,
 *     reviewRequests,reviews,commits,comments,baseRefName,updatedAt
 *
 * We don't need the full details for the status row — just the counts
 * and a coarse readiness verdict. The pure module:
 *
 *   1. Parses the gh JSON into a PrTimeline shape.
 *   2. Computes:
 *      - commitsSinceLastReview: commits authored after the most
 *        recent submitted review's timestamp. Catches "I pushed
 *        fixes after Alice reviewed; she should re-review."
 *      - newCommentsSinceLastReview: comments newer than the latest
 *        review (useful for "5 unresolved threads since last
 *        approval").
 *      - pendingReviewers: requested reviewers who haven't responded
 *        yet (overlaps F105 inactive-reviewers but no time gate).
 *      - mergeStatus: ready | conflicts | review-required | blocked.
 *   3. Returns a `pillState` enum the view layer maps to glyph + color.
 *
 * Pure - no fs, no vscode. Tests in test/git/prTimeline.test.ts.
 */

export type PrPillState = 'ready' | 'review-needed' | 'commits-since-review' | 'conflicts' | 'changes-requested' | 'draft' | 'unknown';

export interface PrTimelineCommit {
  oid: string;
  authoredDate: string;
  messageHeadline: string;
}

export interface PrTimelineReview {
  authorLogin: string;
  state: 'APPROVED' | 'COMMENTED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string;
}

export interface PrTimelineComment {
  authorLogin: string;
  createdAt: string;
}

export interface PrTimeline {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: 'APPROVED' | 'REVIEW_REQUIRED' | 'CHANGES_REQUESTED' | '';
  pendingReviewers: string[];
  baseRefName: string;
  updatedAt: string;
  commits: PrTimelineCommit[];
  reviews: PrTimelineReview[];
  comments: PrTimelineComment[];
}

/** Parse the gh JSON payload — tolerant of the field-shape variants. */
export function parsePrTimeline(raw: string): PrTimeline | undefined {
  if (!raw || !raw.trim()) return undefined;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  if (!obj || typeof obj !== 'object') return undefined;
  const number = Number(obj.number ?? 0);
  if (!Number.isFinite(number) || number <= 0) return undefined;

  const stateRaw = String(obj.state ?? 'OPEN').toUpperCase();
  const state: PrTimeline['state'] = stateRaw === 'MERGED' ? 'MERGED' : stateRaw === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const mergeRaw = String(obj.mergeable ?? '').toUpperCase();
  const mergeable: PrTimeline['mergeable'] = mergeRaw === 'CONFLICTING' ? 'CONFLICTING' : mergeRaw === 'MERGEABLE' ? 'MERGEABLE' : 'UNKNOWN';

  const reviewDecisionRaw = String(obj.reviewDecision ?? '').toUpperCase();
  const reviewDecision: PrTimeline['reviewDecision'] = reviewDecisionRaw === 'APPROVED' || reviewDecisionRaw === 'REVIEW_REQUIRED' || reviewDecisionRaw === 'CHANGES_REQUESTED'
    ? reviewDecisionRaw
    : '';

  const reviewRequests = Array.isArray(obj.reviewRequests) ? obj.reviewRequests : [];
  const pendingReviewers: string[] = reviewRequests
    .map((rr: any) => normaliseReviewer(rr))
    .filter((s: string | undefined): s is string => !!s);

  const commitsArr = Array.isArray(obj.commits) ? obj.commits : [];
  const commits: PrTimelineCommit[] = commitsArr.map((c: any) => ({
    oid: String(c?.oid ?? c?.commit?.oid ?? ''),
    authoredDate: String(c?.authoredDate ?? c?.commit?.authoredDate ?? c?.commit?.committedDate ?? ''),
    messageHeadline: String(c?.messageHeadline ?? c?.commit?.messageHeadline ?? '').slice(0, 200),
  })).filter((c: PrTimelineCommit) => !!c.authoredDate);

  const reviewsArr = Array.isArray(obj.reviews) ? obj.reviews : [];
  const reviews: PrTimelineReview[] = reviewsArr.map((r: any) => ({
    authorLogin: String(r?.author?.login ?? r?.author?.name ?? (typeof r?.author === 'string' ? r.author : '')),
    state: (String(r?.state ?? '').toUpperCase()) as PrTimelineReview['state'],
    submittedAt: String(r?.submittedAt ?? ''),
  })).filter((r: PrTimelineReview) => !!r.authorLogin && !!r.submittedAt);

  const commentsArr = Array.isArray(obj.comments) ? obj.comments : [];
  const comments: PrTimelineComment[] = commentsArr.map((c: any) => ({
    authorLogin: String(c?.author?.login ?? c?.author?.name ?? (typeof c?.author === 'string' ? c.author : '')),
    createdAt: String(c?.createdAt ?? ''),
  })).filter((c: PrTimelineComment) => !!c.createdAt);

  return {
    number,
    state,
    isDraft: !!obj.isDraft,
    mergeable,
    reviewDecision,
    pendingReviewers,
    baseRefName: String(obj.baseRefName ?? ''),
    updatedAt: String(obj.updatedAt ?? ''),
    commits,
    reviews,
    comments,
  };
}

function normaliseReviewer(rr: any): string | undefined {
  if (!rr) return undefined;
  if (typeof rr === 'string') return rr.replace(/^@/, '') || undefined;
  if (rr.slug && rr.organization?.login) return `${rr.organization.login}/${rr.slug}`;
  if (rr.login) return rr.login;
  if (rr.slug) return rr.slug;
  return undefined;
}

/**
 * The most recent review submitted (by submittedAt). PENDING / DISMISSED
 * are excluded — they don't count as "she gave feedback".
 */
export function findLatestReview(t: PrTimeline): PrTimelineReview | undefined {
  let best: PrTimelineReview | undefined;
  let bestTs = -Infinity;
  for (const r of t.reviews) {
    if (r.state === 'PENDING' || r.state === 'DISMISSED') continue;
    const ts = Date.parse(r.submittedAt);
    if (!Number.isFinite(ts)) continue;
    if (ts > bestTs) { best = r; bestTs = ts; }
  }
  return best;
}

/**
 * Commits authored AFTER the latest review's submittedAt. If no
 * review, every commit counts (the reviewer hasn't seen any of them).
 */
export function commitsSinceLastReview(t: PrTimeline): PrTimelineCommit[] {
  const latest = findLatestReview(t);
  if (!latest) return t.commits.slice();
  const ts = Date.parse(latest.submittedAt);
  if (!Number.isFinite(ts)) return t.commits.slice();
  return t.commits.filter(c => {
    const ct = Date.parse(c.authoredDate);
    return Number.isFinite(ct) && ct > ts;
  });
}

/**
 * Comments newer than the latest review. Useful for "5 unresolved
 * threads since last approval" — though we can't tell here whether
 * a comment is on a resolved thread (would need the GraphQL API).
 */
export function commentsSinceLastReview(t: PrTimeline): PrTimelineComment[] {
  const latest = findLatestReview(t);
  if (!latest) return t.comments.slice();
  const ts = Date.parse(latest.submittedAt);
  if (!Number.isFinite(ts)) return t.comments.slice();
  return t.comments.filter(c => {
    const ct = Date.parse(c.createdAt);
    return Number.isFinite(ct) && ct > ts;
  });
}

export interface TimelineSummary {
  state: PrPillState;
  /** Short, status-bar-suitable label: e.g. `#42 ready` or `#42 +3 since review`. */
  pillLabel: string;
  /** Longer summary suitable for the tooltip / picker title. */
  summary: string;
  /** Counts surfaced to the UI. */
  counts: {
    commitsSinceLastReview: number;
    commentsSinceLastReview: number;
    pendingReviewers: number;
    totalReviews: number;
    totalCommits: number;
  };
}

/**
 * Top-level: classify the PR into a status-bar pill state + short label.
 *
 * Decision tree (first match wins):
 *
 *   - draft                 -> 'draft'                "#42 draft"
 *   - state !== OPEN        -> 'unknown'              "#42 <state>"
 *   - mergeable=CONFLICTING -> 'conflicts'            "#42 conflicts"
 *   - reviewDecision=CHANGES_REQUESTED -> 'changes-requested' "#42 changes requested"
 *   - commitsSinceLastReview > 0 AND has any prior review -> 'commits-since-review' "#42 +N since review"
 *   - reviewDecision=APPROVED AND no new commits -> 'ready' "#42 ready to merge"
 *   - any pendingReviewers OR reviewDecision=REVIEW_REQUIRED -> 'review-needed' "#42 waiting on N"
 *   - otherwise              -> 'unknown'
 */
export function summariseTimeline(t: PrTimeline): TimelineSummary {
  const newCommits = commitsSinceLastReview(t);
  const newComments = commentsSinceLastReview(t);
  const counts: TimelineSummary['counts'] = {
    commitsSinceLastReview: newCommits.length,
    commentsSinceLastReview: newComments.length,
    pendingReviewers: t.pendingReviewers.length,
    totalReviews: t.reviews.length,
    totalCommits: t.commits.length,
  };
  const tag = `#${t.number}`;

  if (t.isDraft) {
    return mk('draft', `${tag} draft`, `PR ${tag} is in draft.`, counts);
  }
  if (t.state !== 'OPEN') {
    return mk('unknown', `${tag} ${t.state.toLowerCase()}`, `PR ${tag} is ${t.state.toLowerCase()}.`, counts);
  }
  if (t.mergeable === 'CONFLICTING') {
    return mk('conflicts', `${tag} conflicts`, `PR ${tag} has merge conflicts with ${t.baseRefName || 'base'}.`, counts);
  }
  if (t.reviewDecision === 'CHANGES_REQUESTED') {
    return mk('changes-requested', `${tag} changes requested`, `PR ${tag} has changes requested.`, counts);
  }
  const hasPriorReview = t.reviews.some(r => r.state !== 'PENDING' && r.state !== 'DISMISSED');
  if (newCommits.length > 0 && hasPriorReview) {
    const noun = newCommits.length === 1 ? 'commit' : 'commits';
    return mk('commits-since-review', `${tag} +${newCommits.length} since review`,
      `PR ${tag}: ${newCommits.length} new ${noun} since the last review (re-request?).`, counts);
  }
  if (t.reviewDecision === 'APPROVED') {
    return mk('ready', `${tag} ready to merge`, `PR ${tag} is approved and mergeable.`, counts);
  }
  if (t.reviewDecision === 'REVIEW_REQUIRED' || t.pendingReviewers.length > 0) {
    const n = t.pendingReviewers.length;
    const who = n === 0 ? '' : `: ${t.pendingReviewers.slice(0, 2).join(', ')}${n > 2 ? ` +${n - 2}` : ''}`;
    const label = n > 0 ? `${tag} waiting on ${n}` : `${tag} review required`;
    return mk('review-needed', label, `PR ${tag} needs review${who}.`, counts);
  }
  return mk('unknown', `${tag} open`, `PR ${tag} is open (no specific review state).`, counts);
}

function mk(state: PrPillState, pillLabel: string, summary: string, counts: TimelineSummary['counts']): TimelineSummary {
  return { state, pillLabel, summary, counts };
}

/** Glyph map for the pill (VS Code codicon names; no emoji). */
export function glyphForPillState(s: PrPillState): string {
  switch (s) {
    case 'ready': return 'pass-filled';
    case 'review-needed': return 'eye';
    case 'commits-since-review': return 'sync';
    case 'conflicts': return 'warning';
    case 'changes-requested': return 'request-changes';
    case 'draft': return 'circle-outline';
    case 'unknown': return 'question';
  }
}

/** Markdown tooltip body for the pill — multi-line, denser than the label. */
export function describeTimeline(t: PrTimeline, summary: TimelineSummary): string {
  const lines: string[] = [];
  lines.push(`**PR #${t.number}**  -  ${stateLabel(summary.state)}`);
  lines.push('');
  lines.push(`- Base: \`${t.baseRefName || '(unknown)'}\``);
  lines.push(`- Mergeable: ${t.mergeable.toLowerCase()}`);
  lines.push(`- Review decision: ${t.reviewDecision ? t.reviewDecision.toLowerCase().replace('_', ' ') : '(none)'}`);
  lines.push(`- Reviews submitted: ${t.reviews.length}`);
  lines.push(`- Commits total: ${t.commits.length}`);
  if (summary.counts.commitsSinceLastReview > 0) {
    lines.push(`- Commits since last review: **${summary.counts.commitsSinceLastReview}**`);
  }
  if (summary.counts.commentsSinceLastReview > 0) {
    lines.push(`- Comments since last review: **${summary.counts.commentsSinceLastReview}**`);
  }
  if (t.pendingReviewers.length) {
    lines.push(`- Pending reviewers: ${t.pendingReviewers.join(', ')}`);
  }
  return lines.join('\n');
}

function stateLabel(s: PrPillState): string {
  switch (s) {
    case 'ready': return 'ready to merge';
    case 'review-needed': return 'waiting on review';
    case 'commits-since-review': return 'new commits since last review';
    case 'conflicts': return 'merge conflicts';
    case 'changes-requested': return 'changes requested';
    case 'draft': return 'draft';
    case 'unknown': return 'open';
  }
}
