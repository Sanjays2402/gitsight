/**
 * Pure scanner for `git log --name-status` output, used by the Recent Files
 * Touched view. Input is the stdout from:
 *
 *   git log -n<N> --name-status --pretty=format:'|||%H|%h|%an|%aI|%s'
 *
 * Each commit's metadata line is prefixed with `|||` so we don't have to
 * disambiguate it from name-status lines. The function returns one entry per
 * unique file path with the *most recent* commit's metadata attached, plus a
 * tally of how many of the window's commits touched that file (so we can rank
 * by hot-spots later if we want).
 *
 * Pure — no vscode / no child_process / no fs.
 */

export interface RecentFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | string;
  sha: string;
  shortSha: string;
  author: string;
  date: Date;
  subject: string;
  /** How many commits in the scanned window touched this path. */
  commitCount: number;
  /** Size of the scanned commit window (echoed back for UI tooltips). */
  windowSize: number;
}

interface CommitMeta {
  sha: string; shortSha: string; author: string; date: Date; subject: string;
}

export function scanRecentFiles(out: string, windowSize: number): RecentFile[] {
  const lines = out.split('\n');
  const seen = new Map<string, RecentFile>();
  let current: CommitMeta | undefined;

  for (const raw of lines) {
    if (!raw) continue;
    if (raw.startsWith('|||')) {
      const parts = raw.slice(3).split('|');
      // sha | shortSha | author | iso-date | subject (subject may contain '|')
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
    // name-status line: e.g. "M\tsrc/foo.ts" or "R100\told.ts\tnew.ts"
    const cols = raw.split('\t');
    const status = cols[0]?.[0] ?? '';
    if (!status) continue;
    const filePath = (status === 'R' || status === 'C') ? cols[2] : cols[1];
    if (!filePath) continue;
    const existing = seen.get(filePath);
    if (existing) {
      existing.commitCount++;
    } else {
      seen.set(filePath, {
        path: filePath,
        status,
        sha: current.sha,
        shortSha: current.shortSha,
        author: current.author,
        date: current.date,
        subject: current.subject,
        commitCount: 1,
        windowSize,
      });
    }
  }

  // Order: most recently touched first (insertion order already matches
  // `git log` recency, since we record the first commit that mentions a file).
  return [...seen.values()];
}
