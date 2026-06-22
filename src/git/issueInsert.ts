/**
 * Pure helpers for the GitHub issue link inserter (F99).
 *
 * The view shells out to `gh issue list --json number,title,state,labels,
 * url,updatedAt,author,assignees` and we shape the rows into picker
 * entries here so the helpers are unit-testable without dragging gh
 * into the harness.
 *
 * Two insertion modes:
 *
 *   - cursor:   insert `#NN` (or `org/repo#NN` if `qualified=true`) at
 *               the active editor cursor. No SCM coupling.
 *   - trailer:  append `<KIND>: #NN` to the SCM commit message input
 *               box, where KIND defaults to "Closes" (semantically
 *               correct for the GitHub keyword behaviour). Trailer
 *               insertion composes with F73 commitFooter -- it uses
 *               the same blank-line-before-first-trailer convention.
 *
 * The trailer composer respects an existing trailer block: a second
 * `Closes: #NN` for the SAME issue is dropped (dedup), and additional
 * trailers append directly to the block with no extra blank line.
 *
 * Pure - no vscode, no child_process. Tests in test/git/issueInsert.test.ts.
 */

export type IssueState = 'OPEN' | 'CLOSED';

export interface IssueEntry {
  number: number;
  title: string;
  state: IssueState;
  url: string;
  labels: string[];
  authorLogin: string;
  assignees: string[];
  /** ISO 8601 string from gh. */
  updatedAt: string;
  /** True when the row is actually a Pull Request (gh issue list excludes PRs by default; we keep this for safety). */
  isPullRequest?: boolean;
}

/**
 * Parse `gh issue list --json ...` output. Tolerant of missing fields
 * and of the older shape where `author` is a plain string.
 */
export function parseIssueList(raw: string): IssueEntry[] {
  if (!raw || !raw.trim()) return [];
  let arr: any;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: IssueEntry[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const number = Number(r.number ?? 0);
    if (!Number.isFinite(number) || number <= 0) continue;
    const stateRaw = String(r.state ?? '').toUpperCase();
    const state: IssueState = stateRaw === 'CLOSED' ? 'CLOSED' : 'OPEN';
    out.push({
      number,
      title: String(r.title ?? '(no title)'),
      state,
      url: String(r.url ?? ''),
      labels: extractLabels(r.labels),
      authorLogin: extractAuthor(r.author),
      assignees: extractAssignees(r.assignees),
      updatedAt: String(r.updatedAt ?? ''),
      isPullRequest: !!r.isPullRequest || !!r.pullRequest,
    });
  }
  return out;
}

function extractAuthor(a: any): string {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return String(a.login ?? a.name ?? '');
}

function extractLabels(l: any): string[] {
  if (!Array.isArray(l)) return [];
  return l.map(x => typeof x === 'string' ? x : String(x?.name ?? '')).filter(Boolean);
}

function extractAssignees(a: any): string[] {
  if (!Array.isArray(a)) return [];
  return a.map(x => typeof x === 'string' ? x : String(x?.login ?? x?.name ?? '')).filter(Boolean);
}

/**
 * Sort issues: OPEN first, then by updatedAt desc. Pull-request rows
 * are sunk to the bottom (we expose them defensively but they're not
 * what the user asked for).
 */
