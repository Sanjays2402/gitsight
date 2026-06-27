/**
 * Pure path-substring file filtering (W50).
 *
 * DOM-free + framework-free + NO @shared alias, so it's unit-tested under
 * node --test. When a commit (detail panel) or a range (compare view)
 * touches many files, a small filter box narrows the list to paths matching
 * a query. Both surfaces share this matcher so the behaviour is identical.
 *
 * Matching is case-insensitive and substring-based against the file path
 * (and, for renames, the old path too — so a rename still shows when you
 * search for either name). A whitespace-only query matches everything.
 *
 * Tests: web/src/fileFilter.test.mjs
 */

/** The minimal shape a filterable file row needs (detail + compare share it). */
export interface FilterableFile {
  path: string;
  oldPath?: string;
}

/** Normalise a query: trimmed + lowercased. Empty when nothing to match. */
export function normalizeFileQuery(query: string): string {
  return (query ?? '').trim().toLowerCase();
}

/**
 * Whether a single file matches a (raw) query. An empty/whitespace query
 * matches everything. Otherwise the lowercased query must be a substring of
 * the path or — for renames/copies — the old path, so searching either side
 * of a rename keeps the row.
 */
export function fileMatchesQuery(file: FilterableFile, query: string): boolean {
  const q = normalizeFileQuery(query);
  if (!q) return true;
  if (file.path.toLowerCase().includes(q)) return true;
  if (file.oldPath && file.oldPath.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Filter a file list by a path-substring query (W50). Preserves the input
 * order and identity (returns the same objects). An empty query returns the
 * list unchanged (a new array) so callers can treat the result uniformly.
 */
export function filterFileChanges<T extends FilterableFile>(files: T[], query: string): T[] {
  const q = normalizeFileQuery(query);
  if (!q) return files.slice();
  return files.filter(f => fileMatchesQuery(f, q));
}
