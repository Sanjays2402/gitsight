/**
 * Pure helpers for the Forgotten-File Diagnostic (F39).
 *
 * Premise: when an engineer is about to commit, they often have a tab full
 * of related edits open. If they `git add foo bar baz` from the terminal,
 * it's easy to miss a sibling file they touched last Tuesday that ought to
 * land in the same commit (a config flip, a test fixture, a CHANGELOG
 * line). This module classifies the working-tree state into "the user
 * touched this file recently AND isn't currently staging it" so the
 * controller can surface a single, dismissable nudge before commit.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/forgottenFiles.test.ts.
 */

/** A file the user has touched in the last N days, with its modify-time. */
export interface RecentTouch {
  path: string;
  /** Last commit (authored) timestamp by the user, ISO 8601. */
  lastTouchedIso: string;
}

/** A file currently in the staging area (X column non-blank in porcelain). */
export interface StagedRow { path: string; }

/** A file present in the working tree (any porcelain row). */
export interface PorcelainRow {
  /** X column — staged status (M/A/D/R/C/U/?/!/' '). */
  x: string;
  /** Y column — worktree status. */
  y: string;
  path: string;
}

/**
 * Parse `git status --porcelain=v1` output. Stable across git versions and
 * easy to reason about. We don't try to expand renames here — the path is
 * always the *new* name for R/C entries.
 */
export function parsePorcelain(raw: string): PorcelainRow[] {
  const out: PorcelainRow[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.trim();
    if (!path) continue;
    out.push({ x, y, path });
  }
  return out;
}

/** Files that are currently staged (X column is something other than ' ' or '?'). */
export function stagedPaths(rows: PorcelainRow[]): string[] {
  return rows
    .filter(r => r.x !== ' ' && r.x !== '?')
    .map(r => r.path);
}

/** Files that have unstaged worktree changes (Y is M, D, etc). */
export function dirtyWorktreePaths(rows: PorcelainRow[]): string[] {
  return rows
    .filter(r => r.y !== ' ' && r.y !== '?' && r.y !== '!')
    .map(r => r.path);
}

/**
 * Parse `git log --since=<N>.days --name-only --pretty=format:%H|%aI`
 * output into a map of path -> most-recent ISO timestamp.
 *
 * Format:
 *
 *   <sha>|<iso>
 *   path/one.ts
 *   path/two.ts
 *   <blank line>
 *   <sha>|<iso>
 *   path/three.ts
 *   ...
 *
 * Multiple commits may touch the same path; we keep the newest (first seen
 * since `git log` is reverse-chronological).
 */
export function parseRecentTouches(raw: string): RecentTouch[] {
  const newest = new Map<string, string>();
  let currentIso: string | undefined;
  for (const line of (raw ?? '').split('\n')) {
    if (!line) { currentIso = undefined; continue; }
    if (line.includes('|') && /^[0-9a-f]+\|/.test(line)) {
      const pipe = line.indexOf('|');
      currentIso = line.slice(pipe + 1).trim();
      continue;
    }
    if (!currentIso) continue;
    if (!newest.has(line)) newest.set(line, currentIso);
  }
  return [...newest.entries()].map(([path, iso]) => ({ path, lastTouchedIso: iso }));
}

export interface ForgottenFile {
  path: string;
  lastTouchedIso: string;
  /** True when the file is *dirty in the worktree but not staged*. Higher confidence. */
  dirtyButUnstaged: boolean;
}

/**
 * Compute the forgotten-file list:
 *
 *   - file was authored by the user in the last N days (`recent`)
 *   - file is NOT currently in the staged set
 *   - AND (file is dirty in worktree OR ignoreClean=false)
 *
 * We surface dirty-but-unstaged with higher confidence because that's the
 * "user is editing it right now and forgot to add" case. A clean recently-
 * touched file is more often a deliberate omission, so we omit it by
 * default (`ignoreClean` defaults true).
 *
 * Excludes any path in `excludePaths` (used for the always-edit set:
 * lockfiles the user explicitly chose not to stage).
 */
export function findForgottenFiles(args: {
  recent: RecentTouch[];
  staged: string[];
  dirtyWorktree: string[];
  excludePaths?: string[];
  ignoreClean?: boolean;
}): ForgottenFile[] {
  const { recent, staged, dirtyWorktree } = args;
  const ignoreClean = args.ignoreClean ?? true;
  const stagedSet = new Set(staged);
  const dirtySet = new Set(dirtyWorktree);
  const excludeSet = new Set(args.excludePaths ?? []);
  const out: ForgottenFile[] = [];
  for (const r of recent) {
    if (stagedSet.has(r.path)) continue;
    if (excludeSet.has(r.path)) continue;
    const dirtyButUnstaged = dirtySet.has(r.path);
    if (ignoreClean && !dirtyButUnstaged) continue;
    out.push({
      path: r.path,
      lastTouchedIso: r.lastTouchedIso,
      dirtyButUnstaged,
    });
  }
  // Sort: dirty-but-unstaged first (highest confidence), then newer touches.
  out.sort((a, b) => {
    if (a.dirtyButUnstaged !== b.dirtyButUnstaged) return a.dirtyButUnstaged ? -1 : 1;
    return b.lastTouchedIso.localeCompare(a.lastTouchedIso);
  });
  return out;
}

/**
 * Render the summary used in the toast / status-bar tooltip.
 *
 *   "1 file edited recently isn't staged: src/foo.ts"
 *   "3 files edited recently aren't staged: src/foo.ts, src/bar.ts +1"
 */
export function summariseForgotten(files: ForgottenFile[]): string {
  if (!files.length) return 'No forgotten edits detected.';
  if (files.length === 1) {
    return `1 file edited recently isn't staged: ${files[0].path}`;
  }
  const shown = files.slice(0, 2).map(f => f.path).join(', ');
  const extra = files.length - 2;
  const tail = extra > 0 ? ` +${extra}` : '';
  return `${files.length} files edited recently aren't staged: ${shown}${tail}`;
}
