/**
 * GitSight shared stash-list logic (W19).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. The pure parsers
 * + assembler behind the web "Stashes" view, the port of the extension's
 * stashVisualizer webview. Turns the raw output of a few `git stash`
 * commands into a typed `StashList`:
 *
 *   - the stash entries from `git stash list --pretty` (index, ref,
 *     subject, branch, ISO date);
 *   - per-entry file changes from `git stash show --name-status -z`
 *     correlated with `--numstat -z` churn (same NUL grammar the
 *     commit-detail builder uses).
 *
 * A stash ref (`stash@{N}`) carries `@{}` which the rev-safety guard
 * rejects, so the server constructs the ref from a validated integer
 * index via `stashRefForIndex` — never from user-supplied ref text.
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/stashes.test.ts
 */

export type StashFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'unknown';

/** One file changed in a stash. */
export interface StashFile {
  path: string;
  oldPath?: string;
  status: StashFileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
}

/** One stash entry. */
export interface StashEntry {
  /** Numeric stash index (0 = most recent). */
  index: number;
  /** The full ref, e.g. `stash@{0}`. */
  ref: string;
  /** The stash subject (`%gs`), e.g. "WIP on main: 1a2b3c subject". */
  subject: string;
  /** The branch the stash was taken on, parsed from the subject. */
  branch: string;
  /** ISO-8601 author date. */
  date: string;
  files: StashFile[];
  insertions: number;
  deletions: number;
  filesChanged: number;
}

export interface StashList {
  stashes: StashEntry[];
  total: number;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** The git pretty-format the companion must use for `git stash list`. */
export const STASH_LIST_FORMAT = ['%gd', '%gs', '%aI'].join('%x1f') + '%x1e';

/** Map a git status letter to the stash-file enum. */
export function stashStatusFromCode(code: string): StashFileStatus {
  switch ((code[0] ?? '').toUpperCase()) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'unknown';
  }
}

/**
 * Validate a stash index: a non-negative integer within a sane bound. The
 * server uses this before constructing `stash@{N}` so a crafted query can't
 * smuggle anything into the ref.
 */
export function isValidStashIndex(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 10000;
}

/** Construct a stash ref from a validated index. Throws on a bad index. */
export function stashRefForIndex(n: number): string {
  if (!isValidStashIndex(n)) throw new Error(`invalid stash index: ${n}`);
  return `stash@{${n}}`;
}

/** Parse the branch name out of a stash subject ("WIP on <branch>: ..."). */
export function stashBranch(subject: string): string {
  const m = /(?:WIP on|On) ([^:]+):/.exec(subject);
  return m ? m[1].trim() : '';
}

/**
 * Parse `git stash list --pretty=format:STASH_LIST_FORMAT` output into the
 * bare entries (no file data yet — the server fetches that per entry).
 */
export function parseStashList(stdout: string): Array<Pick<StashEntry, 'index' | 'ref' | 'subject' | 'branch' | 'date'>> {
  return stdout
    .split(RECORD)
    .map(rec => rec.replace(/\x1e+$/, '').trim())
    .filter(Boolean)
    .map((rec, i) => {
      const f = rec.split(FIELD);
      const ref = (f[0] ?? '').trim();
      const subject = f[1] ?? '';
      const date = (f[2] ?? '').trim();
      if (!ref) return null;
      return { index: i, ref, subject, branch: stashBranch(subject), date };
    })
    .filter((e): e is Pick<StashEntry, 'index' | 'ref' | 'subject' | 'branch' | 'date'> => e !== null);
}

interface NumRow {
  insertions: number;
  deletions: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}

/** Parse `git stash show --numstat -z` output keyed by destination path. */
export function parseStashNumstat(stdout: string): NumRow[] {
  const tokens = stdout.split('\0');
  const out: NumRow[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) {
      i++;
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(t);
    if (!m) {
      i++;
      continue;
    }
    const binary = m[1] === '-' && m[2] === '-';
    const insertions = m[1] === '-' ? -1 : parseInt(m[1], 10);
    const deletions = m[2] === '-' ? -1 : parseInt(m[2], 10);
    const rest = m[3];
    if (rest === '') {
      out.push({ insertions, deletions, binary, path: tokens[i + 2] ?? '', oldPath: tokens[i + 1] ?? '' });
      i += 3;
    } else {
      out.push({ insertions, deletions, binary, path: rest });
      i += 1;
    }
  }
  return out;
}

