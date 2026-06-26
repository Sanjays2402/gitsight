/**
 * Pure git-log -> GraphSnapshot builder (W3).
 *
 * STACK-AGNOSTIC. No child_process, no fs, no vscode. Takes the raw
 * stdout of a specifically-formatted `git log` and produces the
 * GraphSnapshot the web app consumes. The companion server (web/server)
 * shells out to git and feeds the stdout here; keeping the parse pure
 * means it's covered by the extension's node:test suite.
 *
 * The log format is NUL-field / RS-record separated (same idea as
 * Git.log in src/git/git.ts) so subjects + refs with arbitrary
 * punctuation survive intact:
 *
 *   git log --all --max-count=N \
 *     --pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e
 *
 * Field order: sha, shortSha, parents, author, email, isoDate, subject, refs
 * Record terminator: 0x1e (RS).  Field separator: 0x1f (US).
 *
 * Tests: test/git/graphSnapshot.test.ts
 */

import type { GraphSnapshot, GraphSnapshotCommit } from './graphSnapshot';

export const LOG_FIELD_SEP = '\x1f';
export const LOG_RECORD_SEP = '\x1e';

/** The pretty-format string the server must use to produce parseable output. */
export const LOG_PRETTY_FORMAT =
  ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s', '%D'].join('%x1f') + '%x1e';

/** The full argv (after `git`) the server runs for a snapshot. */
export function buildLogArgs(opts: { max?: number; all?: boolean } = {}): string[] {
  const args = ['log', `--pretty=format:${LOG_PRETTY_FORMAT}`, `--max-count=${opts.max ?? 500}`];
  if (opts.all ?? true) args.push('--all');
  return args;
}

/** Parse one record's fields into a snapshot commit, or null if malformed. */
export function parseLogRecord(record: string): GraphSnapshotCommit | null {
  // Strip a trailing record terminator (0x1e) if the caller passed one —
  // JS String.trim() leaves RS in place, which would otherwise leak into
  // the final (refs) field.
  const trimmed = record.replace(/\x1e+$/, '').trim();
  if (!trimmed) return null;
  const f = trimmed.split(LOG_FIELD_SEP);
  // sha, shortSha, parents, author, email, date, subject, refs
  if (f.length < 6) return null;
  const sha = f[0]?.trim();
  const shortSha = f[1]?.trim();
  if (!sha || !shortSha) return null;
  const parents = (f[2] ?? '').trim().split(/\s+/).filter(Boolean);
  const refs = (f[7] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return {
    sha,
    shortSha,
    parents,
    author: (f[3] ?? '').trim(),
    email: (f[4] ?? '').trim(),
    date: (f[5] ?? '').trim(),
    subject: f[6] ?? '',
    refs,
  };
}

/** Parse the full `git log` stdout into an ordered commit list. */
export function parseLog(stdout: string): GraphSnapshotCommit[] {
  return stdout
    .split(LOG_RECORD_SEP)
    .map(parseLogRecord)
    .filter((c): c is GraphSnapshotCommit => c !== null);
}

export interface BuildSnapshotArgs {
  repo: string;
  head: string;
  stdout: string;
  /** The origin remote URL, when present (W28). */
  remote?: string;
  /** Override the generation timestamp (tests). Defaults to now. */
  now?: Date;
}

/** Assemble a complete GraphSnapshot from git log stdout + repo metadata. */
export function buildGraphSnapshot(args: BuildSnapshotArgs): GraphSnapshot {
  const commits = parseLog(args.stdout);
  const snapshot: GraphSnapshot = {
    repo: args.repo || 'repository',
    head: args.head || 'HEAD',
    generatedAt: (args.now ?? new Date()).toISOString(),
    commitCount: commits.length,
    commits,
  };
  const remote = args.remote?.trim();
  if (remote) snapshot.remote = remote;
  return snapshot;
}

/**
 * Resolve a friendly HEAD label from `git symbolic-ref` / `rev-parse`
 * output. When on a branch, `git symbolic-ref --short HEAD` prints the
 * name; when detached it errors, so the server falls back to the short
 * sha. This pure helper picks the best label from whatever the server
 * managed to read.
 */
export function resolveHeadLabel(branch: string | undefined, shortSha: string | undefined): string {
  const b = branch?.trim();
  if (b) return b;
  const s = shortSha?.trim();
  if (s) return `${s} (detached)`;
  return 'HEAD';
}
