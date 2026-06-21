/**
 * Pure helpers for the Recent Branches MRU command.
 *
 * `git checkout -` only remembers ONE branch back. Engineers context-switch a
 * dozen times an afternoon; remembering five branches deep is the point of a
 * good IDE integration. This module turns `git reflog` into an ordered MRU
 * list of branches, deduplicated and ready for the picker.
 *
 * Pure — no vscode, no child_process. Tests in test/git/recentBranches.test.ts.
 */

export interface RecentBranchEntry {
  /** The branch the user moved TO. */
  name: string;
  /** ISO 8601 timestamp of the last checkout that landed on this branch. */
  lastCheckoutIso: string;
  /** How many times the branch appears in the scanned reflog window. */
  count: number;
}

/**
 * Parse stdout from:
 *
 *   git reflog --date=iso-strict --grep-reflog='checkout: moving from' -n <N>
 *
 * Each line looks like:
 *
 *   <sha> HEAD@{2026-06-20T12:30:45-07:00}: checkout: moving from <from> to <to>
 *
 * We extract `<to>` (the branch the user moved onto) and the timestamp, ignore
 * detached-HEAD landings (a 40-char hex `<to>`), dedupe newest-first, and
 * optionally drop the currently-checked-out branch.
 *
 * `excludeCurrent` is matched by exact name; pass the active branch so the
 * picker doesn't show "the branch you're already on" as the top option.
 */
export function parseCheckoutReflog(
  raw: string,
  opts: { excludeCurrent?: string; limit?: number } = {},
): RecentBranchEntry[] {
  const limit = opts.limit ?? 10;
  const exclude = opts.excludeCurrent;
  const seen = new Map<string, RecentBranchEntry>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = REFLOG_RE.exec(line);
    if (!m) continue;
    const iso = m[1];
    const to = m[2];
    // Skip detached-HEAD landings — a full SHA isn't a branch name worth
    // jumping back to from a picker (the user would use the commit graph for
    // that).
    if (isDetachedSha(to)) continue;
    if (exclude && to === exclude) continue;
    const existing = seen.get(to);
    if (existing) {
      existing.count++;
      // Keep the most recent timestamp: reflog is newest-first, so the first
      // hit already wins; nothing to do for lastCheckoutIso.
    } else {
      seen.set(to, { name: to, lastCheckoutIso: iso, count: 1 });
    }
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * Matches the canonical reflog line emitted by
 * `--grep-reflog='checkout: moving from' --date=iso-strict`. Captures (1) the
 * ISO timestamp and (2) the destination ref name.
 *
 * The `to` capture stops at end-of-line. Branch names can contain '/', '-',
 * '_', '.', and most printable ASCII; we accept any non-whitespace sequence
 * and let `isDetachedSha` filter out raw commit landings.
 */
const REFLOG_RE = /HEAD@\{([^}]+)\}: checkout: moving from \S+ to (\S+)/;

const SHA_RE = /^[0-9a-f]{40}$/;
export function isDetachedSha(s: string): boolean {
  return SHA_RE.test(s);
}

/**
 * Human-readable age for an ISO-8601 timestamp, matched to the existing
 * `timeAgo` formatter shape ("3m", "2h", "5d", "3w", "4mo", "2y").
 *
 * Kept inline here (instead of importing format.ts) so the pure module has
 * zero internal coupling and can be unit-tested without dragging extra src/
 * paths into tsconfig.test.json.
 */
export function ageLabel(isoTimestamp: string, now = Date.now()): string {
  const t = Date.parse(isoTimestamp);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}
