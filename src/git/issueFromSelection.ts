/**
 * Pure helpers for "Open issue from selection" (F104).
 *
 * Composes in REVERSE with F99 (which inserts a #NN reference at
 * the cursor from a remote issue picker): this slice goes the OTHER
 * way — the user selects code that has a `// TODO: ...` or
 * `// FIXME: ...` comment, and we shape a `gh issue create --title
 * ... --body ...` payload from it.
 *
 * The shaping does:
 *
 *   1. Strip the language's comment delimiters (//, #, /*, --, ;, %)
 *      and collapse multi-line block comments into a single body.
 *   2. Extract the marker prefix (TODO / FIXME / XXX / HACK / NOTE /
 *      OPTIMIZE / REVIEW) so we can stamp a sensible default label.
 *   3. Compose a title from the first non-empty body line (capped at
 *      72 chars to keep GitHub's title rail tidy).
 *   4. Attach a permalink BLOCK to the body (file path + line range
 *      + host-aware permalink + code fence) so the issue lands with
 *      enough context to reopen the right place.
 *   5. Classify a "sanity" verdict (`empty` / `marker-only` /
 *      `selection-only` / `full` / `too-large`) so the view layer
 *      can gate noisy submissions.
 *
 * Pure - no fs, no vscode. Tests in test/git/issueFromSelection.test.ts.
 */

import { buildPermalinkUrl } from './prCommentCompose';

export type IssueMarkerKind = 'TODO' | 'FIXME' | 'XXX' | 'HACK' | 'NOTE' | 'OPTIMIZE' | 'REVIEW' | 'BUG' | null;

export type SelectionVerdict = 'empty' | 'marker-only' | 'selection-only' | 'full' | 'too-large';

export interface IssueDraft {
  title: string;
  body: string;
  /** Marker kind if detected (TODO, FIXME, etc.). Drives default label. */
  marker: IssueMarkerKind;
  /** Suggested label set — view layer maps to `gh issue create --label`. */
  suggestedLabels: string[];
  verdict: SelectionVerdict;
}

export interface ComposeOpts {
  /** Editor selection's verbatim text (newline-joined). */
  selection: string;
  /** Repo-root-relative POSIX path of the file. */
  relPath: string;
  /** 1-indexed start line. */
  startLine: number;
  /** 1-indexed end line (inclusive). */
  endLine: number;
  /** Optional remote URL — used to build the permalink. */
  remoteUrl?: string;
  /** Optional SHA to anchor the permalink at. Defaults to undefined (caller may pick branch). */
  commitSha?: string;
  /** Optional branch name when no SHA. */
  branch?: string;
  /** Language ID — used for the fenced block tag. */
  languageId?: string;
  /** Max body length (chars) before we trim. Defaults to 8000. */
  maxBodyChars?: number;
}

const MARKER_RX = /\b(TODO|FIXME|XXX|HACK|NOTE|OPTIMIZE|REVIEW|BUG)\b/;

/**
 * Recognise the leading comment delimiter and return the comment-stripped
 * text + the marker kind (if present).
 *
 * Handles:
 *
 *   // TODO: text                  -> { text: 'text', marker: 'TODO' }
 *   # FIXME(scope): text           -> { text: 'text', marker: 'FIXME' }  (scope dropped)
 *   /\* TODO: text *\/             -> { text: 'text', marker: 'TODO' }
 *   <!-- TODO: text -->            -> { text: 'text', marker: 'TODO' }
 *   -- HACK: text                  -> { text: 'text', marker: 'HACK' }
 *   ; NOTE: text                   -> { text: 'text', marker: 'NOTE' }
 *
 * Lines with no comment delimiter come back as { text: line.trim(), marker: null }.
 */
