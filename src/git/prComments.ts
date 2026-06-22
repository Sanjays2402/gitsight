/**
 * Pure helpers for the PR Comments Inbox (F88).
 *
 * The view shells out to:
 *
 *   gh pr view <num> --json comments,reviewComments,reviews,number,title,url
 *
 * and feeds the JSON into this module. We classify each comment into a
 * stable enum, build the picker label + tooltip, and sort them by:
 *
 *   1. unresolved before resolved
 *   2. inline (file:line) before issue-level
 *   3. newest createdAt within each tier
 *
 * The picker's click handler uses `path` + `line` to jump to the right
 * spot in the editor; falls back to opening the comment URL in the
 * browser when there's no file context (issue-level comments).
 *
 * Pure — no vscode, no child_process. Tests in test/git/prComments.test.ts.
 */

export type CommentKind =
  | 'inline'          // PR review comment on a file:line
  | 'issue'           // Top-level conversation comment (no file)
  | 'review-summary'  // The review's overall comment body (approved/requested/commented)
  | 'unknown';

export type ResolutionState = 'unresolved' | 'resolved' | 'unknown';

export interface PrCommentEntry {
  kind: CommentKind;
  /** GitHub comment id when present (number for IssueComment, string for nodeId on review comments). */
  id: number | string;
  /** GitHub author login when present. */
  author: string;
  /** ISO timestamp of comment creation. */
  createdAt: string;
  /** Raw body text. May be empty for some review-summary entries. */
  body: string;
  /** Direct URL to the comment on github.com. */
  url: string;
  /** File path (repo-relative) for inline comments; undefined for issue/review-summary. */
  path?: string;
  /**
   * Line number for inline comments. GitHub records `line` as the new-file
   * line; for multi-line comments only the end line is preserved here.
   * 1-based; undefined for issue/review-summary.
   */
  line?: number;
  /** Resolution state — `resolved` only when isMinimized/isResolved is true. */
  state: ResolutionState;
  /** Review state for review-summary kind (APPROVED/CHANGES_REQUESTED/COMMENTED). */
  reviewState?: string;
}

/**
 * Parse the gh JSON blob into a flat list of comment entries.
 *
 * The shape varies a lot:
 *   - `comments` is an array of IssueComment objects (top-level PR thread).
 *   - `reviewComments` is an array of PullRequestReviewComment objects (inline file:line).
 *   - `reviews` is an array of Review objects with body + state — used for the
 *     "review summary" rows that show the reviewer's overall verdict.
 *
 * Any missing/garbled section degrades to an empty contribution rather
 * than throwing.
 */
export function parsePrComments(raw: string): PrCommentEntry[] {
  if (!raw || !raw.trim()) return [];
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];
  const out: PrCommentEntry[] = [];
  if (Array.isArray(obj.comments)) {
    for (const c of obj.comments) {
      const e = toIssueComment(c);
      if (e) out.push(e);
    }
  }
  if (Array.isArray(obj.reviewComments)) {
    for (const c of obj.reviewComments) {
      const e = toReviewComment(c);
      if (e) out.push(e);
    }
  }
  if (Array.isArray(obj.reviews)) {
    for (const r of obj.reviews) {
      const e = toReviewSummary(r);
      if (e) out.push(e);
    }
  }
  return out;
}

function toIssueComment(c: any): PrCommentEntry | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const id = c.id ?? c.databaseId ?? c.url ?? '';
  if (id === '' || id === undefined || id === null) return undefined;
  return {
    kind: 'issue',
    id: typeof id === 'number' ? id : String(id),
    author: String(c.author?.login ?? c.user?.login ?? ''),
    createdAt: String(c.createdAt ?? c.created_at ?? ''),
    body: String(c.body ?? ''),
    url: String(c.url ?? c.html_url ?? ''),
    state: 'unknown',
  };
}

function toReviewComment(c: any): PrCommentEntry | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const id = c.id ?? c.databaseId ?? c.url ?? '';
  if (id === '' || id === undefined || id === null) return undefined;
  const file = c.path;
  const lineRaw = c.line ?? c.originalLine ?? c.startLine ?? c.original_line ?? undefined;
  const line = lineRaw !== undefined && lineRaw !== null ? Number(lineRaw) : undefined;
  // GitHub marks resolved threads via `isMinimized`/`isResolved` on the
  // review comment connection. We tolerate either field name.
  const resolved = !!(c.isResolved ?? c.isMinimized ?? c.resolved);
  return {
    kind: 'inline',
    id: typeof id === 'number' ? id : String(id),
    author: String(c.author?.login ?? c.user?.login ?? ''),
    createdAt: String(c.createdAt ?? c.created_at ?? ''),
    body: String(c.body ?? ''),
    url: String(c.url ?? c.html_url ?? ''),
    path: file ? String(file) : undefined,
    line: Number.isFinite(line) && line && line > 0 ? line : undefined,
    state: resolved ? 'resolved' : 'unresolved',
  };
}