/** Parse `git stash show --name-status -z` output keyed by destination path. */
export function parseStashNameStatus(stdout: string): Map<string, { status: StashFileStatus; oldPath?: string }> {
  const map = new Map<string, { status: StashFileStatus; oldPath?: string }>();
  const tokens = stdout.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) {
      i++;
      continue;
    }
    const letter = code[0].toUpperCase();
    if (letter === 'R' || letter === 'C') {
      map.set(tokens[i + 2] ?? '', { status: stashStatusFromCode(letter), oldPath: tokens[i + 1] ?? '' });
      i += 3;
    } else {
      map.set(tokens[i + 1] ?? '', { status: stashStatusFromCode(letter) });
      i += 2;
    }
  }
  return map;
}

/** Assemble the file list for one stash from its numstat + name-status. */
export function buildStashFiles(numstatStdout: string, nameStatusStdout: string): {
  files: StashFile[];
  insertions: number;
  deletions: number;
} {
  const numByPath = new Map<string, NumRow>();
  for (const n of parseStashNumstat(numstatStdout)) numByPath.set(n.path, n);
  const nameStatus = parseStashNameStatus(nameStatusStdout);

  const files: StashFile[] = [];
  let insertions = 0;
  let deletions = 0;

  const rows =
    nameStatus.size > 0
      ? [...nameStatus.entries()].map(([path, ns]) => ({ path, status: ns.status, oldPath: ns.oldPath }))
      : parseStashNumstat(numstatStdout).map(n => ({ path: n.path, status: 'modified' as StashFileStatus, oldPath: n.oldPath }));

  for (const r of rows) {
    const n = numByPath.get(r.path);
    const binary = n?.binary ?? false;
    const ins = n ? n.insertions : 0;
    const del = n ? n.deletions : 0;
    if (!binary) {
      if (ins > 0) insertions += ins;
      if (del > 0) deletions += del;
    }
    files.push({ path: r.path, oldPath: r.oldPath || n?.oldPath, status: r.status, insertions: ins, deletions: del, binary });
  }
  files.sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path));
  return { files, insertions, deletions };
}

function churn(f: StashFile): number {
  return Math.max(0, f.insertions) + Math.max(0, f.deletions);
}

/** A one-line summary like "3 files · +18 -4". */
export function stashSummary(entry: Pick<StashEntry, 'filesChanged' | 'insertions' | 'deletions'>): string {
  const fileWord = entry.filesChanged === 1 ? 'file' : 'files';
  const parts = [`${entry.filesChanged} ${fileWord}`];
  if (entry.insertions > 0) parts.push(`+${entry.insertions}`);
  if (entry.deletions > 0) parts.push(`-${entry.deletions}`);
  return parts.join(' \u00b7 ');
}

// ── Mutating actions (W25) — apply / pop / drop ──────────────────────

/** The three local-only stash mutations the web view can request (W25). */
export type StashAction = 'apply' | 'pop' | 'drop';

const STASH_ACTIONS: StashAction[] = ['apply', 'pop', 'drop'];

/** True when a string names a supported stash mutation. */
export function isStashAction(s: unknown): s is StashAction {
  return typeof s === 'string' && (STASH_ACTIONS as string[]).includes(s);
}

/**
 * Build the validated `git stash <action> stash@{N}` argv for a mutation.
 * BOTH the action and the index are validated — the index via the same
 * `stashRefForIndex` gate the read path uses (so `stash@{N}` can never be
 * anything but an integer-indexed ref), and the action against the closed
 * verb set — so a crafted request can't smuggle a different subcommand or
 * a flag into the argv. Throws on either being invalid.
 */
export function buildStashActionArgs(action: string, index: number): string[] {
  if (!isStashAction(action)) throw new Error(`invalid stash action: ${action}`);
  const ref = stashRefForIndex(index); // throws on a bad index
  return ['stash', action, ref];
}

/** Human past-tense label for a completed action (toast / status). */
export function stashActionLabel(action: StashAction): string {
  switch (action) {
    case 'apply':
      return 'applied';
    case 'pop':
      return 'popped';
    case 'drop':
      return 'dropped';
  }
}

/**
 * Whether an action removes the stash entry from the list (so the client
 * knows to refresh): pop + drop remove it; apply leaves it in place.
 */
export function stashActionRemovesEntry(action: StashAction): boolean {
  return action === 'pop' || action === 'drop';
}
