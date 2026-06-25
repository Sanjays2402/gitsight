/**
 * GitSight shared repo-watch + SSE helpers (W17).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. The pure logic
 * behind live refresh:
 *
 *   1. `classifyGitChange` / `gitChangeTriggersRefresh` — given a path that
 *      changed inside a repo's git dir, decide whether it represents a
 *      commit/ref mutation worth pushing to the browser (HEAD moved, a ref
 *      updated, packed-refs rewritten, a stash changed) versus noise the
 *      graph doesn't care about (index writes, lock files, object packs).
 *   2. `formatSseMessage` — serialise a Server-Sent-Events frame (event,
 *      id, multi-line data, or a keep-alive comment) to the wire string.
 *   3. `reconnectDelay` — exponential backoff (capped, with a tiny base)
 *      the browser EventSource wrapper uses when the stream drops.
 *
 * The companion server imports (1) + (2) to drive its `/api/events`
 * endpoint; the web app imports (3) for its live client. Keeping all of it
 * pure means it's covered by the extension's node:test suite and never
 * drifts between the two ends.
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/repoWatch.test.ts
 */

export type GitChangeKind =
  | 'head' // HEAD / ORIG_HEAD / MERGE_HEAD etc. moved
  | 'ref' // a branch/tag/remote ref or packed-refs changed
  | 'stash' // the stash reflog/ref changed
  | 'index' // the staging area changed (not a graph concern)
  | 'lock' // a *.lock transient — always ignore
  | 'other'; // anything else inside the git dir

/** Normalise a path to forward slashes + strip a leading `./`. */
function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Classify a path (relative to the repo's git dir) into the kind of change
 * it represents. The path is what `fs.watch` hands us — e.g. `HEAD`,
 * `refs/heads/main`, `packed-refs`, `index`, `refs/heads/main.lock`.
 */
export function classifyGitChange(relPath: string): GitChangeKind {
  const p = normalizeRel(relPath);
  if (!p) return 'other';
  // Lock files churn on every operation and never carry final state.
  if (p.endsWith('.lock')) return 'lock';

  const base = p.split('/').pop() ?? p;

  // The stash lives at refs/stash and logs/refs/stash — classify first so
  // it isn't swallowed by the generic refs/ rule (W19 cares about it).
  if (p === 'refs/stash' || p === 'logs/refs/stash') return 'stash';

  if (p === 'packed-refs') return 'ref';
  if (p.startsWith('refs/')) return 'ref';
  // The HEAD reflog moves on essentially every commit/checkout.
  if (p === 'logs/HEAD' || p.startsWith('logs/refs/')) return 'ref';

  if (base === 'HEAD' || base === 'ORIG_HEAD' || base === 'MERGE_HEAD' || base === 'FETCH_HEAD') {
    return 'head';
  }

  if (base === 'index') return 'index';

  return 'other';
}

/**
 * Whether a git-dir change should trigger a snapshot push to the browser.
 * Commit/ref/stash mutations refresh the graph; index writes and pack
 * churn do not (they don't change the commit DAG the web app renders).
 */
export function gitChangeTriggersRefresh(relPath: string): boolean {
  const kind = classifyGitChange(relPath);
  return kind === 'head' || kind === 'ref' || kind === 'stash';
}

export interface SseFrame {
  /** SSE `event:` name. Omit for the default `message` event. */
  event?: string;
  /** SSE `id:` field. */
  id?: string | number;
  /** SSE `data:` payload. Objects are JSON-encoded; strings pass through. */
  data?: unknown;
  /** A keep-alive comment line (`: ...`). When set, other fields are ignored. */
  comment?: string;
  /** SSE `retry:` reconnect hint, in ms. */
  retry?: number;
}

/**
 * Serialise an SSE frame to its wire representation (terminated by the
 * blank line that flushes the event). Multi-line string data is split into
 * one `data:` line per line so newlines survive the protocol.
 */
export function formatSseMessage(frame: SseFrame): string {
  if (frame.comment !== undefined) {
    // A comment is any line starting with ':'. Split multi-line comments.
    return frame.comment.split('\n').map(l => `: ${l}`).join('\n') + '\n\n';
  }
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event) lines.push(`event: ${frame.event}`);
  if (frame.retry !== undefined) lines.push(`retry: ${frame.retry}`);
  if (frame.data !== undefined) {
    const payload = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
    for (const line of payload.split('\n')) lines.push(`data: ${line}`);
  }
  return lines.join('\n') + '\n\n';
}

/** Base reconnect delay in ms (first retry). */
export const RECONNECT_BASE_MS = 500;
/** Maximum reconnect delay in ms (backoff ceiling). */
export const RECONNECT_MAX_MS = 10000;

/**
 * Exponential backoff for the live client's reconnect loop: attempt 0 ->
 * base, doubling each attempt, capped at RECONNECT_MAX_MS. A negative or
 * non-finite attempt is treated as 0.
 */
export function reconnectDelay(
  attempt: number,
  base: number = RECONNECT_BASE_MS,
  max: number = RECONNECT_MAX_MS,
): number {
  const a = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const delay = base * 2 ** a;
  return Math.min(delay, max);
}
