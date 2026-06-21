/**
 * Pure helpers for the Selection History feature (F23).
 *
 * Given a selection range `[start, end]` (1-indexed, inclusive), compute the
 * sanitised range to feed `git log -L<start>,<end>:<file>` and format the
 * resulting commit list as a human-readable markdown report.
 *
 * The git CLI is picky about -L:
 *   - line numbers must be 1-indexed
 *   - start must be <= end
 *   - start must be >= 1
 *   - end <= file's last line (we cap at the caller's reported line count)
 *
 * We also support "no selection" (caret on a single line) which collapses
 * to a single-line range.
 *
 * Pure — no vscode, no child_process. Tests in test/git/selectionHistory.test.ts.
 */

export interface LineRange { start: number; end: number; }

/**
 * Normalise a selection into the inclusive 1-indexed range git wants.
 * VS Code passes us 0-indexed lines + an exclusive end column; we don't
 * care about the column, only the line numbers, so the caller should pass
 * `selection.start.line` / `selection.end.line` already.
 *
 * The resulting end is clamped to lineCount (so a selection that runs to
 * EOF doesn't trip "Invalid line range" from git).
 */
export function normaliseSelection(
  startLine0: number,
  endLine0: number,
  lineCount: number,
): LineRange {
  // 0-indexed -> 1-indexed.
  let start = Math.max(1, startLine0 + 1);
  let end = Math.max(start, endLine0 + 1);
  // If the user selected to the very start of a line (VS Code reports the
  // selection end as that line, column 0), the visible selection actually
  // stops on the previous line. We keep the wider range because git's -L
  // is inclusive and the user usually wants "anything that touched the
  // text I see selected".
  if (lineCount > 0) end = Math.min(end, lineCount);
  if (start > end) start = end;
  return { start, end };
}

export interface SelectionHistoryCommit {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
}

/**
 * Parse stdout from:
 *
 *   git log -L<start>,<end>:<file> --pretty=format:'%H|%h|%an|%aI|%s' --no-patch
 *
 * `--no-patch` is what makes the output line-per-commit; without it git
 * includes the diff for each touch which is gigabytes for hot files.
 */
export function parseHistoryLog(raw: string): SelectionHistoryCommit[] {
  const out: SelectionHistoryCommit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [sha, shortSha, author, dateIso, ...rest] = parts;
    out.push({ sha, shortSha, author, dateIso, subject: rest.join('|') });
  }
  return out;
}

/**
 * Render the markdown report opened in the side editor.
 *
 *   # History of foo.ts L12-L30 (8 commits)
 *
 *   - abc1234  feat: extract helper  · Alice  · 2026-06-20
 *   - ...
 */
export function formatHistoryMarkdown(
  filePath: string,
  range: LineRange,
  commits: SelectionHistoryCommit[],
): string {
  const lines: string[] = [];
  const header = range.start === range.end
    ? `${filePath} L${range.start}`
    : `${filePath} L${range.start}-L${range.end}`;
  lines.push(`# History of ${header} (${commits.length} commit${commits.length === 1 ? '' : 's'})`);
  lines.push('');
  if (!commits.length) {
    lines.push('_No history found for this range. The lines may be too fresh or come from an untracked file._');
    return lines.join('\n');
  }
  for (const c of commits) {
    const date = (c.dateIso || '').slice(0, 10);
    lines.push(`- \`${c.shortSha}\`  ${escapeMd(c.subject)}  ·  ${escapeMd(c.author)}  ·  ${date}`);
  }
  lines.push('');
  lines.push('_Generated via `git log -L<start>,<end>:<file>`. Each commit changed at least one line in the range._');
  return lines.join('\n');
}

function escapeMd(s: string): string {
  return (s ?? '').replace(/([`*_])/g, '\\$1');
}

/**
 * Build the literal `-L<start>,<end>:<relpath>` argument string used by git
 * log. Repo-relative path, no escaping (git accepts spaces inside `:`).
 */
export function formatLArg(range: LineRange, relPath: string): string {
  return `-L${range.start},${range.end}:${relPath}`;
}
