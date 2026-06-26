/**
 * Pure search-history + saved-filter model (W30).
 *
 * DOM-free + framework-free + NO @shared import, so it's unit-tested under
 * node --test. Owns the data shape + transforms for the graph search box's
 * recent/pinned queries; the view (searchHistory.ts) renders it and a thin
 * localStorage wrapper persists it. Keeping the rules pure means the
 * dedupe/cap/pin/reorder logic is covered without a DOM.
 *
 * Model: a single ordered list of entries, each {query, pinned}. Pinned
 * entries always sort before unpinned, and within each group newest-first
 * (recency = insertion order, most-recent at the front of its group). A
 * recorded query that already exists is moved to the front of its group
 * (and keeps its pinned state). Unpinned entries are capped; pinned ones
 * are never evicted.
 *
 * Tests: web/src/searchStore.test.mjs
 */

export interface SearchEntry {
  /** The exact query string (already trimmed). */
  query: string;
  /** Whether the user pinned this filter so it survives the recents cap. */
  pinned: boolean;
}

/** Default number of unpinned recents kept. */
export const DEFAULT_RECENT_LIMIT = 8;

/** Normalise a raw query for storage/compare (trim; collapse inner runs). */
export function normalizeQuery(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Sort entries for display: pinned first, then by their position in the
 * input list (which callers keep newest-first per group). Stable.
 */
export function sortEntries(entries: SearchEntry[]): SearchEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.pinned !== b.e.pinned) return a.e.pinned ? -1 : 1;
      return a.i - b.i;
    })
    .map(x => x.e);
}

/**
 * Record a query as the most-recent. Dedupes (case-sensitive on the
 * normalized form), moves an existing entry to the front of its group, and
 * caps the UNPINNED tail to `limit`. An empty/whitespace query is ignored
 * (returns the list unchanged). Returns a NEW array.
 */
export function recordQuery(
  entries: SearchEntry[],
  raw: string,
  limit: number = DEFAULT_RECENT_LIMIT,
): SearchEntry[] {
  const query = normalizeQuery(raw);
  if (!query) return entries;

  const existing = entries.find(e => e.query === query);
  const pinned = existing?.pinned ?? false;
  // Drop any existing copy, then push to the front (newest-first).
  const rest = entries.filter(e => e.query !== query);
  const next: SearchEntry[] = [{ query, pinned }, ...rest];

  return capUnpinned(next, limit);
}

/**
 * Toggle the pinned flag of a query. A pinned filter is protected from the
 * recents cap. No-op when the query isn't present. Returns a NEW array.
 */
export function togglePin(entries: SearchEntry[], raw: string): SearchEntry[] {
  const query = normalizeQuery(raw);
  const idx = entries.findIndex(e => e.query === query);
  if (idx === -1) return entries;
  const next = entries.map((e, i) => (i === idx ? { ...e, pinned: !e.pinned } : e));
  return next;
}

/** Remove a query from the list entirely. Returns a NEW array. */
export function removeQuery(entries: SearchEntry[], raw: string): SearchEntry[] {
  const query = normalizeQuery(raw);
  return entries.filter(e => e.query !== query);
}

/** Cap the UNPINNED entries to `limit`, keeping the most-recent (front). */
export function capUnpinned(entries: SearchEntry[], limit: number): SearchEntry[] {
  const cap = Math.max(0, Math.floor(limit));
  const out: SearchEntry[] = [];
  let unpinned = 0;
  for (const e of entries) {
    if (e.pinned) {
      out.push(e);
    } else if (unpinned < cap) {
      out.push(e);
      unpinned++;
    }
    // else: drop this overflow unpinned entry.
  }
  return out;
}

/**
 * Validate + coerce a parsed-JSON value into a clean entry list (defensive
 * against a corrupt/hand-edited localStorage blob). Drops malformed rows,
 * dedupes by normalized query (first wins), and trims fields.
 */
export function coerceEntries(value: unknown): SearchEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SearchEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const q = normalizeQuery((row as { query?: unknown }).query as string);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push({ query: q, pinned: (row as { pinned?: unknown }).pinned === true });
  }
  return out;
}

/**
 * Filter the stored entries for a typeahead: when the box already holds
 * `current`, show entries that START WITH it (but not the exact same string,
 * which would be a useless self-suggestion), sorted pinned-first. An empty
 * `current` returns all entries sorted. Caps the result to `max`.
 */
export function suggestEntries(
  entries: SearchEntry[],
  current: string,
  max = 8,
): SearchEntry[] {
  const cur = normalizeQuery(current).toLowerCase();
  const sorted = sortEntries(entries);
  const matched = cur
    ? sorted.filter(e => {
        const q = e.query.toLowerCase();
        return q !== cur && q.startsWith(cur);
      })
    : sorted;
  return matched.slice(0, Math.max(0, max));
}
