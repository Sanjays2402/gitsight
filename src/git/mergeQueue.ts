/**
 * Pure helpers for F115 - GitHub merge-queue surface.
 *
 * GitHub's merge queue puts PRs in a serialised line so they merge
 * one-at-a-time after passing CI together. The relevant data lives
 * under the `mergeQueue` GraphQL object on a Repository, and per-PR
 * `MergeQueueEntry`. The gh CLI exposes both via:
 *
 *   gh pr view <num> --json mergeStateStatus,autoMergeRequest,mergeQueueEntry
 *
 * (gh 2.40+ added mergeQueueEntry; older gh versions omit the field
 * and we degrade silently.)
 *
 * This module owns the parsing + classification:
 *   - parseMergeQueueEntry: tolerate missing fields, multi-shape input.
 *   - classifyMergeQueueState: 6-state enum {queued, processing,
 *     blocked, merged, dequeued, none} with first-match rules.
 *   - estimateMergeMinutes: position * average-merge-minutes, with a
 *     small floor so position=1 still shows a non-zero ETA.
 *   - formatQueueLabel / describeQueueState: pill text + tooltip
 *     markdown for the prTimelinePill compose.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/mergeQueue.test.ts.
 */

export type MergeQueueState =
  | 'none'        // PR not in a merge queue / no queue feature on repo
  | 'queued'      // In queue, waiting to start
  | 'processing'  // Currently being tested at the head of the queue
  | 'blocked'     // In queue but a status check is failing on this PR
  | 'merged'      // Queue completed and merged the PR
  | 'dequeued';   // PR was removed from queue (manually or due to failure)

export interface MergeQueueEntry {
  state: MergeQueueState;
  /** 1-based position in the queue; undefined when state != queued/processing. */
  position?: number;
  /** Optional total queue length when reported. */
  queueLength?: number;
  /** ISO timestamp when PR was enqueued. */
  enqueuedAt?: string;
  /** When dequeued, an optional reason string GitHub provides. */
  dequeueReason?: string;
  /** True when the underlying gh JSON had an explicit MergeQueueEntry node. */
  hasEntry: boolean;
}

/**
 * Parse the raw `--json mergeStateStatus,autoMergeRequest,mergeQueueEntry`
 * blob into a normalised entry.
 *
 *   {
 *     "mergeQueueEntry": {
 *       "state": "QUEUED",  // QUEUED, AWAITING_CHECKS, LOCKED, MERGEABLE,
 *                           // UNMERGEABLE, etc. (varies by gh version)
 *       "position": 3,
 *       "enqueuedAt": "2026-06-22T20:00:00Z"
 *     },
 *     "mergeStateStatus": "CLEAN" | "BLOCKED" | "DIRTY" | ...
 *   }
 */
export function parseMergeQueueEntry(raw: string): MergeQueueEntry {
  if (!raw || !raw.trim()) return { state: 'none', hasEntry: false };
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return { state: 'none', hasEntry: false }; }
  if (!obj || typeof obj !== 'object') return { state: 'none', hasEntry: false };

  const entry = obj.mergeQueueEntry;
  if (entry && typeof entry === 'object') {
    const stateRaw = String(entry.state ?? '').toUpperCase();
    let state: MergeQueueState = 'queued';
    if (stateRaw === 'AWAITING_CHECKS' || stateRaw === 'PROCESSING' || stateRaw === 'TESTING') {
      state = 'processing';
    } else if (stateRaw === 'LOCKED' || stateRaw === 'UNMERGEABLE') {
      state = 'blocked';
    } else if (stateRaw === 'MERGED') {
      state = 'merged';
    } else if (stateRaw === 'DEQUEUED') {
      state = 'dequeued';
    }
    return {
      state,
      position: positiveOrUndef(entry.position),
      queueLength: positiveOrUndef(entry.queueLength ?? entry.totalEntries),
      enqueuedAt: typeof entry.enqueuedAt === 'string' ? entry.enqueuedAt : undefined,
      dequeueReason: typeof entry.dequeueReason === 'string' ? entry.dequeueReason : undefined,
      hasEntry: true,
    };
  }

  // No MergeQueueEntry node - fall through to coarse classification
  // from mergeStateStatus when the repo has a queue but the PR isn't
  // in it yet.
  return { state: 'none', hasEntry: false };
}

