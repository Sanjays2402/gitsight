/**
 * GitSight shared commit-detail contract + pure builder (W6).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. Turns the raw
 * stdout of a small set of `git show` invocations into a `CommitDetail`
 * the web app's detail panel renders. The companion server shells out to
 * git and feeds the stdout here; keeping the parse pure means it's
 * covered by the extension's node:test suite and never drifts from the
 * shape the browser consumes.
 *
 * Three inputs, three git commands the server runs:
 *   1. meta + body  — `git show --no-patch --format=<COMMIT_DETAIL_FORMAT>`
 *   2. numstat (-z) — `git show --numstat -z --format=`   (counts + renames)
 *   3. name-status  — `git show --name-status -z --format=` (A/M/D/R/C)
 *
 * numstat carries the +/- line counts and rename old/new paths but not
 * the change letter; name-status carries the letter. We correlate the
 * two by destination path so the panel shows both an accurate status and
 * accurate churn for every file.
 *
 * Tests: test/git/commitDetail.test.ts
 */

// The field separator must match the `%x1f` (US, 0x1f) git emits in
// COMMIT_DETAIL_FORMAT below. Defined locally rather than imported from
// graphSnapshotBuild so this shared module carries no cross-file runtime
// import — the companion server loads it via Node type-stripping, which
// only erases `import type`, not value imports.
const FIELD_SEP = '\x1f';

/** The change kind for one file in a commit. */
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'unmerged'
  | 'unknown';

/** One file changed by a commit. */
export interface CommitFileChange {
  status: FileChangeStatus;
  /** Destination path (the new path for renames/copies). */
  path: string;
  /** Source path for renames/copies, else undefined. */
  oldPath?: string;
  /** Added lines, or -1 when the file is binary. */
  insertions: number;
  /** Removed lines, or -1 when the file is binary. */
  deletions: number;
  binary: boolean;
}

/** Everything the commit-detail panel needs for one commit. */
export interface CommitDetail {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  /** ISO-8601 author date. */
  authorDate: string;
  committer: string;
  committerEmail: string;
  /** ISO-8601 commit date. */
  commitDate: string;
  subject: string;
  /** Commit body (everything after the subject line), trailing-trimmed. */
  body: string;
  /** Decoration refs (`%D`), already split + trimmed. */
  refs: string[];
  files: CommitFileChange[];
  /** Total non-binary insertions across all files. */
  insertions: number;
  /** Total non-binary deletions across all files. */
  deletions: number;
  filesChanged: number;
}

/**
 * The `--format` string the server passes to `git show --no-patch`.
 * Field order: sha, shortSha, parents, author, email, authorDate,
 * committer, committerEmail, commitDate, subject, body. The body is last
 * so its newlines (and any stray field separators) are recoverable.
 */
export const COMMIT_DETAIL_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%s',
  '%b',
].join('%x1f');

/** Map a git status letter (`A`/`M`/`D`/`R`/`C`/`T`/`U`) to our enum. */
export function statusFromCode(code: string): FileChangeStatus {
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
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

/** A single numstat row before status correlation. */
export interface NumstatEntry {
  insertions: number;
  deletions: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}

/**
 * Parse `git show --numstat -z --format=` output.
 *
 * Normal rows are `<ins>\t<del>\t<path>\0`; binary rows use `-` for both
 * counts; rename/copy rows are `<ins>\t<del>\t\0<oldPath>\0<newPath>\0`
 * (the path field is empty and the next two NUL tokens carry the paths).
 */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
  const tokens = stdout.split('\0');
  const out: NumstatEntry[] = [];
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
      // Rename/copy: the following two NUL tokens are old + new path.
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      out.push({ insertions, deletions, binary, path: newPath, oldPath });
      i += 3;
    } else {
      out.push({ insertions, deletions, binary, path: rest });
      i += 1;
    }
  }
  return out;
}

/** A name-status row keyed by destination path. */
export interface NameStatusEntry {
  status: FileChangeStatus;
  oldPath?: string;
}

/**
 * Parse `git show --name-status -z --format=` output into a map keyed by
 * destination path. Status tokens alternate with path tokens; rename/copy
 * tokens (`R###`/`C###`) consume two paths (old, new).
 */
