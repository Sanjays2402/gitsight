/**
 * Pure helpers for F123 - PR review submitter.
 *
 * Composes with F75 (PR review-request inbox), F88 (PR comments
 * inbox), and F93 (PR comment composer). Those surfaces let you READ
 * pending review work and POST individual comments; this one lets you
 * SUBMIT the actual review verdict via `gh pr review`:
 *
 *   gh pr review <num> --approve
 *   gh pr review <num> --request-changes --body-file -
 *   gh pr review <num> --comment --body-file -
 *
 * Pure module owns:
 *   - ReviewVerdict union type (approve | request-changes | comment)
 *   - classifyReviewSubmission: validation gate before posting
 *     (e.g. request-changes requires a non-empty body; approve cannot
 *     coincide with a body that contains "REQUEST" / "BLOCK" / "FIX"
 *     verbs - that's almost certainly a verdict mismatch)
 *   - buildReviewArgs: gh CLI args for each verdict
 *   - summariseReviewBody: head/tail truncation for the confirmation
 *     preview
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/prReviewSubmit.test.ts.
 */

export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

export interface ReviewSubmission {
  verdict: ReviewVerdict;
  /** Optional body. Required for request-changes; optional for the others. */
  body?: string;
  /** PR number to attach the review to. */
  prNumber: number;
}

export type ReviewClassifyResult =
  | { kind: 'ok'; warnings: string[] }
  | { kind: 'blocked'; reason: string };

/**
 * Validate a review submission before firing gh. Catches two
 * categories of mistake:
 *
 *   - request-changes WITHOUT a body: GitHub allows it but it's a
 *     dead-end review (no context for the author). Block.
 *   - approve WITH a body that smells like a "fix me" tone: this is
 *     almost always a verdict mismatch (the user thought they were
 *     in request-changes mode). Warn but allow.
 *   - comment WITHOUT a body: gh exits non-zero. Block early.
 *   - body too long (> 65,000 chars): GitHub's body limit. Block.
 *
 * Returns warnings (non-blocking) the UI should surface as part of
 * the confirmation modal.
 */
export function classifyReviewSubmission(s: ReviewSubmission): ReviewClassifyResult {
  if (!Number.isFinite(s.prNumber) || s.prNumber <= 0) {
    return { kind: 'blocked', reason: 'PR number is invalid.' };
  }
  const body = s.body ?? '';
  if (body.length > 65_000) {
    return { kind: 'blocked', reason: `Review body is ${body.length.toLocaleString()} chars; GitHub limits to 65,000.` };
  }
  if (s.verdict === 'request-changes' && !body.trim()) {
    return { kind: 'blocked', reason: 'Request-changes review needs a body so the author knows what to fix.' };
  }
  if (s.verdict === 'comment' && !body.trim()) {
    return { kind: 'blocked', reason: 'Comment review needs a body.' };
  }
  const warnings: string[] = [];
  if (s.verdict === 'approve' && containsRequestChangeVerbs(body)) {
    warnings.push('Body sounds like a "request changes" review - did you mean to pick that verdict?');
  }
  if (s.verdict === 'request-changes' && containsApprovalVerbs(body)) {
    warnings.push('Body sounds like an approval - double-check the verdict.');
  }
  if (body.length > 10_000) {
    warnings.push(`Body is ${body.length.toLocaleString()} chars; consider splitting into a review summary + inline comments.`);
  }
  return { kind: 'ok', warnings };
}

const REQUEST_CHANGE_RX = /\b(?:please\s+(?:fix|change|address|resolve)|need(?:s)?\s+(?:to\s+)?(?:fix|change|address)|block(?:er|ing)?|REQUEST\s+CHANGES?)\b/i;
const APPROVAL_RX = /\b(?:lgtm|looks?\s+good|approv(?:ed|ing)|ship\s+it|nice\s+work|nice\s+job|great\s+work|good\s+to\s+(?:go|merge)|all\s+green)\b/i;

function containsRequestChangeVerbs(body: string): boolean {
  return REQUEST_CHANGE_RX.test(body);
}
function containsApprovalVerbs(body: string): boolean {
  return APPROVAL_RX.test(body);
}

/**
 * Construct the gh CLI argv. body is passed via `--body-file -` so the
 * caller pipes through stdin (avoids shell-quoting issues + long bodies).
 *
 *   approve         -> gh pr review <num> --approve [--body-file -]
 *   request-changes -> gh pr review <num> --request-changes --body-file -
 *   comment         -> gh pr review <num> --comment --body-file -
 */
export function buildReviewArgs(s: ReviewSubmission): string[] {
  const verdictFlag = verdictToFlag(s.verdict);
  const args = ['pr', 'review', String(s.prNumber), verdictFlag];
  const hasBody = !!(s.body && s.body.trim());
  if (hasBody) args.push('--body-file', '-');
  return args;
}

function verdictToFlag(v: ReviewVerdict): string {
  switch (v) {
    case 'approve': return '--approve';
    case 'request-changes': return '--request-changes';
    case 'comment': return '--comment';
  }
}

/**
 * Short summary used as the modal title.
 *
 *   "Approve PR #42?"
 *   "Request changes on PR #42?"
 *   "Comment on PR #42?"
 */
export function actionHeadline(s: { verdict: ReviewVerdict; prNumber: number }): string {
  switch (s.verdict) {
    case 'approve': return `Approve PR #${s.prNumber}?`;
    case 'request-changes': return `Request changes on PR #${s.prNumber}?`;
    case 'comment': return `Comment on PR #${s.prNumber}?`;
  }
}

/**
 * Truncate a long review body for the modal preview. Returns the
 * first MAX_HEAD chars + " ... <Nb omitted> ..." + last MAX_TAIL chars
 * when over the limit; otherwise returns the body unchanged.
 *
 * Default budget: 800 chars total (matches what fits in a typical
 * modal's detail area).
 */
export function summariseReviewBody(body: string, opts: { budget?: number } = {}): string {
  const budget = opts.budget ?? 800;
  if (body.length <= budget) return body;
  const head = Math.floor(budget * 0.5);
  const tail = budget - head;
  return `${body.slice(0, head)}\n\n... (${(body.length - budget).toLocaleString()} chars omitted) ...\n\n${body.slice(body.length - tail)}`;
}

/**
 * Render the verdict + body summary as markdown for the preview
 * scratch buffer.
 */
export function buildReviewPreview(s: ReviewSubmission): string {
  const lines: string[] = [];
  lines.push(`# Review submission - PR #${s.prNumber}`);
  lines.push('');
  lines.push(`**Verdict:** ${s.verdict}`);
  lines.push('');
  if (s.body && s.body.trim()) {
    lines.push('## Body');
    lines.push('');
    lines.push(s.body);
  } else {
    lines.push('_No body._');
  }
  return lines.join('\n');
}

/**
 * Normalise + classify a "raw" verdict string from a picker. Same
 * shape as mergeQueueActions.normaliseStrategy.
 */
export function normaliseVerdict(input: unknown): { verdict: ReviewVerdict; coerced: boolean } {
  if (typeof input !== 'string') return { verdict: 'comment', coerced: true };
  const lower = input.toLowerCase().trim();
  if (lower === 'approve' || lower === 'request-changes' || lower === 'comment') {
    return { verdict: lower as ReviewVerdict, coerced: false };
  }
  if (lower === 'request changes' || lower === 'requestchanges') {
    return { verdict: 'request-changes', coerced: false };
  }
  return { verdict: 'comment', coerced: true };
}
