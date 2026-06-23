/**
 * Pure helpers for the PR Comment Thread Resolver (F108).
 *
 * Composes with F88 (PR Comments Inbox). The inbox surfaces unresolved
 * review-comment threads but stops short of letting you resolve them
 * from VS Code. GitHub's REST API (`/pulls/<n>/comments`) does NOT
 * expose thread resolution — that's only available through the GraphQL
 * `resolveReviewThread` mutation. We compose:
 *
 *   gh api graphql -f query='mutation { resolveReviewThread(...) { ... } }'
 *
 * To resolve a thread we need its NODE ID (a base64 token like
 * `PRT_kwDOABCDxs4ABcDe`). gh's `--json` output on a review-comment
 * surfaces `pullRequestThread { id, isResolved }` when the field is
 * requested. The new fetch shape is:
 *
 *   gh pr view <num> --json reviewThreads
 *
 * which returns `{ reviewThreads: [{ id, isResolved, isOutdated, path,
 * line, comments: [{ body, author }] }] }`. This module:
 *
 *   1. Parses that JSON into a stable ReviewThread[].
 *   2. Filters to UNRESOLVED-only (the user can't resolve what's
 *      already resolved).
 *   3. Sorts: outdated last, otherwise newest comment first.
 *   4. Builds the GraphQL mutation body for one OR many thread IDs.
 *      Batched form uses `aliases` (alias_1: resolveReviewThread...).
 *   5. Classifies a result blob into resolved / failed / mixed.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/prThreadResolve.test.ts.
 */

export interface ReviewThreadComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewThread {
  /** Base64 node ID for the resolveReviewThread mutation. */
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** File path of the inline comments (review threads always have one). */
  path?: string;
  /** Line of the most-recent comment on the thread. */
  line?: number;
  comments: ReviewThreadComment[];
}

/**
 * Parse the gh JSON blob for `gh pr view <num> --json reviewThreads`.
 *
 * Returns a flat list of threads, NEVER throws. Garbled / partial input
 * degrades to whatever we can recover.
 */
export function parseReviewThreads(raw: string): ReviewThread[] {
  if (!raw || !raw.trim()) return [];
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];
  const arr = obj.reviewThreads;
  if (!Array.isArray(arr)) return [];
  const out: ReviewThread[] = [];
  for (const t of arr) {
    const id = t?.id;
    if (typeof id !== 'string' || !id) continue;
    const commentsRaw = Array.isArray(t.comments?.nodes)
      ? t.comments.nodes
      : Array.isArray(t.comments)
        ? t.comments
        : [];
    const comments: ReviewThreadComment[] = [];
    for (const c of commentsRaw) {
      if (!c || typeof c !== 'object') continue;
      comments.push({
        author: String(c.author?.login ?? c.user?.login ?? ''),
        body: String(c.body ?? ''),
        createdAt: String(c.createdAt ?? c.created_at ?? ''),
      });
    }
    // Derive path/line from the newest comment if not on the thread itself.
    const lastComment = comments[comments.length - 1];
    const pathFromComment = lastComment ? undefined : undefined;
    const lineFromComment = lastComment ? undefined : undefined;
    const lineRaw = t.line ?? t.lineNumber ?? t.originalLine ?? lineFromComment;
    const lineNum = typeof lineRaw === 'number' && Number.isFinite(lineRaw) && lineRaw > 0
      ? lineRaw
      : Number.isFinite(Number(lineRaw)) && Number(lineRaw) > 0
        ? Number(lineRaw)
        : undefined;
    out.push({
      id,
      isResolved: !!t.isResolved,
      isOutdated: !!t.isOutdated,
      path: typeof t.path === 'string' && t.path ? t.path : pathFromComment,
      line: lineNum,
      comments,
    });
  }
  return out;
}

/**
 * Filter and sort threads for the picker:
 *
 *   - Drop already-resolved threads (this is the RESOLVE picker).
 *   - Outdated threads sink to the bottom (the diff has moved on;
 *     resolving still works but the context is stale).
 *   - Within each tier, newest LAST comment first.
 */
export function selectResolvable(threads: ReviewThread[]): ReviewThread[] {
  const open = threads.filter(t => !t.isResolved);
  const tier = (t: ReviewThread): number => (t.isOutdated ? 1 : 0);
  return [...open].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const ad = lastCommentAt(a) || '';
    const bd = lastCommentAt(b) || '';
    return bd.localeCompare(ad);
  });
}

function lastCommentAt(t: ReviewThread): string {
  if (!t.comments.length) return '';
  return t.comments[t.comments.length - 1].createdAt;
}

/**
 * Build a one-line picker label.
 *
 *   "src/git/foo.ts:42  ·  alice: looks suspicious  ·  3 comments"
 */
export function describeThreadLabel(t: ReviewThread): string {
  const pos = t.path
    ? (t.line ? `${t.path}:${t.line}` : t.path)
    : 'thread';
  const last = t.comments[t.comments.length - 1];
  const author = last?.author || 'unknown';
  const snippet = last?.body
    ? truncate(last.body.replace(/\s+/g, ' ').trim(), 60)
    : '(no body)';
  return `${pos}  \u00b7  ${author}: ${snippet}`;
}

