/**
 * GitSight shared range-compare logic (W18).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. The pure parsers
 * + assembler behind the web "Compare" view, the port of the extension's
 * rangeDiff webview. Given the raw output of a few `git` commands the
 * companion runs for a ref pair, it produces a typed `RangeComparison`:
 *
 *   - the symmetric-difference commit lists (commits unique to each side),
 *     parsed from `git rev-list --left-right --pretty` style output;
 *   - the changed-file summary (path + churn + status) for `base...head`,
 *     parsed from `git diff --numstat -z --name-status`-equivalent input;
 *   - the overall churn + ahead/behind counts.
 *
 * The detailed per-file unified diffs are fetched lazily by the existing
 * `/api/diff` endpoint (W7) — this module only needs the summary so the
 * compare view can render its file list cheaply.
 *
 * No cross-file runtime import (Node type-strip compatible) — only the
 * status enum is shared in spirit with diffParse but redefined locally to
 * avoid a value import.
 *
 * Tests: test/git/rangeCompare.test.ts
 */

export type CompareFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange' | 'unknown';

/** One commit on either side of the symmetric difference. */
export interface CompareCommit {
  sha: string;
  shortSha: string;
  author: string;
  /** ISO author date. */
  date: string;
  subject: string;
}

/** One file changed across the range. */
export interface CompareFile {
  path: string;
  oldPath?: string;
  status: CompareFileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface RangeComparison {
  base: string;
  head: string;
  /** Commits in head but not base (what `head` adds). */
  ahead: CompareCommit[];
  /** Commits in base but not head (what `head` is missing). */
  behind: CompareCommit[];
  files: CompareFile[];
  insertions: number;
  deletions: number;
  filesChanged: number;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** Map a git status letter to the compare enum. */
export function compareStatusFromCode(code: string): CompareFileStatus {
  switch ((code[0] ?? '').toUpperCase()) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
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
 * Parse one side of a symmetric-difference commit list. The companion runs
 *   git log <range> --pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e
 * (RECORD-terminated, FIELD-separated) so subjects with arbitrary
 * punctuation survive. Returns commits in the order git emitted them
 * (newest first).
 */
export function parseCompareCommits(stdout: string): CompareCommit[] {
  return stdout
    .split(RECORD)
    .map(rec => rec.replace(/\x1e+$/, '').trim())
    .filter(Boolean)
    .map(rec => {
      const f = rec.split(FIELD);
      const sha = (f[0] ?? '').trim();
      const shortSha = (f[1] ?? '').trim();
      if (!sha || !shortSha) return null;
      return {
        sha,
        shortSha,
        author: (f[2] ?? '').trim(),
        date: (f[3] ?? '').trim(),
        subject: f[4] ?? '',
      };
    })
    .filter((c): c is CompareCommit => c !== null);
}

/**
 * Parse `git diff --numstat -z` output (the same NUL grammar the
 * commit-detail builder uses): `<ins>\t<del>\t<path>\0`, with binary rows
 * using `-` counts and rename/copy rows carrying empty path + two extra
 * NUL tokens (old, new). Returns churn keyed by destination path.
 */
export interface NumstatRow {
  insertions: number;
  deletions: number;
  binary: boolean;
  path: string;
  oldPath?: string;
}

export function parseCompareNumstat(stdout: string): NumstatRow[] {
  const tokens = stdout.split('\0');
  const out: NumstatRow[] = [];
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

/**
 * Parse `git diff --name-status -z` output into a status map keyed by
 * destination path. Rename/copy tokens (`R###`/`C###`) consume two paths.
 */
export function parseCompareNameStatus(stdout: string): Map<string, { status: CompareFileStatus; oldPath?: string }> {
  const map = new Map<string, { status: CompareFileStatus; oldPath?: string }>();
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
      map.set(tokens[i + 2] ?? '', { status: compareStatusFromCode(letter), oldPath: tokens[i + 1] ?? '' });
      i += 3;
    } else {
      map.set(tokens[i + 1] ?? '', { status: compareStatusFromCode(letter) });
      i += 2;
    }
  }
  return map;
}

export interface BuildRangeComparisonArgs {
  base: string;
  head: string;
  aheadStdout: string;
  behindStdout: string;
  numstatStdout: string;
  nameStatusStdout: string;
}

/**
 * Assemble a RangeComparison from the git outputs. Files are taken from
 * name-status (authoritative for the change set + status), with churn
 * attached from numstat by destination path; ordered by total churn
 * descending so the biggest changes lead.
 */
export function buildRangeComparison(args: BuildRangeComparisonArgs): RangeComparison {
  const ahead = parseCompareCommits(args.aheadStdout);
  const behind = parseCompareCommits(args.behindStdout);

  const numByPath = new Map<string, NumstatRow>();
  for (const n of parseCompareNumstat(args.numstatStdout)) numByPath.set(n.path, n);
  const nameStatus = parseCompareNameStatus(args.nameStatusStdout);

  const files: CompareFile[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const [path, ns] of nameStatus) {
    const n = numByPath.get(path);
    const binary = n?.binary ?? false;
    const ins = n ? n.insertions : 0;
    const del = n ? n.deletions : 0;
    if (!binary) {
      if (ins > 0) insertions += ins;
      if (del > 0) deletions += del;
    }
    files.push({ path, oldPath: ns.oldPath || n?.oldPath, status: ns.status, insertions: ins, deletions: del, binary });
  }

  files.sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path));

  return {
    base: args.base,
    head: args.head,
    ahead,
    behind,
    files,
    insertions,
    deletions,
    filesChanged: files.length,
  };
}

/** Total churn for ordering (binary files sort as 0). */
function churn(f: CompareFile): number {
  return Math.max(0, f.insertions) + Math.max(0, f.deletions);
}

/** The git pretty-format string the companion must use for compare commit lists. */
export const COMPARE_LOG_FORMAT = ['%H', '%h', '%an', '%aI', '%s'].join('%x1f') + '%x1e';

/** A one-line headline like "12 ahead, 3 behind, 18 files changed". */
export function compareHeadline(cmp: RangeComparison): string {
  const parts: string[] = [];
  parts.push(`${cmp.ahead.length} ahead`);
  parts.push(`${cmp.behind.length} behind`);
  const fileWord = cmp.filesChanged === 1 ? 'file' : 'files';
  parts.push(`${cmp.filesChanged} ${fileWord} changed`);
  return parts.join(', ');
}
