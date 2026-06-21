/**
 * Pure helpers for the rerere Cache Visualizer (F63).
 *
 * `git rerere` ("reuse recorded resolution") caches the way you resolved a
 * conflict the first time so the same conflict re-applies itself
 * automatically. Cache entries live under `.git/rr-cache/<sha1>/`:
 *
 *   preimage         the conflicted hunks as they appeared
 *   postimage        the saved resolution
 *   thisimage        the current conflicted hunks (during conflict)
 *   path             the file path the resolution belongs to (optional)
 *
 * Stale resolutions are a foot-gun — they auto-apply silently and can
 * resurrect old code or hide a real conflict. This module parses the cache
 * dir listing into a list of entries, classifies each (resolved vs
 * resolved-but-stale vs in-flight), and exposes a "forget" helper that
 * removes a specific cache by its sha.
 *
 * Pure — no vscode, no child_process. Tests in test/git/rerereCache.test.ts.
 */

export type RerereStatus =
  | 'resolved'        // both preimage + postimage present, no in-flight thisimage
  | 'in-flight'       // thisimage present — a conflict is happening RIGHT NOW
  | 'orphaned'        // preimage present, no postimage AND no thisimage — half-baked
  | 'unknown';

export interface RerereCacheEntry {
  /** SHA-1 directory name under .git/rr-cache/. */
  hash: string;
  /** Status derived from which files exist in the entry's directory. */
  status: RerereStatus;
  /** Repo-relative path the resolution targets, when the entry recorded one. */
  path?: string;
  /**
   * Last-modified time of the entry directory (or the youngest contained
   * file) in ms since epoch — used for staleness ranking.
   */
  lastModifiedMs: number;
  /** Age in days at the time `now` was sampled (Infinity when unknown). */
  ageDays: number;
  /**
   * Conflict signature derived from the first/last hunk markers in the
   * preimage — enough for the picker `description` so the user can
   * recognise the conflict without opening it.
   */
  preimageSignature?: string;
  /** Size of the postimage in bytes (0 when missing). */
  postimageBytes: number;
}

/** Convert a millisecond-since-epoch timestamp into days (rounded down). */
export function ageDaysFrom(lastModifiedMs: number, now: number): number {
  if (!Number.isFinite(lastModifiedMs) || lastModifiedMs <= 0) return Infinity;
  const diff = now - lastModifiedMs;
  if (diff <= 0) return 0;
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

export interface RawEntryFiles {
  /** Hash directory name. */
  hash: string;
  /** True when preimage exists in the entry dir. */
  hasPreimage: boolean;
  /** True when postimage exists. */
  hasPostimage: boolean;
  /** True when thisimage exists (conflict in flight). */
  hasThisimage: boolean;
  /** Content of `path` file inside the entry dir (optional). */
  pathFileContent?: string;
  /** Lower bound of last-modified time for any file in the entry. */
  lastModifiedMs: number;
  /** Bytes of the postimage (0 when missing). */
  postimageBytes: number;
  /** First/last hunks from the preimage (signature). */
  preimageHead?: string;
  preimageTail?: string;
}

export function classifyStatus(raw: RawEntryFiles): RerereStatus {
  if (raw.hasThisimage) return 'in-flight';
  if (raw.hasPreimage && raw.hasPostimage) return 'resolved';
  if (raw.hasPreimage && !raw.hasPostimage) return 'orphaned';
  return 'unknown';
}

/** Build a printable conflict signature from a preimage head/tail. */
export function deriveSignature(head?: string, tail?: string): string | undefined {
  const h = (head ?? '').trim().split('\n').slice(0, 2).join(' \u2026 ').trim();
  const t = (tail ?? '').trim().split('\n').slice(-1).join(' ').trim();
  const merged = [h, t].filter(Boolean).join('  \u2192  ');
  if (!merged) return undefined;
  return merged.length > 120 ? merged.slice(0, 117) + '\u2026' : merged;
}

/** Combine RawEntryFiles inputs into the public RerereCacheEntry shape. */
export function buildEntry(raw: RawEntryFiles, now: number): RerereCacheEntry {
  const path = raw.pathFileContent ? raw.pathFileContent.trim().split('\n')[0] || undefined : undefined;
  return {
    hash: raw.hash,
    status: classifyStatus(raw),
    path,
    lastModifiedMs: raw.lastModifiedMs,
    ageDays: ageDaysFrom(raw.lastModifiedMs, now),
    preimageSignature: deriveSignature(raw.preimageHead, raw.preimageTail),
    postimageBytes: raw.postimageBytes,
  };
}

/**
 * Sort entries for the picker:
 *   1. in-flight first (most urgent: a conflict is happening right now)
 *   2. orphaned next (broken state, worth investigating)
 *   3. resolved sorted oldest-first (likely-stale at the top)
 */
const STATUS_RANK: Record<RerereStatus, number> = {
  'in-flight': 0,
  'orphaned': 1,
  'resolved': 2,
  'unknown': 3,
};

export function sortEntries(entries: RerereCacheEntry[]): RerereCacheEntry[] {
  return [...entries].sort((a, b) => {
    const sa = STATUS_RANK[a.status];
    const sb = STATUS_RANK[b.status];
    if (sa !== sb) return sa - sb;
    // Oldest first within the same bucket (most likely to be stale).
    if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;
    return a.hash.localeCompare(b.hash);
  });
}

export interface RerereSummary {
  total: number;
  resolved: number;
  inFlight: number;
  orphaned: number;
  /** Number of resolved entries past `staleAfterDays`. */
  staleResolved: number;
}

export function summariseEntries(entries: RerereCacheEntry[], staleAfterDays: number): RerereSummary {
  const out: RerereSummary = {
    total: entries.length,
    resolved: 0,
    inFlight: 0,
    orphaned: 0,
    staleResolved: 0,
  };
  for (const e of entries) {
    if (e.status === 'resolved') out.resolved++;
    else if (e.status === 'in-flight') out.inFlight++;
    else if (e.status === 'orphaned') out.orphaned++;
    if (e.status === 'resolved' && e.ageDays >= staleAfterDays) out.staleResolved++;
  }
  return out;
}

/** Build the one-line picker title. */
export function describeSummary(s: RerereSummary, staleAfterDays: number): string {
  if (s.total === 0) return 'rerere cache empty';
  const bits: string[] = [];
  bits.push(`${s.total} entr${s.total === 1 ? 'y' : 'ies'}`);
  if (s.inFlight) bits.push(`${s.inFlight} in-flight`);
  if (s.staleResolved) bits.push(`${s.staleResolved} stale (>${staleAfterDays}d)`);
  if (s.orphaned) bits.push(`${s.orphaned} orphaned`);
  return bits.join(' \u00b7 ');
}

/**
 * Render the per-row description used by the picker (status + age + path).
 *
 *   "resolved \u00b7 124d \u00b7 src/foo.ts"
 *   "in-flight \u00b7 active conflict"
 *   "orphaned \u00b7 14d"
 */
export function describeEntry(e: RerereCacheEntry): string {
  const age = Number.isFinite(e.ageDays) ? `${e.ageDays}d` : 'unknown age';
  const bits = [e.status, age];
  if (e.path) bits.push(e.path);
  return bits.join(' \u00b7 ');
}

/**
 * Validate a rerere hash. Cache directories are 40-char sha1 hex strings.
 * We reject anything else to avoid `rm -rf .git/rr-cache/..` style mishaps
 * if the picker handed us a malformed string.
 */
const SHA1_RE = /^[0-9a-f]{40}$/;
export function isValidRerereHash(s: string): boolean {
  return SHA1_RE.test(s);
}
