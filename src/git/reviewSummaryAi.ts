/**
 * Pure helpers for F112 - Review-comment AI summary.
 *
 * Composes with F88 PR Comments Inbox: when a PR has > 10 comments,
 * offer to summarise the discussion via Copilot into a single
 * paragraph + a list of open questions for the reviewer to focus on.
 *
 * This module owns:
 *   - buildReviewSummaryPrompt: assemble the system + user prompts
 *     for vscode.lm, with budget-aware truncation per comment.
 *   - parseReviewSummaryOutput: split the model output into a
 *     paragraph + bullet list of open questions; tolerant to model
 *     drift (missing section header, alt prefixes, etc.).
 *   - shouldOfferReviewSummary: gating logic the controller uses to
 *     decide whether to even show the "AI summarise" action (also
 *     used in tests to lock the threshold).
 *
 * Pure - no vscode, no fs, no child_process. Tests in
 * test/git/reviewSummaryAi.test.ts.
 */

import { PrCommentEntry } from './prComments';

/**
 * Threshold above which the controller offers to summarise. We set it
 * high enough that on a small PR the reviewer just reads each comment;
 * the AI summary is for the "30-thread bikeshed" tail.
 */
export const REVIEW_SUMMARY_MIN_COMMENTS = 10;

export function shouldOfferReviewSummary(comments: PrCommentEntry[]): boolean {
  if (!Array.isArray(comments)) return false;
  const real = comments.filter(c => !!c.body && c.body.trim().length > 0);
  return real.length >= REVIEW_SUMMARY_MIN_COMMENTS;
}

export const REVIEW_SUMMARY_SYSTEM_PROMPT =
`You are a senior code reviewer summarising a long PR comment thread for a teammate who just walked in.

Output format (markdown, no code fences around the whole thing):

## Summary
<one paragraph, 3-6 sentences, describing the OVERALL state of the discussion: which themes recurred, the team's verdict so far (approving / blocking / unresolved), and any decisions that have been settled.>

## Open questions
- <terse question or unresolved decision that still needs a human reply>
- <one bullet per item, max 7 bullets, focus on what BLOCKS merge>

Rules:
- Be concrete. Reference file paths or function names verbatim when present.
- Skip resolved threads and emoji-only reactions.
- No marketing speak. No "the team has been working hard". No emoji.
- If a thread has clearly been resolved, do NOT list it as an open question.
- If there are no open questions, write a single bullet saying "All threads appear resolved."`;

/**
 * Build the user prompt body for the LM call. We pack the picker's
 * already-classified PrCommentEntry rows; the model gets enough
 * context (author, file:line, body) per row to reason about themes.
 *
 * Strategy:
 *   - Sort: resolved last, oldest first within each tier (so the
 *     model can follow the conversation timeline).
 *   - Budget: hard cap at maxBodyChars per comment (default 600);
 *     truncated comments get a `[...]` marker so the model knows
 *     content was elided.
 *   - Header line: `[1] inline @alice src/foo.ts:42 (resolved)`
 */
export function buildReviewSummaryPrompt(args: {
  comments: PrCommentEntry[];
  prNumber?: number;
  branch?: string;
  maxBodyChars?: number;
}): string {
  const maxBodyChars = args.maxBodyChars ?? 600;
  const sorted = sortForPrompt(args.comments);
  const lines: string[] = [];
  if (args.prNumber !== undefined) {
    lines.push(`PR #${args.prNumber}${args.branch ? ` on branch ${args.branch}` : ''}`);
  } else if (args.branch) {
    lines.push(`PR on branch ${args.branch}`);
  }
  lines.push(`Total comments: ${args.comments.length}, real content: ${sorted.length}`);
  lines.push('');
  lines.push('Conversation (oldest unresolved first, then resolved):');
  lines.push('');
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const header = formatCommentHeader(i + 1, c);
    lines.push(header);
    const body = truncateBody(c.body ?? '', maxBodyChars);
    for (const bl of body.split('\n')) lines.push(`  ${bl}`);
    lines.push('');
  }
  lines.push('Summarise the discussion using the format from the system prompt.');
  return lines.join('\n');
}

function formatCommentHeader(idx: number, c: PrCommentEntry): string {
  const parts: string[] = [];
  parts.push(`[${idx}]`);
  parts.push(c.kind);
  if (c.author) parts.push(`@${c.author}`);
  if (c.path) parts.push(`${c.path}${c.line ? `:${c.line}` : ''}`);
  if (c.reviewState) parts.push(`(${c.reviewState.toLowerCase()})`);
  if (c.state === 'resolved') parts.push('(resolved)');
  return parts.join(' ');
}