function toReviewSummary(r: any): PrCommentEntry | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const body = String(r.body ?? '');
  // Drop empty review summaries — those are pure "approved without comment"
  // rows that add nothing to a comments picker. The reviewer's verdict is
  // already covered by the F75 review inbox.
  if (!body.trim()) return undefined;
  const id = r.id ?? r.databaseId ?? r.url ?? '';
  if (id === '' || id === undefined || id === null) return undefined;
  return {
    kind: 'review-summary',
    id: typeof id === 'number' ? id : String(id),
    author: String(r.author?.login ?? r.user?.login ?? ''),
    createdAt: String(r.submittedAt ?? r.createdAt ?? r.submitted_at ?? ''),
    body,
    url: String(r.url ?? r.html_url ?? ''),
    state: 'unknown',
    reviewState: String(r.state ?? '').toUpperCase() || undefined,
  };
}

/**
 * Sort comments by usefulness:
 *
 *   1. Unresolved inline comments first (they need your attention)
 *   2. Other inline comments (resolved or unknown state) next
 *   3. Issue / review-summary comments last
 *   4. Within a tier, newest first.
 *
 * Stable: equal entries keep insertion order.
 */
export function sortComments(entries: PrCommentEntry[]): PrCommentEntry[] {
  const tier = (e: PrCommentEntry): number => {
    if (e.kind === 'inline' && e.state === 'unresolved') return 0;
    if (e.kind === 'inline') return 1;
    if (e.kind === 'review-summary') return 2;
    return 3;
  };
  return [...entries].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const ad = a.createdAt || '';
    const bd = b.createdAt || '';
    return bd.localeCompare(ad);
  });
}

/**
 * Build the picker label.
 *
 *   "$(comment) alice  ·  src/git/foo.ts:42  ·  3d ago"
 *   "$(issues) bob  ·  general thread  ·  1h ago"
 *
 * The icon is returned separately so the view can include it in the
 * QuickPick label slot.
 */
export function describeCommentLabel(e: PrCommentEntry, relativeDate: string): string {
  const author = e.author ? e.author : 'unknown';
  const date = relativeDate ? `  \u00b7  ${relativeDate}` : '';
  if (e.kind === 'inline' && e.path) {
    const lineSuffix = e.line ? `:${e.line}` : '';
    return `${author}  \u00b7  ${e.path}${lineSuffix}${date}`;
  }
  if (e.kind === 'review-summary') {
    const verdict = humanReviewState(e.reviewState);
    return `${author}  \u00b7  review ${verdict}${date}`;
  }
  return `${author}  \u00b7  general thread${date}`;
}

/** First line of the body, truncated to 120 chars with an ellipsis. */
export function describeCommentDetail(e: PrCommentEntry): string {
  const body = (e.body ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '(no body)';
  return body.length > 120 ? body.slice(0, 117) + '\u2026' : body;
}

export function glyphForComment(e: PrCommentEntry): string {
  if (e.kind === 'inline') return e.state === 'resolved' ? 'pass' : 'comment';
  if (e.kind === 'review-summary') return 'verified';
  return 'issues';
}

function humanReviewState(raw: string | undefined): string {
  switch ((raw ?? '').toUpperCase()) {
    case 'APPROVED':           return 'approved';
    case 'CHANGES_REQUESTED':  return 'changes requested';
    case 'COMMENTED':          return 'commented';
    case 'DISMISSED':          return 'dismissed';
    case 'PENDING':            return 'pending';
    default:                   return 'submitted';
  }
}

/**
 * Summary label for the picker header separator.
 *
 *   "12 comments · 4 unresolved · 6 inline · 2 threads"
 */
export function describeCommentsSummary(entries: PrCommentEntry[]): string {
  const total = entries.length;
  let unresolved = 0;
  let inline = 0;
  let threads = 0;
  for (const e of entries) {
    if (e.kind === 'inline' && e.state === 'unresolved') unresolved++;
    if (e.kind === 'inline') inline++;
    if (e.kind === 'issue' || e.kind === 'review-summary') threads++;
  }
  const parts: string[] = [`${total} comment${total === 1 ? '' : 's'}`];
  if (unresolved) parts.push(`${unresolved} unresolved`);
  if (inline) parts.push(`${inline} inline`);
  if (threads) parts.push(`${threads} thread${threads === 1 ? '' : 's'}`);
  return parts.join('  \u00b7  ');
}
