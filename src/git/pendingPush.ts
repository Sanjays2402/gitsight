/**
 * Pure helpers for the "What Will Push?" picker.
 *
 * Parses `git log <upstream>..HEAD --pretty=...` output into typed commit
 * structures and computes a one-line summary (count, authors, paths
 * touched) suitable for clipboard / status-bar use.
 *
 * Pure — no vscode, no child_process. Tests in test/git/pendingPush.test.ts.
 */

export interface PendingCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** ISO 8601 timestamp (whatever `--date=iso-strict` returned). */
  dateIso: string;
  subject: string;
}

export interface PendingSummary {
  /** Total pending commits. */
  count: number;
  /** Distinct author names, alphabetised. */
  authors: string[];
  /** Files modified at least once across the pending range. */
  filesTouched: number;
}

/**
 * Parse stdout from:
 *
 *   git log --pretty=format:'%H|%h|%an|%ae|%aI|%s' <upstream>..HEAD
 *
 * One commit per line, fields separated by `|`. The subject may itself
 * contain `|`, so anything after the fifth separator is joined back together
 * to reconstruct the original subject.
 */
export function parsePendingLog(raw: string): PendingCommit[] {
  const out: PendingCommit[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 6) continue;
    const [sha, shortSha, author, email, dateIso, ...rest] = parts;
    out.push({
      sha,
      shortSha,
      author,
      email,
      dateIso,
      subject: rest.join('|'),
    });
  }
  return out;
}

/**
 * Build the one-line pill summary: "5 commits · 2 authors · 14 files".
 * When there are zero pending commits, returns a friendly idle string so
 * callers can render the same widget unconditionally.
 */
export function summarizePending(commits: PendingCommit[], filesTouched: number): PendingSummary {
  const authors = [...new Set(commits.map(c => c.author).filter(Boolean))].sort();
  return { count: commits.length, authors, filesTouched };
}

export function describePending(s: PendingSummary): string {
  if (s.count === 0) return 'Nothing to push';
  const bits = [
    `${s.count} commit${s.count === 1 ? '' : 's'}`,
    `${s.authors.length} author${s.authors.length === 1 ? '' : 's'}`,
    `${s.filesTouched} file${s.filesTouched === 1 ? '' : 's'}`,
  ];
  return bits.join(' \u00b7 ');
}

/**
 * Convert pending commits to a copy-friendly shortlog block (oneline).
 */
export function shortlogText(commits: PendingCommit[]): string {
  return commits.map(c => `${c.shortSha}  ${c.subject}  (${c.author})`).join('\n');
}

/**
 * Group authors with their pending commit counts: "Alice (3), Bob (2)".
 * Sorted by count desc, ties broken alphabetically.
 */
export function authorBreakdown(commits: PendingCommit[]): string {
  const counts = new Map<string, number>();
  for (const c of commits) counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, n]) => `${name} (${n})`)
    .join(', ');
}
