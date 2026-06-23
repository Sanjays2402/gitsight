/**
 * Pure helpers for F133 - Stash Patch Auto-Discovery (companion to F131).
 *
 * The F131 import command requires the user to run `gitsight.importStashPatch`
 * explicitly. F133 closes the loop: when a .patch file APPEARS in the
 * configured export directory (or workspace root) WHILE VS Code is open
 * we surface a one-time toast offering to apply it. Common scenarios:
 *
 *   - Teammate emailed you a stash patch -> you saved it to the workspace.
 *   - You exported via F127 on another machine, synced via Dropbox.
 *   - `git diff > something.patch` from terminal alongside the IDE.
 *
 * The view layer owns the FileSystemWatcher; this module owns the
 * change classification, dedup, and one-time-per-session bookkeeping
 * so we don't toast on the same file twice (which would be hostile UX
 * during e.g. a save-on-rename storm).
 *
 * Pure - no vscode, no fs. Tests in test/git/stashPatchDiscovery.test.ts.
 */

import { PatchPayloadInfo, parseGitSightFilename } from './stashPatchImport';

/**
 * Verdict for a discovered patch file. The view layer feeds (path, info)
 * + the in-memory dismissed set; we decide whether to fire a toast.
 *
 *   - 'offer'           -> show the "Apply patch?" toast
 *   - 'silent-gitsight' -> we recognise our own stamp; offer with a
 *                          friendlier label (no "is this safe?" warning)
 *   - 'skip-invalid'    -> body doesn't look like a patch (empty, binary,
 *                          random text); never offer
 *   - 'skip-dismissed'  -> the user already said "Not now" this session
 *   - 'skip-stale'      -> file's mtime is older than the freshness window
 *                          (avoids toasting on a `.patch` that's been
 *                          sitting in the workspace for weeks)
 */
export type DiscoveryVerdict =
  | 'offer'
  | 'silent-gitsight'
  | 'skip-invalid'
  | 'skip-dismissed'
  | 'skip-stale';

export interface DiscoveryArgs {
  /** Absolute path to the .patch file. */
  absPath: string;
  /** Inspection result from inspectPatchPayload. */
  info: PatchPayloadInfo;
  /** File mtime in milliseconds since epoch (from fs.stat). */
  mtimeMs: number;
  /** Reference "now" - caller supplies so tests don't drift. */
  nowMs: number;
  /** Session-only dismissed file paths (absolute). */
  dismissed: ReadonlySet<string>;
  /** Files older than this many minutes are considered stale. Default 60. */
  freshnessWindowMinutes?: number;
}

export interface DiscoveryDecision {
  verdict: DiscoveryVerdict;
  /** Human-readable reason for the verdict (test assertions + logging). */
  reason: string;
}

export function classifyDiscoveredPatch(args: DiscoveryArgs): DiscoveryDecision {
  const { absPath, info, mtimeMs, nowMs, dismissed } = args;
  const windowMin = args.freshnessWindowMinutes ?? 60;
  if (!absPath) return { verdict: 'skip-invalid', reason: 'no path' };
  if (dismissed.has(absPath)) {
    return { verdict: 'skip-dismissed', reason: 'user dismissed this file in this session' };
  }
  if (!info.looksValid) {
    return { verdict: 'skip-invalid', reason: 'body has no diff --git or From: header' };
  }
  if (info.fileCount === 0) {
    return { verdict: 'skip-invalid', reason: 'no diff --git markers in body' };
  }
  // Staleness: any patch older than freshnessWindow is suppressed. Mtime
  // in the future is treated as "just appeared" (clock skew handling).
  const ageMin = Math.max(0, (nowMs - mtimeMs) / 60_000);
  if (ageMin > windowMin) {
    return { verdict: 'skip-stale', reason: `file is ${Math.round(ageMin)}m old (window ${windowMin}m)` };
  }
  if (info.gitsightMeta) {
    return { verdict: 'silent-gitsight', reason: 'matches GitSight stamp format' };
  }
  return { verdict: 'offer', reason: 'fresh, valid patch from outside GitSight' };
}

/**
 * Compose the one-line toast message shown for a discovered patch. The
 * view layer concatenates this with the file basename.
 *
 *   silent-gitsight  -> "Apply <basename>? Looks like a GitSight export."
 *   offer            -> "Apply <basename>? N file change<s>."
 */
