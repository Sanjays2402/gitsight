/**
 * Pure helpers for the PR Review-Request Inbox (F75).
 *
 * The view shells out to:
 *
 *   gh pr list --search 'is:open review-requested:@me archived:false' \
 *     --json number,title,url,headRefName,baseRefName,author,repository,\
 *            updatedAt,isDraft,additions,deletions,changedFiles,reviewDecision
 *
 * This module parses that JSON, classifies each PR by review state, and
 * formats the picker label + tooltip. Kept separate so the helpers are
 * unit-testable without dragging gh into the harness.
 *
 * Pure — no vscode, no child_process. Tests in test/git/prReviewInbox.test.ts.
 */

export type ReviewState =
  | 'review-required'    // No reviews submitted yet — your turn.
  | 'changes-requested'  // Someone has requested changes (likely you).
  | 'approved'           // PR already approved; you can still re-review.
  | 'commented'          // Reviews submitted with comments only.
  | 'unknown';           // gh didn't surface a review decision (drafts, archived, etc.)

export interface PrReviewEntry {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string;
  /** owner/repo string. */
  repoSlug: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewState: ReviewState;
}

/**
 * Parse the gh JSON array. Tolerates missing fields by defaulting them,
 * skips entries that don't have a usable number.
 */
export function parsePrReviewList(raw: string): PrReviewEntry[] {
  if (!raw || !raw.trim()) return [];
  let arr: any;
  try { arr = JSON.parse(raw); }
  catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: PrReviewEntry[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const number = Number(r.number ?? 0);
    if (!Number.isFinite(number) || number <= 0) continue;
    out.push({
      number,
      title: String(r.title ?? '(no title)'),
      url: String(r.url ?? ''),
      headRefName: String(r.headRefName ?? ''),
      baseRefName: String(r.baseRefName ?? ''),
      authorLogin: String(r.author?.login ?? r.author?.name ?? ''),
      repoSlug: extractRepoSlug(r),
      updatedAt: String(r.updatedAt ?? ''),
      isDraft: !!r.isDraft,
      additions: Number(r.additions ?? 0),
      deletions: Number(r.deletions ?? 0),
      changedFiles: Number(r.changedFiles ?? 0),
      reviewState: classifyReviewState(String(r.reviewDecision ?? '')),
    });
  }
  return out;
}

function extractRepoSlug(r: any): string {
  // gh's repository field can be `{ name, owner: { login } }` (default
  // `--json repository`) OR a plain string in older versions. Tolerate
  // both shapes.
  const repo = r?.repository;
  if (!repo) return '';
  if (typeof repo === 'string') return repo;
  const owner = repo.owner?.login ?? repo.owner?.name ?? '';
  const name = repo.name ?? '';
  if (owner && name) return `${owner}/${name}`;
  return name || '';
}

/**
 * Map gh's `reviewDecision` string to a stable enum the view uses for
 * icon + sort. The enum gracefully falls back to `unknown` for any
 * shape we don't recognise.
 *
 * gh values seen in practice:
 *   - REVIEW_REQUIRED
 *   - CHANGES_REQUESTED
 *   - APPROVED
 *   - COMMENTED
 *   - (empty) for drafts / archived / outside-collaborator PRs
 */
export function classifyReviewState(raw: string): ReviewState {
  const u = (raw ?? '').toUpperCase().trim();
  if (!u) return 'unknown';
  if (u === 'REVIEW_REQUIRED')   return 'review-required';
  if (u === 'CHANGES_REQUESTED') return 'changes-requested';
  if (u === 'APPROVED')          return 'approved';
  if (u === 'COMMENTED')         return 'commented';
  return 'unknown';
}

/**
 * Sort PRs by urgency:
 *
 *   1. review-required first (your turn, no one's reviewed yet)
 *   2. changes-requested next (already touched, needs follow-up)
 *   3. commented
 *   4. approved
 *   5. unknown / draft
 *
 * Within a state, sort by updatedAt descending (most recent first).
 */
export function sortByUrgency(entries: PrReviewEntry[]): PrReviewEntry[] {
  const stateOrder: Record<ReviewState, number> = {
    'review-required': 0,
    'changes-requested': 1,
    'commented': 2,
    'approved': 3,
    'unknown': 4,
  };
  return [...entries].sort((a, b) => {
    // Drafts go to the back regardless of state.
    if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
    const so = stateOrder[a.reviewState] - stateOrder[b.reviewState];
    if (so !== 0) return so;
    // Stable: newer first.
    const ad = a.updatedAt || '';
    const bd = b.updatedAt || '';
    return bd.localeCompare(ad);
  });
}

/**
 * Glyph (codicon name) for each review state. The view passes this to
 * `$(...)` in the picker label.
 */
export function glyphForState(state: ReviewState): string {
  switch (state) {
    case 'review-required':   return 'eye';
    case 'changes-requested': return 'edit';
    case 'approved':          return 'check';
    case 'commented':         return 'comment';
    case 'unknown':           return 'circle-small';
  }
}

/**
 * Build a stable single-line label for the picker.
 *
 *   "owner/repo#42  ·  Add foo (Alice)  ·  3d ago"
 *
 * `relativeDate` should be the timeAgo() output (or '' when missing).
 */
export function describePrLabel(e: PrReviewEntry, relativeDate: string): string {
  const author = e.authorLogin ? ` (${e.authorLogin})` : '';
  const date = relativeDate ? `  \u00b7  ${relativeDate}` : '';
  const draft = e.isDraft ? '  \u00b7  draft' : '';
  return `${e.repoSlug}#${e.number}  \u00b7  ${e.title}${author}${draft}${date}`;
}

/**
 * Tooltip-style description for the picker `detail` slot.
 *
 *   "+12 -3 in 4 files  ·  base ← head"
 */
export function describePrDetail(e: PrReviewEntry): string {
  const fileLabel = `${e.changedFiles} file${e.changedFiles === 1 ? '' : 's'}`;
  const diffStat = `+${e.additions} -${e.deletions} in ${fileLabel}`;
  const refs = e.baseRefName && e.headRefName ? `  \u00b7  ${e.baseRefName} \u2190 ${e.headRefName}` : '';
  return `${diffStat}${refs}`;
}