export function stripCommentLine(line: string): { text: string; marker: IssueMarkerKind } {
  // 1. Detect + strip delimiter prefix.
  let raw = line.replace(/^\s+/, '');
  let stripped = raw;
  // HTML / block comment open + close
  stripped = stripped.replace(/^<!--\s*/, '').replace(/\s*-->$/, '');
  stripped = stripped.replace(/^\/\*+\s*/, '').replace(/\s*\*+\/$/, '');
  // Line-comment delimiters
  stripped = stripped.replace(/^(\/\/+|#+|--+|;+|%+|\*+)\s*/, '');
  // 2. Extract marker (preserve everything after the colon / paren).
  const m = MARKER_RX.exec(stripped);
  let marker: IssueMarkerKind = null;
  let text = stripped;
  if (m) {
    marker = m[1] as IssueMarkerKind;
    // Drop the marker word and an optional `(scope)` parenthetical and the
    // trailing colon / dash.
    text = stripped.slice(0, m.index) + stripped.slice(m.index + m[0].length);
    text = text.replace(/^\s*\([^)]*\)\s*[:\-]\s*/, '');
    text = text.replace(/^\s*[:\-]\s*/, '');
  }
  return { text: text.trim(), marker };
}

/**
 * Walk every line in `selection`, strip its comment delimiter, and
 * return:
 *   - The first non-null marker seen (drives label).
 *   - The merged body text (one line per non-empty stripped line).
 *
 * If NO marker is detected anywhere AND every line has a comment
 * delimiter, we treat the selection as "still a comment dump" and
 * return marker=null + text=stripped-bodies.
 *
 * If most lines have NO comment delimiter, we treat the selection as
 * "raw code" and return { text: selection-verbatim, marker: null } —
 * the view layer's gate will recognise this and steer the user
 * toward a different flow (or pre-fill an empty title and let the
 * user write the description manually).
 */
export function extractBodyFromSelection(selection: string): { text: string; marker: IssueMarkerKind } {
  if (!selection) return { text: '', marker: null };
  const lines = selection.split('\n');
  let firstMarker: IssueMarkerKind = null;
  const stripped: string[] = [];
  let commentLines = 0;
  for (const line of lines) {
    if (!line.trim()) { stripped.push(''); continue; }
    // Did the line START with a comment delimiter (or whitespace + one)?
    const isComment = /^\s*(\/\/+|#+|--+|;+|%+|\*+|<!--|\/\*+)/.test(line);
    const parsed = stripCommentLine(line);
    if (isComment) commentLines++;
    if (parsed.marker && !firstMarker) firstMarker = parsed.marker;
    stripped.push(isComment ? parsed.text : line);
  }
  const looksLikeComments = commentLines > 0 && commentLines / lines.filter(l => l.trim()).length >= 0.6;
  if (looksLikeComments) {
    // Trim leading/trailing empty lines from the stripped output.
    while (stripped.length && !stripped[0].trim()) stripped.shift();
    while (stripped.length && !stripped[stripped.length - 1].trim()) stripped.pop();
    return { text: stripped.join('\n'), marker: firstMarker };
  }
  return { text: selection.trim(), marker: firstMarker };
}

/**
 * Build the title from the first non-empty line of body text. Cap at
 * 72 chars (GitHub UI starts ellipsising around 80, 72 keeps the
 * title rail readable on the PR/issue list).
 */
export function suggestTitleFromBody(body: string, marker: IssueMarkerKind): string {
  const first = body.split('\n').find(l => l.trim()) ?? '';
  let title = first.trim().replace(/[.!?]\s*$/, ''); // drop trailing punctuation
  if (!title) {
    title = marker ? `${marker}: ` : '';
  }
  if (title.length > 72) title = title.slice(0, 69).trimEnd() + '\u2026';
  return title;
}

/**
 * Map a marker kind to a default label list. Bugs become `bug`,
 * performance hints become `performance`, etc. NOTE/REVIEW intentionally
 * have no default label because they map to too-broad categories.
 */
export function defaultLabelsForMarker(marker: IssueMarkerKind): string[] {
  switch (marker) {
    case 'FIXME': return ['bug'];
    case 'BUG': return ['bug'];
    case 'XXX': return ['bug'];
    case 'HACK': return ['tech-debt'];
    case 'OPTIMIZE': return ['performance'];
    case 'TODO': return [];
    case 'NOTE': return [];
    case 'REVIEW': return [];
    case null: return [];
  }
}

/**
 * Compose the full issue draft. The body looks like:
 *
 *   <stripped comment text>
 *
 *   <!-- Permalink block: file path + line range + host link -->
 *   In `<relPath>:L<start>-L<end>`:
 *   <link to host permalink>
 *
 *   ```<lang>
 *   <verbatim selection>
 *   ```
 */
export function composeIssueDraft(opts: ComposeOpts): IssueDraft {
  const sel = opts.selection ?? '';
  const verdict = classifySelection(sel);
  const { text, marker } = extractBodyFromSelection(sel);

  let title = suggestTitleFromBody(text, marker);
  if (!title.trim() && verdict === 'selection-only') {
    title = `Issue from \`${opts.relPath}:${opts.startLine}\``;
  }

  const labels = defaultLabelsForMarker(marker);

  // Permalink. buildPermalinkUrl needs the host base (the bare repo
  // URL, e.g. https://github.com/foo/bar). The view layer is in
  // charge of host-detect + remoteWebUrl resolution; we just compose.
  const permalink = opts.remoteUrl
    ? buildPermalinkUrl(opts.remoteUrl, opts.commitSha ?? opts.branch ?? 'HEAD', opts.relPath, opts.startLine, opts.endLine)
    : undefined;

  const codeFence = makeCodeFence(sel, opts.languageId);

  const ref = opts.startLine === opts.endLine ? `L${opts.startLine}` : `L${opts.startLine}-L${opts.endLine}`;
  const headerLink = permalink
    ? `[\`${opts.relPath}:${ref}\`](${permalink})`
    : `\`${opts.relPath}:${ref}\``;

  const bodyParts: string[] = [];
  if (text) bodyParts.push(text);
  bodyParts.push(`In ${headerLink}:`);
  bodyParts.push(codeFence);

  let body = bodyParts.join('\n\n');
  const maxBody = opts.maxBodyChars ?? 8000;
  if (body.length > maxBody) {
    body = body.slice(0, maxBody - 50) + '\n\n<!-- truncated -->';
  }

  return { title, body, marker, suggestedLabels: labels, verdict };
}

export function classifySelection(sel: string): SelectionVerdict {
  if (!sel || !sel.trim()) return 'empty';
  const lines = sel.split('\n');
  const nonEmpty = lines.filter(l => l.trim()).length;
  if (nonEmpty === 0) return 'empty';
  if (nonEmpty > 400) return 'too-large';
  // Marker-only: the entire selection's body collapses to a single line
  // containing only the marker, e.g. `// TODO`.
  const { text, marker } = extractBodyFromSelection(sel);
  if (marker && !text) return 'marker-only';
  if (!marker) return 'selection-only';
  return 'full';
}

/**
 * Build a fenced code block. Mirrors the F87 prFromSelection language
 * mapping convention (typescriptreact -> tsx, plaintext -> '', strip
 * non-alphanumerics from anything weird).
 */
function makeCodeFence(text: string, languageId?: string): string {
  const lang = normaliseFenceLang(languageId);
  // Pick a fence longer than any run-of-backticks in the body so the
  // fence terminates correctly even if the selection contains ``` itself.
  const longestBackticks = (text.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  const fence = '`'.repeat(Math.max(3, longestBackticks + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

function normaliseFenceLang(lang?: string): string {
  if (!lang) return '';
  const lc = lang.toLowerCase();
  if (lc === 'typescriptreact') return 'tsx';
  if (lc === 'javascriptreact') return 'jsx';
  if (lc === 'plaintext') return '';
  return lc.replace(/[^a-z0-9+#.-]/g, '');
}

/**
 * Build the `gh issue create` argv (without the leading `gh issue
 * create`). Caller writes the body to stdin. Returns string[] so the
 * view can hand it straight to execFile.
 */
export function buildGhIssueArgs(draft: IssueDraft, extraLabels: string[] = []): string[] {
  const args = ['issue', 'create', '--title', draft.title, '--body-file', '-'];
  const labelSet = new Set([...draft.suggestedLabels, ...extraLabels]);
  for (const lbl of labelSet) {
    if (!lbl.trim()) continue;
    args.push('--label', lbl);
  }
  return args;
}
