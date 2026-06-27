/**
 * Pure presentation helpers for the compare view (W18).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The
 * compare view (compareView.ts) owns the DOM; the pure string/number
 * transforms live here. Imports the shared CompareFile type via a relative
 * .ts path so Node resolves it without the @shared Vite alias.
 *
 * Tests: web/src/compareFormat.test.mjs
 */

import type { CompareFile, CompareFileStatus, CompareCommit } from '../../src/shared/rangeCompare.ts';

/** Single-letter glyph for a compare file status (monochrome chrome). */
export function compareGlyph(status: CompareFileStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
    default:
      return '?';
  }
}

/** Human label for a compare file status (tooltip / aria). */
export function compareLabel(status: CompareFileStatus): string {
  return status === 'typechange' ? 'type change' : status;
}

/** Churn cell parts for one compare file: `+N -M`, `binary`, or `0`. */
export interface CompareChurn {
  binary: boolean;
  insertions: number;
  deletions: number;
  text: string;
}

export function compareChurn(file: CompareFile): CompareChurn {
  if (file.binary) return { binary: true, insertions: 0, deletions: 0, text: 'binary' };
  const ins = Math.max(0, file.insertions);
  const del = Math.max(0, file.deletions);
  const segs: string[] = [];
  if (ins > 0) segs.push(`+${ins}`);
  if (del > 0) segs.push(`-${del}`);
  return { binary: false, insertions: ins, deletions: del, text: segs.length ? segs.join(' ') : '0' };
}

/** Split a path into directory + filename (dim dir, emphasise base). */
export function splitComparePath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * Normalise + validate a user-entered ref so a stray flag/space can't be
 * smuggled toward the companion (which also guards via isSafeRev, but a
 * client-side check gives instant feedback). Returns the trimmed ref or
 * null when it's empty / obviously unsafe.
 */
export function sanitizeRef(ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  if (/[\s]/.test(r)) return null;
  if (r.startsWith('-')) return null;
  if (r.length > 200) return null;
  return r;
}

// ── Commit-list filtering (W54) ──────────────────────────────────────

/** The minimal commit shape the compare commit-list filter matches against. */
export type FilterableCommit = Pick<CompareCommit, 'sha' | 'shortSha' | 'author' | 'subject'>;

/** Normalise a commit-filter query: trimmed + lowercased. */
export function normalizeCommitQuery(query: string): string {
  return (query ?? '').trim().toLowerCase();
}

/**
 * Whether a single commit matches a (raw) query (W54). An empty/whitespace
 * query matches everything. Otherwise the lowercased query must be a
 * substring of the subject, the author, or either sha form — so you can find
 * a commit in a wide ahead/behind column by what you remember about it
 * (a word from the message, who wrote it, or a sha prefix).
 */
export function commitMatchesQuery(commit: FilterableCommit, query: string): boolean {
  const q = normalizeCommitQuery(query);
  if (!q) return true;
  if (commit.subject.toLowerCase().includes(q)) return true;
  if (commit.author.toLowerCase().includes(q)) return true;
  if (commit.sha.toLowerCase().includes(q)) return true;
  if (commit.shortSha.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Filter a commit list by a subject/author/sha query (W54). Preserves the
 * input order and identity (returns the same objects). An empty query returns
 * a fresh copy of the list so callers can treat the result uniformly.
 */
export function filterCompareCommits<T extends FilterableCommit>(commits: T[], query: string): T[] {
  const q = normalizeCommitQuery(query);
  if (!q) return commits.slice();
  return commits.filter(c => commitMatchesQuery(c, q));
}

/**
 * The first commit matching a query across the two compare columns (W62), or
 * null when none match (or the query is empty). `ahead` is searched before
 * `behind` so pressing Enter in the filter box resolves to the commit unique
 * to head first — the side users are usually hunting in. Order within a column
 * is preserved (newest-first as the columns render).
 */
export function firstCompareMatch<T extends FilterableCommit>(
  ahead: T[],
  behind: T[],
  query: string,
): T | null {
  const q = normalizeCommitQuery(query);
  if (!q) return null;
  for (const c of ahead) if (commitMatchesQuery(c, q)) return c;
  for (const c of behind) if (commitMatchesQuery(c, q)) return c;
  return null;
}