function truncateBody(body: string, max: number): string {
  if (body.length <= max) return body;
  const head = body.slice(0, Math.floor(max * 0.7));
  const tail = body.slice(body.length - Math.floor(max * 0.2));
  return `${head}\n[... truncated ${body.length - head.length - tail.length} chars ...]\n${tail}`;
}

function sortForPrompt(comments: PrCommentEntry[]): PrCommentEntry[] {
  const real = comments.filter(c => !!c.body && c.body.trim().length > 0);
  const tierRank: Record<string, number> = { unresolved: 0, unknown: 1, resolved: 2 };
  return real.slice().sort((a, b) => {
    const ta = tierRank[a.state] ?? 1;
    const tb = tierRank[b.state] ?? 1;
    if (ta !== tb) return ta - tb;
    const at = Date.parse(a.createdAt);
    const bt = Date.parse(b.createdAt);
    const aOk = Number.isFinite(at);
    const bOk = Number.isFinite(bt);
    if (aOk && bOk) return at - bt;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });
}

export interface ReviewSummaryParse {
  /** Plain-text summary paragraph (the body under `## Summary`). */
  paragraph: string;
  /** Each `- ` bullet under `## Open questions`. */
  questions: string[];
  /** True when the model said "all resolved" (single recognised bullet). */
  allResolved: boolean;
}

/**
 * Parse the AI output back into structured paragraph + questions.
 * Tolerant of:
 *   - missing section headers (treats whole body as paragraph)
 *   - alt header verbs ("Open issues", "Unresolved threads")
 *   - bullet markers `-`, `*`, `1.`
 *   - the "All threads appear resolved." sentinel from the system prompt
 */
export function parseReviewSummaryOutput(raw: string): ReviewSummaryParse {
  const safe = (raw ?? '').trim();
  if (!safe) return { paragraph: '', questions: [], allResolved: false };

  // Split into sections by ## headers.
  const sections = splitOnSectionHeaders(safe);
  let paragraph = '';
  let questions: string[] = [];
  if (sections.length === 0) {
    paragraph = safe;
  } else {
    for (const sec of sections) {
      const lower = sec.header.toLowerCase();
      const body = sec.body.trim();
      if (!body) continue;
      if (/(?:^|\b)(summary|overview|tl;?dr)\b/i.test(lower) && !paragraph) {
        paragraph = body;
      } else if (/(open\s+question|unresolved|open\s+issue|action)/i.test(lower) && questions.length === 0) {
        questions = extractBullets(body);
      } else if (!paragraph && !sec.header) {
        paragraph = body;
      }
    }
    if (!paragraph && sections.length) {
      // No labelled summary section - take the first non-empty section.
      paragraph = sections.find(s => s.body.trim().length > 0)?.body.trim() ?? '';
    }
  }
  const sentinel = /all threads?\s+(?:appear|are)\s+resolved/i;
  const allResolved = questions.length === 1 && sentinel.test(questions[0]);
  return { paragraph, questions, allResolved };
}

function splitOnSectionHeaders(body: string): { header: string; body: string }[] {
  const out: { header: string; body: string }[] = [];
  const lines = body.split('\n');
  let header = '';
  let buf: string[] = [];
  for (const ln of lines) {
    const m = /^\s{0,3}##\s+(.+?)\s*$/.exec(ln);
    if (m) {
      if (header || buf.length) out.push({ header, body: buf.join('\n') });
      header = m[1];
      buf = [];
    } else {
      buf.push(ln);
    }
  }
  if (header || buf.length) out.push({ header, body: buf.join('\n') });
  return out;
}

function extractBullets(section: string): string[] {
  const out: string[] = [];
  for (const raw of section.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(t);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * Render the parsed result back into a markdown body suitable for a
 * scratch document. Stable wording so a future "diff against last
 * summary" feature can mask the body.
 */
export function renderReviewSummary(parsed: ReviewSummaryParse, args: {
  prNumber?: number;
  commentCount: number;
}): string {
  const lines: string[] = [];
  const title = args.prNumber !== undefined
    ? `# PR #${args.prNumber} - Discussion Summary`
    : `# PR Discussion Summary`;
  lines.push(title);
  lines.push('');
  lines.push(`_Summary of ${args.commentCount} comment${args.commentCount === 1 ? '' : 's'}._`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(parsed.paragraph || '_(no summary produced)_');
  lines.push('');
  lines.push('## Open questions');
  lines.push('');
  if (parsed.allResolved || parsed.questions.length === 0) {
    lines.push('- All threads appear resolved.');
  } else {
    for (const q of parsed.questions) lines.push(`- ${q}`);
  }
  return lines.join('\n');
}
