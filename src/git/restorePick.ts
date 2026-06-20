/**
 * Pure helpers for the Restore-from-Commit picker. Splitting these out lets us
 * unit-test the labelling / shortening rules without touching vscode or git.
 */

import { Commit } from './git';

export interface RestorePickItem {
  /** What appears as the QuickPick label, with leading icon. */
  label: string;
  /** "shortSha · author · timeAgo" line. */
  description: string;
  /** Short detail (first body line) capped at 120 chars. */
  detail: string;
  sha: string;
  shortSha: string;
  subject: string;
}

/** Truncate `s` to `n` chars, adding an ellipsis when shortened. */
export function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

export function buildRestorePickItems(
  commits: Commit[],
  ago: (d: Date) => string,
): RestorePickItem[] {
  return commits.map(c => ({
    label: `$(git-commit) ${c.subject}`,
    description: `${c.shortSha}  ·  ${c.author}  ·  ${ago(c.date)}`,
    detail: c.body ? truncate(c.body.split('\n')[0], 120) : c.sha,
    sha: c.sha,
    shortSha: c.shortSha,
    subject: c.subject,
  }));
}
