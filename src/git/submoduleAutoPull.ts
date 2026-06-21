/**
 * Pure helpers for the Submodule Auto-Pull watcher (F70).
 *
 * Mirrors the F28 lockfile-watch shape but for submodule gitlink moves.
 * When the parent repo's HEAD moves between two SHAs (pull / merge /
 * rebase / branch switch), `git diff --raw <prev>..<head>` lists every
 * file whose tree object changed; submodule gitlinks show up with mode
 * `160000` on either side. Those rows are exactly the submodules the
 * user "received" with the ref move and probably wants to `git submodule
 * update --init` for.
 *
 * Output of `git diff --raw -z <prev>..<head>` is NUL-separated records,
 * each shaped:
 *
 *   ":<src-mode> <dst-mode> <src-sha> <dst-sha> <status>\0<path>\0"
 *
 * (For renames, the path token is two NUL-separated paths.)
 *
 * We only care about the (mode-related) presence of `160000` on either
 * side. Status A means a submodule was added, M means its recorded sha
 * moved, D means it was removed.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/submoduleAutoPull.test.ts.
 */

export type SubmoduleGitlinkStatus = 'added' | 'modified' | 'removed';

export interface SubmoduleGitlinkChange {
  path: string;
  status: SubmoduleGitlinkStatus;
  /** SHA the submodule pointed to BEFORE the parent ref move. Empty for added. */
  prevSha: string;
  /** SHA the submodule points to AFTER the parent ref move. Empty for removed. */
  newSha: string;
}

const GITLINK_MODE = '160000';

/**
 * Parse `git diff --raw -z <prev>..<head>` output, returning only the
 * rows that touch a submodule gitlink. Empty input safely returns [].
 */
export function parseGitlinkChanges(raw: string): SubmoduleGitlinkChange[] {
  if (!raw) return [];
  const out: SubmoduleGitlinkChange[] = [];
  // Records are separated by NUL bytes. The first token starts with ':'
  // (the raw diff header) and is followed by the path token(s).
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (!head) { i++; continue; }
    if (!head.startsWith(':')) { i++; continue; }
    // Header: ":<src-mode> <dst-mode> <src-sha> <dst-sha> <status>"
    const m = /^:(\d{6})\s+(\d{6})\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([A-Z]\d*)$/.exec(head);
    if (!m) { i++; continue; }
    const srcMode = m[1];
    const dstMode = m[2];
    const srcSha = m[3];
    const dstSha = m[4];
    const status = m[5][0]; // first char: A/M/D/R/C/T
    // Rename/copy rows have two path tokens; everything else has one.
    const path = tokens[i + 1] ?? '';
    const skipRename = (status === 'R' || status === 'C') ? 1 : 0;
    i += 2 + skipRename;
    if (!path) continue;
    if (srcMode !== GITLINK_MODE && dstMode !== GITLINK_MODE) continue;
    const change: SubmoduleGitlinkChange | undefined = (() => {
      if (status === 'A' && dstMode === GITLINK_MODE) {
        return { path, status: 'added' as const, prevSha: '', newSha: dstSha };
      }
      if (status === 'D' && srcMode === GITLINK_MODE) {
        return { path, status: 'removed' as const, prevSha: srcSha, newSha: '' };
      }
      if (srcMode === GITLINK_MODE && dstMode === GITLINK_MODE) {
        return { path, status: 'modified' as const, prevSha: srcSha, newSha: dstSha };
      }
      // Mode flip (e.g. M turning a file into a submodule or vice versa)
      // — treat as added or removed depending on direction.
      if (srcMode !== GITLINK_MODE && dstMode === GITLINK_MODE) {
        return { path, status: 'added' as const, prevSha: '', newSha: dstSha };
      }
      if (srcMode === GITLINK_MODE && dstMode !== GITLINK_MODE) {
        return { path, status: 'removed' as const, prevSha: srcSha, newSha: '' };
      }
      return undefined;
    })();
    if (change) out.push(change);
  }
  return out;
}

/** Compact title used in the toast: "2 submodules updated by pull: vendor/x, libs/y". */
export function summariseGitlinkChanges(changes: SubmoduleGitlinkChange[]): string {
  if (!changes.length) return 'No submodule changes';
  const n = changes.length;
  const word = n === 1 ? 'submodule' : 'submodules';
  const names = changes.map(c => c.path).slice(0, 3).join(', ');
  const tail = n > 3 ? `, +${n - 3} more` : '';
  return `${n} ${word} changed: ${names}${tail}`;
}

/**
 * Build a list of suggested actions for a set of changes. The watcher
 * surfaces them as toast buttons (up to 3) and the full list in a
 * follow-up picker.
 */
export interface UpdateAction {
  /** Subset of changes this action applies to. Empty = "all changes". */
  paths: string[];
  /** The git args to run. */
  args: string[];
  /** Human label for the toast button / picker row. */
  label: string;
}

export function suggestUpdateActions(changes: SubmoduleGitlinkChange[]): UpdateAction[] {
  if (!changes.length) return [];
  const out: UpdateAction[] = [];
  const added = changes.filter(c => c.status === 'added');
  const modified = changes.filter(c => c.status === 'modified');
  const removed = changes.filter(c => c.status === 'removed');

  if (added.length || modified.length) {
    const targets = [...added, ...modified].map(c => c.path);
    out.push({
      paths: targets,
      args: ['submodule', 'update', '--init', '--recursive', '--', ...targets],
      label: `Init + update ${targets.length} submodule${targets.length === 1 ? '' : 's'}`,
    });
  }
  if (added.length || modified.length) {
    // Catch-all when the user is happy to recurse everything (matches
    // the F59 submodule pill `init` action).
    out.push({
      paths: changes.map(c => c.path),
      args: ['submodule', 'update', '--init', '--recursive'],
      label: 'Init + update all submodules',
    });
  }
  if (removed.length) {
    out.push({
      paths: removed.map(r => r.path),
      args: ['submodule', 'deinit', '-f', '--', ...removed.map(r => r.path)],
      label: `Deinit ${removed.length} removed submodule${removed.length === 1 ? '' : 's'}`,
    });
  }
  return out;
}

/**
 * Cooldown key: lets the watcher avoid spamming the same toast across
 * a multi-step rebase. We key by repo + the sorted set of changed
 * paths so a different rebase step (touching different submodules)
 * still surfaces.
 */
export function cooldownKey(repoRoot: string, changes: SubmoduleGitlinkChange[]): string {
  const paths = changes.map(c => c.path).sort().join('|');
  return `${repoRoot}::${paths}`;
}