export function sortIssuesForPicker(issues: IssueEntry[]): IssueEntry[] {
  const stateRank = (e: IssueEntry) => {
    if (e.isPullRequest) return 3;
    if (e.state === 'OPEN') return 0;
    return 1;
  };
  return issues.slice().sort((a, b) => {
    const sa = stateRank(a), sb = stateRank(b);
    if (sa !== sb) return sa - sb;
    // Updated-at descending.
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Format the picker label `#123 The issue title`.
 */
export function describeIssueLabel(e: IssueEntry): string {
  return `#${e.number} ${e.title}`;
}

/**
 * Format the secondary description: state, labels, assignee.
 */
export function describeIssueDetail(e: IssueEntry): string {
  const parts: string[] = [];
  if (e.state === 'CLOSED') parts.push('closed');
  if (e.assignees.length) parts.push('@' + e.assignees[0]);
  if (e.labels.length) parts.push(e.labels.slice(0, 3).map(l => '[' + l + ']').join(' '));
  if (e.authorLogin && !parts.some(p => p.startsWith('@'))) parts.push('by @' + e.authorLogin);
  return parts.join(' \u00B7 ');
}

/**
 * Reference shape for cursor insertion. `qualified=true` produces
 * `org/repo#NN`; false (default) produces `#NN`. The qualified form
 * is useful when the user is composing a comment that crosses
 * repositories (e.g. monorepo-style commit messages referencing
 * sibling repos).
 */
export function formatCursorReference(number: number, opts: { qualified?: boolean; repoSlug?: string } = {}): string {
  if (opts.qualified && opts.repoSlug) return `${opts.repoSlug}#${number}`;
  return `#${number}`;
}

/**
 * Recognised closing trailer kinds. GitHub's closing-keyword set per:
 * https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 *
 * We keep the canonical title-case form on insertion. The detection
 * regex (used by appendIssueTrailer) is case-insensitive.
 */
export type IssueTrailerKind = 'Closes' | 'Fixes' | 'Resolves' | 'Refs' | 'Related';

export const ISSUE_TRAILER_KINDS: IssueTrailerKind[] = ['Closes', 'Fixes', 'Resolves', 'Refs', 'Related'];

const TRAILER_LINE_RE = /^([A-Za-z][A-Za-z0-9\-]*?):\s+/;

/**
 * Append a `<kind>: #NN` trailer to a commit-message body. Mirrors
 * the F73 commitFooter convention:
 *
 *   - If `existing` has no trailer block, the trailer goes after a
 *     blank line separator.
 *   - If `existing` already ends in a trailer block, the trailer
 *     joins it with NO extra blank line.
 *   - If the SAME (kind, number) already appears in the trailer
 *     block (case-insensitive on kind, exact-match on the number),
 *     it's deduplicated -- the original message is returned unchanged.
 *
 * The reference is formatted via formatCursorReference (so the same
 * qualified-vs-bare logic applies). Tests pin the trailer block
 * detection logic.
 */
export function appendIssueTrailer(
  existing: string,
  kind: IssueTrailerKind,
  number: number,
  opts: { qualified?: boolean; repoSlug?: string } = {},
): { result: string; appended: boolean } {
  const ref = formatCursorReference(number, opts);
  const trailer = `${kind}: ${ref}`;
  const body = existing ?? '';

  // Find the existing trailer block (consecutive lines at the end
  // that look like `Key: value`). The block must be preceded by a
  // blank line OR start at the beginning of the message - this is
  // the same convention git-interpret-trailers uses, and it means
  // a single-line body like `feat: add x` is NOT treated as a
  // trailer block (which would otherwise be ambiguous with a
  // conventional-commit header).
  const lines = body.split('\n');
  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && lines[lastNonBlank].trim() === '') lastNonBlank--;
  let trailerStart = lastNonBlank + 1; // sentinel = no trailer block found
  for (let i = lastNonBlank; i >= 0; i--) {
    const ln = lines[i];
    if (ln.trim() === '') break;
    if (TRAILER_LINE_RE.test(ln)) { trailerStart = i; continue; }
    break;
  }
  // Validate: the trailer block must be preceded by a blank line OR
  // start at line 0 - AND in the at-line-0 case the body must have
  // more than just this one line. Otherwise we treat the candidate
  // line as the conventional-commit subject (which is body text,
  // not a trailer). Pure trailer blocks always sit after a body.
  if (trailerStart <= lastNonBlank) {
    const beforeIdx = trailerStart - 1;
    if (beforeIdx >= 0 && lines[beforeIdx].trim() !== '') {
      trailerStart = lastNonBlank + 1; // reset: no trailer block.
    } else if (beforeIdx < 0) {
      // No preceding line - the candidate trailer block IS the entire
      // body. That can't be right: a trailer block needs a subject
      // to trail. Treat the whole thing as subject/body.
      trailerStart = lastNonBlank + 1;
    }
  }

  // Dedup check: same kind + number already present?
  if (trailerStart <= lastNonBlank) {
    for (let i = trailerStart; i <= lastNonBlank; i++) {
      const ln = lines[i];
      const m = TRAILER_LINE_RE.exec(ln);
      if (!m) continue;
      const existingKind = m[1].toLowerCase();
      if (existingKind !== kind.toLowerCase()) continue;
      const value = ln.slice(m[0].length).trim();
      // The value can be `#NN` or `#NN, #MM` etc. Split on commas.
      const refs = value.split(',').map(s => s.trim());
      if (refs.includes(ref)) return { result: body, appended: false };
    }
  }

  // No trailer block yet -> blank-line separator before trailer.
  if (trailerStart > lastNonBlank) {
    const base = body.replace(/\s*$/, '');
    const sep = base ? '\n\n' : '';
    return { result: base + sep + trailer, appended: true };
  }

  // Trailer block exists -> append directly with no blank line.
  // Reconstruct: lines [0..lastNonBlank] + new trailer.
  const newLines = lines.slice(0, lastNonBlank + 1);
  newLines.push(trailer);
  return { result: newLines.join('\n'), appended: true };
}

/**
 * For the SCM input box, where the "message" is typically a single
 * paragraph (no body), the trailer goes after a blank line. The
 * appendIssueTrailer helper handles the empty-body case correctly
 * (`base ? '\\n\\n' : ''`) so the result is `Closes: #NN` alone when
 * the input was empty.
 *
 * This thin wrapper just exists for readability at the call site.
 */
export function appendIssueTrailerToScmInput(
  inputValue: string,
  kind: IssueTrailerKind,
  number: number,
  opts: { qualified?: boolean; repoSlug?: string } = {},
): { result: string; appended: boolean } {
  return appendIssueTrailer(inputValue, kind, number, opts);
}

/**
 * Markdown-link form for documentation / PR descriptions:
 *   [#123](https://github.com/org/repo/issues/123)
 *
 * Used by the picker's "Insert markdown link" action.
 */
export function formatMarkdownLink(e: IssueEntry, opts: { qualified?: boolean; repoSlug?: string } = {}): string {
  const ref = formatCursorReference(e.number, opts);
  return `[${ref}](${e.url})`;
}