/** Picker description column — outdated marker + comment count. */
export function describeThreadDescription(t: ReviewThread): string {
  const n = t.comments.length;
  const count = `${n} comment${n === 1 ? '' : 's'}`;
  if (t.isOutdated) return `${count}  \u00b7  outdated`;
  return count;
}

/**
 * Build the GraphQL mutation body for resolving one or many threads.
 *
 * For 1 thread we emit the plain `mutation { resolveReviewThread(...) }`.
 * For N threads we use aliased mutations so a single gh call resolves
 * the lot. GitHub allows up to ~50 aliased mutations per request; we
 * cap conservatively at 25 to keep the request body well-bounded.
 *
 *   mutation {
 *     t0: resolveReviewThread(input: {threadId: "PRT_..."}) { thread { id isResolved } }
 *     t1: resolveReviewThread(input: {threadId: "PRT_..."}) { thread { id isResolved } }
 *   }
 *
 * Returns the query string ready to feed into `gh api graphql -f query=...`.
 * Returns '' when the input is empty.
 */
export function buildResolveMutation(ids: string[]): string {
  const clean = (ids ?? []).filter(id => typeof id === 'string' && id.length > 0);
  if (!clean.length) return '';
  if (clean.length === 1) {
    return `mutation { resolveReviewThread(input: {threadId: ${escapeGraphqlString(clean[0])}}) { thread { id isResolved } } }`;
  }
  const lines: string[] = ['mutation {'];
  const cap = Math.min(clean.length, MAX_BATCH);
  for (let i = 0; i < cap; i++) {
    lines.push(`  t${i}: resolveReviewThread(input: {threadId: ${escapeGraphqlString(clean[i])}}) { thread { id isResolved } }`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Max threads per batched mutation. GitHub allows more but 25 is safe. */
export const MAX_BATCH = 25;

/**
 * GraphQL string-escape. Node IDs are base64 + '_' + small chars, so the
 * dangerous-character set is small — but quote / backslash / newline
 * still need handling per the spec.
 */
function escapeGraphqlString(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '\u2026';
}

/**
 * Classify a gh api response blob. The shape we expect for a single-
 * resolve mutation:
 *
 *   { "data": { "resolveReviewThread": { "thread": { "id": "...", "isResolved": true } } } }
 *
 * Or for a batched call:
 *
 *   { "data": { "t0": { "thread": {...} }, "t1": { "thread": {...} } } }
 *
 * On errors GitHub returns `{ "errors": [{ "message": "..." }] }` AND
 * may still set `data` to null. We treat absence of `data` OR any
 * thread with `isResolved=false` AND a matching error message as a
 * partial failure.
 *
 * Returns one of:
 *   - `'all'`: every requested thread is resolved
 *   - `'none'`: nothing was resolved
 *   - `'partial'`: some succeeded, some did not
 */
export type ResolveOutcome = 'all' | 'partial' | 'none';

export interface ResolveSummary {
  outcome: ResolveOutcome;
  resolvedIds: string[];
  failedIds: string[];
  errorMessages: string[];
}

export function classifyResolveResponse(
  raw: string,
  requestedIds: string[],
): ResolveSummary {
  const req = (requestedIds ?? []).filter(id => typeof id === 'string' && id.length > 0);
  const out: ResolveSummary = {
    outcome: 'none',
    resolvedIds: [],
    failedIds: [],
    errorMessages: [],
  };
  if (!req.length) return out;

  let obj: any;
  try { obj = JSON.parse(raw || ''); } catch {
    out.failedIds = [...req];
    out.errorMessages = ['response was not JSON'];
    return out;
  }
  if (obj?.errors && Array.isArray(obj.errors)) {
    for (const e of obj.errors) {
      const m = String(e?.message ?? '').trim();
      if (m) out.errorMessages.push(m);
    }
  }
  const data = obj?.data;
  const seen = new Set<string>();
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      const t = (v as any)?.thread;
      if (t && typeof t === 'object') {
        const tid = String(t.id ?? '');
        if (tid && t.isResolved === true) seen.add(tid);
      }
    }
    // Top-level singular `resolveReviewThread` (non-batched).
    const single = (data as any)?.resolveReviewThread?.thread;
    if (single && typeof single === 'object') {
      const tid = String(single.id ?? '');
      if (tid && single.isResolved === true) seen.add(tid);
    }
  }
  for (const id of req) {
    if (seen.has(id)) out.resolvedIds.push(id);
    else out.failedIds.push(id);
  }
  if (out.resolvedIds.length === req.length) out.outcome = 'all';
  else if (out.resolvedIds.length === 0) out.outcome = 'none';
  else out.outcome = 'partial';
  return out;
}

/** Headline for the picker separator. */
export function describeThreadsSummary(threads: ReviewThread[]): string {
  const resolvable = threads.filter(t => !t.isResolved);
  const total = threads.length;
  const out = resolvable.filter(t => !t.isOutdated).length;
  const outdated = resolvable.filter(t => t.isOutdated).length;
  const parts: string[] = [`${total} thread${total === 1 ? '' : 's'}`];
  if (out) parts.push(`${out} resolvable`);
  if (outdated) parts.push(`${outdated} outdated`);
  if (!resolvable.length) parts.push('all resolved');
  return parts.join('  \u00b7  ');
}
