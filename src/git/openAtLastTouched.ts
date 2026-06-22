/**
 * Pure helpers for the "Open at last touched commit" CodeAction (F66).
 *
 * Mirror of the recentFiles ranking: given the most recent N commits'
 * name-status stream, return the SHA + author + date of the most recent
 * commit that touched a given file. Rename-aware — when the file shows
 * up only as a rename's *destination*, we still return that commit (and
 * record the old path for the caller to show in the tooltip).
 *
 * The CodeAction lights up on any file in a git repo (cheap provider —
 * just decides whether to offer the action). The actual mining happens
 * lazily when the user invokes the command, so we never shell out from
 * provideCodeActions itself.
 *
 * Pure — no vscode, no child_process. Tests in test/git/openAtLastTouched.test.ts.
 */

export interface LastTouchInfo {
  sha: string;
  shortSha: string;
  author: string;
  date: Date;
  subject: string;
  /** Status code (A / M / D / R / C / T). */
  status: string;
  /** The path the file had IN that commit (matches `targetPath` for adds/mods,
   *  the rename destination for R/C entries). */
  pathInCommit: string;
  /** For renames, the source path the file had BEFORE the rename. Undefined
   *  for non-rename entries. */
  renamedFrom?: string;
}

/**
 * Scan `git log --name-status -z` style output for the most recent commit
 * that touched `targetPath`. The expected input is the stdout of:
 *
 *   git log -n<N> --name-status --pretty=format:'|||%H|%h|%an|%aI|%s'
 *
 * (same format as scanRecentFiles uses). The function walks the commits
 * newest-first and returns on the first hit.
 *
 * Rename-aware: when an R/C entry's *destination* equals targetPath, we
 * return that commit with `renamedFrom` populated. Callers can show the
 * old name in the tooltip.
 */
export function findLastTouchedCommit(
  out: string,
  targetPath: string,
): LastTouchInfo | undefined {
  if (!targetPath) return undefined;
  const lines = out.split('\n');
  let current: { sha: string; shortSha: string; author: string; date: Date; subject: string } | undefined;

  for (const raw of lines) {
    if (!raw) continue;
    if (raw.startsWith('|||')) {
      const parts = raw.slice(3).split('|');
      const [sha, shortSha, author, date, ...subjectParts] = parts;
      current = {
        sha: sha || '',
        shortSha: shortSha || '',
        author: author || '',
        date: date ? new Date(date) : new Date(0),
        subject: subjectParts.join('|'),
      };
      continue;
    }
    if (!current) continue;
    const cols = raw.split('\t');
    const status = cols[0]?.[0] ?? '';
    if (!status) continue;
    let pathInCommit: string;
    let renamedFrom: string | undefined;
    if (status === 'R' || status === 'C') {
      pathInCommit = cols[2] ?? '';
      renamedFrom = cols[1] ?? '';
    } else {
      pathInCommit = cols[1] ?? '';
    }
    if (!pathInCommit) continue;
    if (pathInCommit !== targetPath) continue;
    return {
      sha: current.sha,
      shortSha: current.shortSha,
      author: current.author,
      date: current.date,
      subject: current.subject,
      status,
      pathInCommit,
      renamedFrom,
    };
  }
  return undefined;
}

/**
 * Build a short, human-friendly description for the picker row + tooltip.
 *
 *   "abc1234 · Alice · 3d ago — fix flaky tests"
 *
 * `relativeDate` should be the project's existing timeAgo() output. We
 * keep this pure (no time-mocking traps) by accepting the string verbatim.
 */
export function describeLastTouch(info: LastTouchInfo, relativeDate: string): string {
  const subjectShort = info.subject.length > 60
    ? `${info.subject.slice(0, 57)}\u2026`
    : info.subject;
  const author = info.author || 'unknown';
  return `${info.shortSha} \u00b7 ${author} \u00b7 ${relativeDate} \u2014 ${subjectShort}`;
}

/**
 * Whether the file path is the kind that's interesting to "open at last
 * touched" — skip directories, generated binaries, and obvious non-text
 * suffixes. Mirrors the project's existing skip-massive-file heuristic.
 *
 * The provider passes the workspace-relative path; this function never
 * touches the disk.
 */
export function isOpenableTextPath(relPath: string): boolean {
  if (!relPath) return false;
  // Strip trailing slashes (directories).
  if (relPath.endsWith('/')) return false;
  // Common binary suffixes we don't want to round-trip through the
  // historic-file viewer (it works, but the diff is noise).
  const binarySuffixes = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
    '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp3', '.mp4', '.mov', '.avi', '.webm',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.class', '.jar', '.war', '.pyc', '.pyo',
    '.vsix', '.wasm',
  ];
  const lower = relPath.toLowerCase();
  for (const ext of binarySuffixes) {
    if (lower.endsWith(ext)) return false;
  }
  return true;
}
