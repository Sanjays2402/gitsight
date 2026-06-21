/**
 * Pure helpers for the "Compare Working Tree to Any Commit" feature (F44).
 *
 * Given the list of files changed between a target commit and the working
 * tree, render the QuickPick entries (commit picker + per-file picker) and
 * format the summary line. Pure — no vscode, no child_process. Tested in
 * test/git/workingTreeCompare.test.ts.
 */

import { Commit, FileChange } from './git';

export interface CommitPickRow {
  /** What appears as the QuickPick label, with leading icon. */
  label: string;
  /** "shortSha · author · timeAgo" line. */
  description: string;
  /** Short detail (first body line) capped at 120 chars, or the full SHA. */
  detail: string;
  sha: string;
  shortSha: string;
  subject: string;
}

export function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Build the commit picker rows. Same shape as the existing restorePick
 * helper, kept independent so callers can pre/post-filter the commit list
 * without coupling to the other feature.
 */
export function buildCommitPickRows(commits: Commit[], ago: (d: Date) => string): CommitPickRow[] {
  return commits.map(c => ({
    label: `$(git-commit) ${c.subject}`,
    description: `${c.shortSha}  ·  ${c.author}  ·  ${ago(c.date)}`,
    detail: c.body ? truncate(c.body.split('\n')[0], 120) : c.sha,
    sha: c.sha,
    shortSha: c.shortSha,
    subject: c.subject,
  }));
}

export interface FileDiffRow {
  /** Repo-relative path of the file (post-rename for R/C). */
  path: string;
  /** Single-letter status: M / A / D / R / C / etc. */
  status: string;
  /** Human label for the picker. */
  label: string;
  /** Picker description column. */
  description: string;
  /** True when this row represents a deletion (worktree no longer has the file). */
  deleted: boolean;
  /** True when this row represents an addition (the commit didn't have it). */
  added: boolean;
}

/** Long-form name for the one-letter status code. */
export function describeStatus(status: string): string {
  switch (status) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    case 'U': return 'unmerged';
    case '?': return 'untracked';
    default: return status;
  }
}

/** Build the per-file picker rows for a list of FileChange entries. */
export function buildFileDiffRows(changes: FileChange[]): FileDiffRow[] {
  return changes.map(c => {
    const deleted = c.status === 'D';
    const added = c.status === 'A';
    const icon = deleted ? '$(diff-removed)' : added ? '$(diff-added)' : '$(diff-modified)';
    const label = `${icon} ${c.path}`;
    const description = describeStatus(c.status);
    return { path: c.path, status: c.status, label, description, deleted, added };
  });
}

/**
 * Render the one-line summary for the picker placeholder.
 *
 *   "Working tree vs abc1234 — 4 files (2 modified, 1 added, 1 deleted)"
 */
export function summariseChanges(shortSha: string, changes: FileChange[]): string {
  if (!changes.length) return `Working tree matches ${shortSha} — no differences`;
  const counts: Record<string, number> = {};
  for (const c of changes) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const ordered = ['M', 'A', 'D', 'R', 'C', 'T', 'U', '?'];
  const parts: string[] = [];
  for (const code of ordered) {
    const n = counts[code];
    if (!n) continue;
    parts.push(`${n} ${describeStatus(code)}`);
  }
  // Catch any unknown status codes we didn't list.
  for (const [code, n] of Object.entries(counts)) {
    if (!ordered.includes(code)) parts.push(`${n} ${describeStatus(code)}`);
  }
  const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
  const word = changes.length === 1 ? 'file' : 'files';
  return `Working tree vs ${shortSha} — ${changes.length} ${word}${breakdown}`;
}

/**
 * Render a markdown summary for the report action.
 *
 *   # Working tree vs abc1234 ("feat: subject")
 *
 *   - **modified** src/foo.ts
 *   - **added** src/bar.ts
 *   - **deleted** src/baz.ts
 */
export function formatMarkdownReport(shortSha: string, subject: string, changes: FileChange[]): string {
  const lines: string[] = [];
  lines.push(`# Working tree vs ${shortSha} ("${subject.replace(/"/g, '\\"')}")`);
  lines.push('');
  if (!changes.length) {
    lines.push('_No differences — your working tree matches this commit byte-for-byte._');
    return lines.join('\n');
  }
  for (const c of changes) {
    lines.push(`- **${describeStatus(c.status)}** \`${c.path}\``);
  }
  return lines.join('\n');
}

/** Parse `git diff --name-status <sha>` output (no `--diff-filter`). */
export function parseDiffNameStatus(raw: string): FileChange[] {
  const out: FileChange[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const status = parts[0][0];
    if (status === 'R' || status === 'C') {
      if (parts.length < 3) continue;
      out.push({ status, oldPath: parts[1], path: parts[2] });
    } else {
      out.push({ status, path: parts[1] });
    }
  }
  return out;
}