export function describeDiscoveryToast(
  basename: string,
  info: PatchPayloadInfo,
  verdict: DiscoveryVerdict,
): string {
  const filesBlurb = info.fileCount > 0
    ? `${info.fileCount} file change${info.fileCount === 1 ? '' : 's'}`
    : 'no recognisable changes';
  if (verdict === 'silent-gitsight') {
    const meta = info.gitsightMeta;
    const branchHint = meta?.sourceBranch ? ` (GitSight export on \`${meta.sourceBranch}\`)` : ' (GitSight export)';
    return `GitSight: apply patch \`${basename}\`${branchHint}? ${filesBlurb}.`;
  }
  return `GitSight: apply patch \`${basename}\`? ${filesBlurb}.`;
}

/**
 * Detect whether a path looks like a candidate .patch we'd discover.
 *
 * Used by the FileSystemWatcher to filter out noise BEFORE we even
 * read the file body. Accepts .patch and .diff extensions; skips
 * dot-prefixed temp files (.foo.patch.swp etc).
 */
export function looksLikePatchPath(absPath: string): boolean {
  if (!absPath) return false;
  const base = absPath.split('/').pop() ?? absPath;
  if (!base) return false;
  if (base.startsWith('.')) return false; // skip dot-temp files
  const lower = base.toLowerCase();
  return lower.endsWith('.patch') || lower.endsWith('.diff');
}

/**
 * Dedup helper - given a list of (path, mtime) tuples, return only
 * the freshest entry per path (some watchers fire onChange + onCreate
 * for the same file in quick succession). Sorted by mtime descending
 * so the caller can process newest-first.
 */
export interface DiscoveredEntry {
  absPath: string;
  mtimeMs: number;
}

export function dedupAndSortDiscoveries(entries: DiscoveredEntry[]): DiscoveredEntry[] {
  const byPath = new Map<string, DiscoveredEntry>();
  for (const e of entries) {
    if (!e.absPath) continue;
    const prev = byPath.get(e.absPath);
    if (!prev || e.mtimeMs > prev.mtimeMs) {
      byPath.set(e.absPath, e);
    }
  }
  return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Build a short "where did this come from?" hint string for the
 * toast detail line. Combines what we know from the filename stamp
 * (F127 export format) + the payload first line.
 *
 *   "On main (subject: fix login retry) - 4 files - 2026-06-23"
 *   "Subject: Backport NN to release/* - 12 files"
 *   "3 files - 215 KB"
 *
 * Returns empty string when there's nothing useful to add (the toast
 * stays clean and we don't bury the action buttons under a wall of
 * meta-text).
 */
export function buildDiscoveryDetail(info: PatchPayloadInfo, sizeBytes?: number): string {
  const parts: string[] = [];
  const meta = info.gitsightMeta;
  if (meta?.sourceBranch) parts.push(`on ${meta.sourceBranch}`);
  if (meta?.subject) parts.push(`subject: ${meta.subject}`);
  if (!meta && info.firstLine) {
    parts.push(info.firstLine.length > 80 ? info.firstLine.slice(0, 77) + '\u2026' : info.firstLine);
  }
  if (info.fileCount > 0) {
    parts.push(`${info.fileCount} file${info.fileCount === 1 ? '' : 's'}`);
  }
  if (typeof sizeBytes === 'number' && sizeBytes > 0) {
    parts.push(formatBytes(sizeBytes));
  }
  if (meta?.date) parts.push(meta.date);
  return parts.join(' \u00b7 ');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Wrap parseGitSightFilename for callers that don't want to import
 * the import module directly - keeps the watcher's import surface tight.
 */
export function isGitSightExportFilename(filename: string): boolean {
  return parseGitSightFilename(filename) !== undefined;
}

/**
 * Decide whether the watcher should LIST a directory at all. Skips
 * .git, node_modules, dist, build, out - the patch may legitimately
 * live anywhere a user puts it, but recursive scans through node_modules
 * would be catastrophic on a monorepo.
 */
const PRUNE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'out-test',
  '.next',
  '.cache',
  '.turbo',
  'target',
  'vendor',
]);

export function isPrunedDirectory(name: string): boolean {
  return PRUNE_DIRS.has(name);
}
