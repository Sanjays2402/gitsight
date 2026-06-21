/**
 * Pure helpers for the Stash Diff Browser (F58).
 *
 * Parses the output of `git stash show --name-status -z <ref>` and
 * `git stash show --numstat -z <ref>` into a list of per-file changes
 * with enough metadata for the picker to render diff-by-file rows.
 *
 * Why -z: filenames can contain whitespace, tabs, or trailing
 * carriage returns; the NUL-delimited format is the only safe parse.
 *
 * Why both name-status AND numstat: name-status gives us the change
 * kind (A/M/D/R/C/T) cleanly, numstat gives us the +/- counts so the
 * UI can show a tiny "+12 / -3" hint. Joining them in pure code keeps
 * the controller small.
 *
 * Pure — no vscode, no child_process. Tests in test/git/stashDiff.test.ts.
 */

export type StashChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unknown';

export interface StashChange {
  path: string;
  /** For R/C entries, the original path. Otherwise undefined. */
  oldPath?: string;
  kind: StashChangeKind;
  /** Raw single-letter status from --name-status, kept for debugging. */
  rawStatus: string;
  /** Insertions; undefined when numstat reports `-` (binary file). */
  insertions?: number;
  /** Deletions; undefined when numstat reports `-` (binary file). */
  deletions?: number;
}

export interface StashContents {
  ref: string;
  changes: StashChange[];
  /** True when the stash had a "stash@{N}: untracked" sub-commit (`-u`). */
  hadUntracked: boolean;
}

/**
 * Parse `git stash show --name-status -z <ref>` output.
 *
 * Single-letter status entries look like `M\0path\0`. Rename/copy
 * entries look like `R75\0oldpath\0newpath\0` (the score is optional).
 *
 * Returns one StashChange per file (the new path for R/C).
 */
export function parseNameStatusZ(raw: string): StashChange[] {
  const out: StashChange[] = [];
  if (!raw) return out;
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) { i++; continue; }
    const status = tok[0];
    const isRename = status === 'R' || status === 'C';
    if (isRename) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      // A real rename row needs both paths to be non-empty strings; either
      // missing means we got truncated input mid-record and should stop.
      if (!oldPath || !newPath) break;
      out.push({
        path: newPath,
        oldPath,
        kind: status === 'R' ? 'renamed' : 'copied',
        rawStatus: tok,
      });
      i += 3;
      continue;
    }
    const file = tokens[i + 1];
    if (!file) break;
    out.push({
      path: file,
      kind: kindFor(status),
      rawStatus: tok,
    });
    i += 2;
  }
  return out;
}

/**
 * Parse `git stash show --numstat -z <ref>` and merge the +/- counts
 * into a list of changes coming from parseNameStatusZ.
 *
 * numstat -z format per file: `<ins>\t<del>\t<path>\0`, OR for renames
 * `<ins>\t<del>\t\0<oldpath>\0<newpath>\0`. We always key by the
 * final (new) path.
 */
export function mergeNumstatZ(changes: StashChange[], raw: string): StashChange[] {
  if (!raw) return changes;
  const byPath = new Map<string, StashChange>();
  for (const c of changes) byPath.set(c.path, c);

  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (!head) { i++; continue; }
    // head can be "12\t3\tpath" OR "12\t3\t" (rename — path comes in next two tokens)
    const parts = head.split('\t');
    if (parts.length < 3) { i++; continue; }
    const [ins, del, maybePath] = parts;
    let finalPath = maybePath;
    if (!finalPath) {
      // rename form: next two tokens are old, new
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      finalPath = newPath ?? oldPath ?? '';
      i += 3;
    } else {
      i++;
    }
    if (!finalPath) continue;
    const c = byPath.get(finalPath);
    if (!c) continue;
    c.insertions = ins === '-' ? undefined : parseIntSafe(ins);
    c.deletions = del === '-' ? undefined : parseIntSafe(del);
  }
  return changes;
}

function kindFor(status: string): StashChangeKind {
  switch (status) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechange';
    default: return 'unknown';
  }
}

function parseIntSafe(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Detect whether the stash bundle has an untracked sub-commit (the third
 * parent that `git stash push -u` creates).
 *
 * Input: the output of `git rev-list --parents -n 1 <ref>` which looks like
 *   <stashSha> <wipParent> <indexParent> [<untrackedParent>]
 *
 * The presence of a 4th SHA means untracked files were captured.
 */
export function detectUntrackedParent(revListLine: string): boolean {
  const parts = (revListLine ?? '').trim().split(/\s+/);
  return parts.length >= 4;
}

/**
 * Build a short, one-line summary for the picker header (rendered as the
 * QuickPick `placeHolder`). Examples:
 *   "3 files \u00b7 +24 / -5"
 *   "1 file \u00b7 +1 / -0 \u00b7 includes untracked"
 *   "2 files \u00b7 binary diff"
 */
export function summariseStashContents(s: StashContents): string {
  const ins = s.changes.reduce((a, c) => a + (c.insertions ?? 0), 0);
  const del = s.changes.reduce((a, c) => a + (c.deletions ?? 0), 0);
  const fileCount = s.changes.length;
  const filesLabel = `${fileCount} file${fileCount === 1 ? '' : 's'}`;
  const anyNumbers = s.changes.some(c => c.insertions !== undefined || c.deletions !== undefined);
  const counts = anyNumbers ? `+${ins} / -${del}` : 'binary diff';
  const untrackedTag = s.hadUntracked ? ' \u00b7 includes untracked' : '';
  return `${filesLabel} \u00b7 ${counts}${untrackedTag}`;
}

/** Glyph + description for a single change row. */
export function describeChange(c: StashChange): { glyph: string; desc: string } {
  const glyph = ({
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    typechange: 'T',
    unknown: '?',
  } as Record<StashChangeKind, string>)[c.kind];
  const bits: string[] = [];
  if (c.insertions !== undefined || c.deletions !== undefined) {
    bits.push(`+${c.insertions ?? 0} / -${c.deletions ?? 0}`);
  } else {
    bits.push('binary');
  }
  if (c.oldPath) bits.push(`from ${c.oldPath}`);
  return { glyph, desc: bits.join(' \u00b7 ') };
}