function positiveOrUndef(v: any): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Estimate minutes until merge based on queue position and per-PR
 * average CI minutes. Defaults match GitHub Actions baseline (~6 min
 * per PR for medium-sized check suites). Position=1 returns the
 * single-PR baseline (not 0) so users see "~6 min" rather than "merging
 * now" when checks are still running.
 *
 * Returns undefined when there's no usable position to estimate from.
 */
export function estimateMergeMinutes(
  entry: MergeQueueEntry,
  args: { averageMinutesPerPr?: number; floorMinutes?: number } = {},
): number | undefined {
  if (entry.state !== 'queued' && entry.state !== 'processing') return undefined;
  const avg = Math.max(1, args.averageMinutesPerPr ?? 6);
  const floor = Math.max(0, args.floorMinutes ?? 2);
  const pos = entry.position;
  if (entry.state === 'processing') {
    return Math.max(floor, Math.round(avg * 0.5));
  }
  if (pos === undefined) return undefined;
  // Position N = N PRs ahead (or N-th in line including ours, depending
  // on the API). We treat position as "1-based PRs in front including
  // self" so multiply directly.
  return Math.max(floor, Math.round(avg * pos));
}

/**
 * Compact pill label - fits in a status-bar item next to the
 * prTimelinePill text.
 *
 *   "queue #3 (~18m)"
 *   "queue checking..."     // processing, no ETA
 *   "queue blocked"
 *   "queue merged"
 *   "queue dequeued"
 *   undefined               // state=none
 */
export function formatQueueLabel(
  entry: MergeQueueEntry,
  args: { averageMinutesPerPr?: number; floorMinutes?: number } = {},
): string | undefined {
  switch (entry.state) {
    case 'none': return undefined;
    case 'merged': return 'queue merged';
    case 'dequeued': return 'queue dequeued';
    case 'blocked': return 'queue blocked';
    case 'processing': {
      const eta = estimateMergeMinutes(entry, args);
      return eta ? `queue checking ~${eta}m` : 'queue checking...';
    }
    case 'queued': {
      const pos = entry.position;
      const eta = estimateMergeMinutes(entry, args);
      if (pos !== undefined && eta !== undefined) return `queue #${pos} (~${eta}m)`;
      if (pos !== undefined) return `queue #${pos}`;
      return 'queue waiting';
    }
  }
}

/** Markdown tooltip body listing position + ETA + dequeue reason if any. */
export function describeQueueState(
  entry: MergeQueueEntry,
  args: { averageMinutesPerPr?: number; floorMinutes?: number } = {},
): string {
  const lines: string[] = [];
  lines.push(`**Merge queue**  -  ${stateLabel(entry.state)}`);
  lines.push('');
  if (entry.position !== undefined) lines.push(`- Position: ${entry.position}${entry.queueLength ? ` of ${entry.queueLength}` : ''}`);
  const eta = estimateMergeMinutes(entry, args);
  if (eta !== undefined) lines.push(`- ETA: ~${eta} min (avg ${Math.max(1, args.averageMinutesPerPr ?? 6)}m/PR)`);
  if (entry.enqueuedAt) lines.push(`- Enqueued at: ${entry.enqueuedAt}`);
  if (entry.dequeueReason) lines.push(`- Dequeue reason: ${entry.dequeueReason}`);
  if (entry.state === 'none') {
    lines.push('- This PR is not in the merge queue.');
  }
  return lines.join('\n');
}

function stateLabel(s: MergeQueueState): string {
  switch (s) {
    case 'queued': return 'queued';
    case 'processing': return 'processing (checks running)';
    case 'blocked': return 'blocked (failing required check)';
    case 'merged': return 'merged';
    case 'dequeued': return 'dequeued';
    case 'none': return 'not in queue';
  }
}

/** Codicon glyph for status-bar pill (no emoji). */
export function glyphForQueueState(s: MergeQueueState): string {
  switch (s) {
    case 'queued': return 'list-ordered';
    case 'processing': return 'sync';
    case 'blocked': return 'warning';
    case 'merged': return 'git-merge';
    case 'dequeued': return 'circle-slash';
    case 'none': return 'circle-outline';
  }
}
