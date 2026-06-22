/**
 * Pure helpers for PR Draft Auto-Sync (F77).
 *
 * After a successful push to a branch that has an open draft PR, this
 * feature rewrites the PR body with a fresh "what's in this draft so far"
 * summary derived from the new `<base>..HEAD` range. The premise: while
 * the work is still draft, the body should be living-document-y; once you
 * mark ready for review, you don't want it auto-edited any more.
 *
 * Body shape (stable so tests can assert on it):
 *
 *   <user-prologue, preserved verbatim above the marker>
 *
 *   <!-- GITSIGHT:PR-DRAFT-SYNC -->
 *   ## Commits (N)
 *
 *   - abc1234 fix: foo
 *   - def5678 refactor: bar
 *
 *   ## Files (N)
 *
 *   - src/foo.ts
 *   - src/bar.ts
 *
 *   _Last synced 2026-06-21 22:47 PDT by GitSight._
 *   <!-- /GITSIGHT:PR-DRAFT-SYNC -->
 *
 *   <user-epilogue, preserved verbatim below the closing marker>
 *
 * The marker sentinels let us round-trip the body cleanly: anything the
 * user typed above or below them is preserved across syncs.
 *
 * Pure — no vscode, no child_process. Tests in test/git/prDraftSync.test.ts.
 */

export const SYNC_OPEN_MARKER = '<!-- GITSIGHT:PR-DRAFT-SYNC -->';
export const SYNC_CLOSE_MARKER = '<!-- /GITSIGHT:PR-DRAFT-SYNC -->';

export interface PrSyncCommit {
  shortSha: string;
  subject: string;
}

export interface PrSyncInput {
  commits: PrSyncCommit[];
  files: string[];
  /** Local-time string for the footer; caller provides so we don't drag
   *  time-zone deps into a pure helper. */
  syncedAt: string;
}

export interface OpenDraftPr {
  number: number;
  url: string;
  headRefName: string;
  isDraft: boolean;
  body: string;
}

/**
 * Parse the JSON from `gh pr view --json number,url,headRefName,isDraft,body`.
 * Returns undefined when the JSON isn't a recognisable shape, or when the
 * PR isn't actually a draft (the auto-sync should silently skip non-drafts).
 */
export function parseOpenDraftPr(raw: string): OpenDraftPr | undefined {
  if (!raw || !raw.trim()) return undefined;
  let obj: any;
  try { obj = JSON.parse(raw); }
  catch { return undefined; }
  if (!obj || typeof obj !== 'object') return undefined;
  const number = Number(obj.number ?? 0);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return {
    number,
    url: String(obj.url ?? ''),
    headRefName: String(obj.headRefName ?? ''),
    isDraft: !!obj.isDraft,
    body: String(obj.body ?? ''),
  };
}

/**
 * Build the canonical "managed block" we splice into the PR body. The
 * block is bracketed by the open/close markers so we can detect and
 * rewrite it on subsequent syncs without touching user-authored prose.
 */
export function buildSyncBlock(input: PrSyncInput): string {
  const lines: string[] = [SYNC_OPEN_MARKER, ''];
  if (input.commits.length === 0) {
    lines.push('_No commits ahead of base yet._');
  } else {
    lines.push(`## Commits (${input.commits.length})`, '');
    for (const c of input.commits) {
      // Trim subject defensively: a malformed log line with a `\n` in the
      // subject would otherwise break the markdown bullet.
      const subject = c.subject.replace(/[\r\n]+/g, ' ').trim();
      lines.push(`- ${c.shortSha} ${subject}`);
    }
  }
  lines.push('');
  if (input.files.length === 0) {
    lines.push('_No file changes yet._');
  } else {
    lines.push(`## Files (${input.files.length})`, '');
    for (const f of input.files) {
      lines.push(`- ${f}`);
    }
  }
  lines.push('');
  lines.push(`_Last synced ${input.syncedAt} by GitSight._`);
  lines.push(SYNC_CLOSE_MARKER);
  return lines.join('\n');
}

/**
 * Splice the managed block into an existing PR body. If the body already
 * contains a previous block (marker pair), replace it in place; otherwise
 * append the block to the end, separated by a blank line.
 *
 * Anything the user wrote outside the markers is preserved byte-for-byte.
 */
export function injectSyncBlock(existingBody: string, block: string): string {
  const open = existingBody.indexOf(SYNC_OPEN_MARKER);
  const close = existingBody.indexOf(SYNC_CLOSE_MARKER);
  if (open >= 0 && close > open) {
    const before = existingBody.slice(0, open);
    const after = existingBody.slice(close + SYNC_CLOSE_MARKER.length);
    // Trim trailing whitespace on `before` and leading whitespace on `after`
    // so we don't drift towards a wall of blank lines after many syncs.
    const beforeTrimmed = before.replace(/[ \t]+$/g, '');
    const afterTrimmed = after.replace(/^[\r\n]+/, '\n');
    return `${beforeTrimmed}${block}${afterTrimmed}`;
  }
  const trimmed = (existingBody ?? '').replace(/[\r\n\s]+$/g, '');
  if (!trimmed) return block;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Parse the stdout of `git log <base>..HEAD --pretty=format:%h|%s`. Returns
 * the commits oldest-first (matching the natural reading order in a PR
 * timeline), capped at the supplied maximum to keep the body readable.
 *
 * Note: `git log` defaults to newest-first; we reverse the parsed result
 * before returning so the PR body reads chronologically from base to head.
 */
export function parseCommitsForSync(raw: string, max: number): PrSyncCommit[] {
  if (!raw) return [];
  const out: PrSyncCommit[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('|');
    if (idx <= 0) continue;
    const shortSha = trimmed.slice(0, idx).trim();
    const subject = trimmed.slice(idx + 1).trim();
    if (!shortSha) continue;
    out.push({ shortSha, subject });
  }
  // Oldest-first read more naturally in a PR description than reverse-chron.
  const reversed = out.reverse();
  return reversed.slice(-Math.max(0, max));
}

/**
 * Parse `git diff --name-only <base>..HEAD` into a sorted, deduplicated
 * list. Caps at `max` rows so a 200-file refactor doesn't pollute the body.
 */
export function parseFilesForSync(raw: string, max: number): string[] {
  if (!raw) return [];
  const set = new Set<string>();
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  const sorted = [...set].sort();
  return sorted.slice(0, Math.max(0, max));
}

/**
 * Decide whether the body needs an update. Returns true when:
 *   - the body doesn't yet contain the managed block, OR
 *   - the block contents would differ from the freshly-rendered block.
 *
 * Useful so we don't make a no-op `gh pr edit` call on every push.
 */
export function needsRewrite(currentBody: string, freshBlock: string): boolean {
  const open = currentBody.indexOf(SYNC_OPEN_MARKER);
  const close = currentBody.indexOf(SYNC_CLOSE_MARKER);
  if (open < 0 || close < open) return true;
  const existingBlock = currentBody.slice(open, close + SYNC_CLOSE_MARKER.length);
  // Compare ignoring the timestamp line (which always changes) so we don't
  // rewrite the body just because the clock advanced.
  return stripTimestamp(existingBlock) !== stripTimestamp(freshBlock);
}

function stripTimestamp(block: string): string {
  return block.replace(/_Last synced [^_]+_/g, '_Last synced TIMESTAMP_');
}