export function parseNameStatusZ(stdout: string): Map<string, NameStatusEntry> {
  const map = new Map<string, NameStatusEntry>();
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
      const oldPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      map.set(newPath, { status: statusFromCode(letter), oldPath });
      i += 3;
    } else {
      const path = tokens[i + 1] ?? '';
      map.set(path, { status: statusFromCode(letter) });
      i += 2;
    }
  }
  return map;
}

/** Parse the meta+body record from `git show --no-patch --format=...`. */
export interface CommitMeta {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  authorDate: string;
  committer: string;
  committerEmail: string;
  commitDate: string;
  subject: string;
  body: string;
  refs: string[];
}

export function parseCommitMeta(stdout: string): CommitMeta | null {
  // git appends a trailing newline to the formatted output.
  const raw = stdout.replace(/\n$/, '');
  const f = raw.split(FIELD_SEP);
  if (f.length < 10) return null;
  const sha = (f[0] ?? '').trim();
  const shortSha = (f[1] ?? '').trim();
  if (!sha || !shortSha) return null;
  return {
    sha,
    shortSha,
    parents: (f[2] ?? '').trim().split(/\s+/).filter(Boolean),
    author: (f[3] ?? '').trim(),
    email: (f[4] ?? '').trim(),
    authorDate: (f[5] ?? '').trim(),
    committer: (f[6] ?? '').trim(),
    committerEmail: (f[7] ?? '').trim(),
    commitDate: (f[8] ?? '').trim(),
    subject: f[9] ?? '',
    // Body is everything after the subject field; rejoin in the (absurd)
    // case the body contained a field separator, then trim git's trailing
    // newline(s).
    body: f.slice(10).join(FIELD_SEP).replace(/\s+$/, ''),
    refs: [],
  };
}

export interface BuildCommitDetailArgs {
  metaStdout: string;
  numstatStdout: string;
  nameStatusStdout: string;
  /** Optional decoration refs (`%D`) the server fetched separately. */
  refs?: string[];
}

/**
 * Assemble a complete CommitDetail from the three git outputs. Iterates
 * the name-status map (authoritative for the changed-file set + status)
 * and attaches +/- counts from numstat by destination path.
 */
export function buildCommitDetail(args: BuildCommitDetailArgs): CommitDetail | null {
  const meta = parseCommitMeta(args.metaStdout);
  if (!meta) return null;

  const numstat = parseNumstatZ(args.numstatStdout);
  const numByPath = new Map<string, NumstatEntry>();
  for (const n of numstat) numByPath.set(n.path, n);

  const nameStatus = parseNameStatusZ(args.nameStatusStdout);

  const files: CommitFileChange[] = [];
  let insertions = 0;
  let deletions = 0;

  const emit = (
    path: string,
    status: FileChangeStatus,
    oldPath: string | undefined,
    n: NumstatEntry | undefined,
  ): void => {
    const binary = n?.binary ?? false;
    const ins = n ? n.insertions : 0;
    const del = n ? n.deletions : 0;
    if (!binary) {
      if (ins > 0) insertions += ins;
      if (del > 0) deletions += del;
    }
    files.push({
      status,
      path,
      oldPath: oldPath || n?.oldPath,
      insertions: ins,
      deletions: del,
      binary,
    });
  };

  if (nameStatus.size > 0) {
    for (const [path, ns] of nameStatus) {
      emit(path, ns.status, ns.oldPath, numByPath.get(path));
    }
  } else {
    // No name-status (e.g. a merge shown without --name-status): fall back
    // to numstat alone with a neutral 'modified' status.
    for (const n of numstat) emit(n.path, 'modified', n.oldPath, n);
  }

  return {
    sha: meta.sha,
    shortSha: meta.shortSha,
    parents: meta.parents,
    author: meta.author,
    email: meta.email,
    authorDate: meta.authorDate,
    committer: meta.committer,
    committerEmail: meta.committerEmail,
    commitDate: meta.commitDate,
    subject: meta.subject,
    body: meta.body,
    refs: args.refs ?? meta.refs,
    files,
    insertions,
    deletions,
    filesChanged: files.length,
  };
}
