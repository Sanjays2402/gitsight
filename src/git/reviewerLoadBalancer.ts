/**
 * Pure helpers for F124 - Reviewer Load Balancer.
 *
 * Composes with the F57 default-reviewers picker, the F85 round-robin
 * re-ranker, and the F91 shortlog fallback. Where F85 simply counts
 * "how many open requests does this reviewer have right now?", F124
 * adds two extra dimensions so the picker can prefer reviewers whose
 * queue actually CLEARS instead of those who just happen to have
 * fewer outstanding requests:
 *
 *   1. Pending review queue:    open PR requests waiting on them
 *   2. Recent throughput:       reviews completed in the lookback
 *                               window (newer = better signal)
 *   3. Median ack latency:      hours between request and first
 *                               review action (lower = faster turn)
 *
 * The composite "load score" is queue weight + latency weight minus
 * throughput. Lowest score floats to the top of the tier.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/reviewerLoadBalancer.test.ts.
 *
 * The view layer feeds three JSON shapes from gh:
 *
 *   gh pr list --search "review-requested:<handle>" --json number,createdAt
 *     -> pending queue per handle
 *
 *   gh pr list --search "reviewed-by:<handle> merged:>=<since>" --json url,reviews
 *     -> completed-throughput + per-review timestamp
 *
 * Both shapes are normalised here so the load classifier is fully
 * unit-testable without mocking gh.
 */
import { ReviewerSuggestion } from './defaultReviewers';

export interface ReviewerLoadStats {
  /** Lower-case GitHub handle (no `@`). */
  handle: string;
  /** Number of open PR review requests currently assigned. */
  pending: number;
  /** Reviews submitted in the window (lookback days). */
  recentThroughput: number;
  /** Median ack latency in hours over the window. */
  medianAckHours: number;
  /** True when no signal was found - we treat as "neutral" rather than fast/slow. */
  unknown: boolean;
}

export interface ReviewerLoadScore {
  handle: string;
  score: number;
  /** Decomposition of the score so the picker can render a tooltip. */
  components: {
    queueComponent: number;
    latencyComponent: number;
    throughputComponent: number;
  };
}

export interface ScoreLoadOptions {
  /** Default 5 - one open request costs 5 score points. */
  pendingWeight?: number;
  /** Default 0.1 - one hour of median latency costs 0.1 points. */
  latencyWeight?: number;
  /** Default 2 - each recent review subtracts 2 points (cap at throughputCap). */
  throughputWeight?: number;
  /** Default 20 - throughput cap so a hyper-active reviewer doesn't
   *  swamp the score and float everyone else permanently below them. */
  throughputCap?: number;
  /** Default 50 - score assigned to unknown-shape reviewers (neutral
   *  middle). Stops 0-pending unknowns from being preferred over a
   *  known-but-busy reviewer (whose score is well above 50). */
  unknownScore?: number;
}

/**
 * Compute the composite load score for a single reviewer.
 *
 *   score = (pending * pendingWeight)
 *         + (medianAckHours * latencyWeight)
 *         - (min(recentThroughput, throughputCap) * throughputWeight)
 *
 * Unknown reviewers (no signal) get `unknownScore` so they sit in the
 * neutral middle of the tier rather than at the top (where they'd
 * displace known-fast reviewers) or the bottom (where they'd never
 * get picked despite possibly being great).
 */
export function scoreReviewerLoad(
  stats: ReviewerLoadStats,
  opts: ScoreLoadOptions = {},
): ReviewerLoadScore {
  const pendingW = opts.pendingWeight ?? 5;
  const latencyW = opts.latencyWeight ?? 0.1;
  const throughputW = opts.throughputWeight ?? 2;
  const cap = opts.throughputCap ?? 20;
  const unknownScore = opts.unknownScore ?? 50;

  if (stats.unknown) {
    return {
      handle: stats.handle.toLowerCase(),
      score: unknownScore,
      components: { queueComponent: 0, latencyComponent: 0, throughputComponent: 0 },
    };
  }
  const queueComponent = Math.max(0, stats.pending) * pendingW;
  const latencyComponent = Math.max(0, stats.medianAckHours) * latencyW;
  const throughputComponent = Math.min(Math.max(0, stats.recentThroughput), cap) * throughputW;
  return {
    handle: stats.handle.toLowerCase(),
    score: queueComponent + latencyComponent - throughputComponent,
    components: { queueComponent, latencyComponent, throughputComponent },
  };
}

/**
 * Re-rank a coverage-sorted suggestion list by load-balance score INSIDE
 * each coverage tier. Mirrors the F85 round-robin shape (we never
 * demote a high-coverage owner under a low-coverage one), but uses the
 * composite score instead of the bare open-requests count.
 *
 * Returns a new array; does not mutate the input.
 */
export interface RerankArgs {
  suggestions: ReviewerSuggestion[];
  scores: Map<string, ReviewerLoadScore>;
}

export function rerankByLoadBalance(args: RerankArgs): ReviewerSuggestion[] {
  const { suggestions, scores } = args;
  if (!suggestions.length) return [];
  const tiers = new Map<number, ReviewerSuggestion[]>();
  for (const s of suggestions) {
    const tier = s.ownedPaths.length;
    let bucket = tiers.get(tier);
    if (!bucket) {
      bucket = [];
      tiers.set(tier, bucket);
    }
    bucket.push(s);
  }
  const tiersSorted = [...tiers.keys()].sort((a, b) => b - a);
  const out: ReviewerSuggestion[] = [];
  for (const tier of tiersSorted) {
    const bucket = tiers.get(tier)!;
    bucket.sort((a, b) => {
      const sa = scores.get(a.handle.toLowerCase())?.score ?? Number.POSITIVE_INFINITY;
      const sb = scores.get(b.handle.toLowerCase())?.score ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa - sb;
      // Tiebreakers: user before team, then handle.
      if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
      return a.handle.localeCompare(b.handle);
    });
    for (const s of bucket) out.push(s);
  }
  return out;
}

/**
 * Parse `gh pr list --search review-requested:<handle> --json number,createdAt`
 * into a count of pending requests. Designed for a per-handle round-trip
 * - the view layer fan-outs across the handle set.
 *
 * Tolerates: array shape (current gh), single-PR object shape (older
 * gh), and the empty-array shape.
 */
export function parsePendingFromGhJson(raw: string): number {
  if (!raw || !raw.trim()) return 0;
  let obj: any;
  try { obj = JSON.parse(raw); }
  catch { return 0; }
  if (Array.isArray(obj)) return obj.length;
  // Some gh versions wrap a single PR as `{ ... }` instead of `[ {} ]`.
  if (obj && typeof obj === 'object' && (obj.number || obj.url)) return 1;
  return 0;
}

/**
 * Parse `gh pr list --json url,createdAt,reviews` into per-reviewer
 * latency samples. Each review entry has `{author:{login}, submittedAt}`;
 * we look up the FIRST review per (PR, author) and use the gap from
 * createdAt as the ack latency. Subsequent reviews on the same PR are
 * ignored (we want the time-to-first-feedback signal, not the average).
 *
 * Returns a map handle (lowercase) -> latency hours (sorted ascending).
 */
export interface AckSampleInput {
  /** Raw gh JSON output (array of PRs). */
  raw: string;
  /** Restrict counting to this handle set (lowercase). Empty = all. */
  handles?: Set<string>;
}

export function parseAckLatencySamples(input: AckSampleInput): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const { raw, handles } = input;
  if (!raw || !raw.trim()) return out;
  let arr: any;
  try { arr = JSON.parse(raw); }
  catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const pr of arr) {
    if (!pr || typeof pr !== 'object') continue;
    const created = parseIsoDate(pr.createdAt);
    if (!created) continue;
    const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
    const firstByAuthor = new Map<string, number>();
    for (const r of reviews) {
      const login = String(r?.author?.login ?? '').toLowerCase();
      if (!login) continue;
      if (handles && handles.size > 0 && !handles.has(login)) continue;
      const submitted = parseIsoDate(r?.submittedAt);
      if (!submitted) continue;
      const existing = firstByAuthor.get(login);
      if (existing === undefined || submitted < existing) {
        firstByAuthor.set(login, submitted);
      }
    }
    for (const [login, submitted] of firstByAuthor) {
      const hours = Math.max(0, (submitted - created) / 3_600_000);
      let bucket = out.get(login);
      if (!bucket) {
        bucket = [];
        out.set(login, bucket);
      }
      bucket.push(hours);
    }
  }
  // Pre-sort each list so callers can run median without re-sorting.
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

/**
 * Throughput count from the same JSON blob: number of PRs where the
 * handle submitted at least one review. Cheaper than the latency parse
 * because we just count distinct (PR, author) pairs.
 */
export function parseThroughputCounts(raw: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!raw || !raw.trim()) return counts;
  let arr: any;
  try { arr = JSON.parse(raw); }
  catch { return counts; }
  if (!Array.isArray(arr)) return counts;
  for (const pr of arr) {
    if (!pr || typeof pr !== 'object') continue;
    const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
    const seen = new Set<string>();
    for (const r of reviews) {
      const login = String(r?.author?.login ?? '').toLowerCase();
      if (!login) continue;
      if (seen.has(login)) continue;
      seen.add(login);
    }
    for (const login of seen) {
      counts.set(login, (counts.get(login) ?? 0) + 1);
    }
  }
  return counts;
}

function parseIsoDate(s: any): number | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Median of a sorted number array. NaN for empty arrays.
 */
export function median(sortedAsc: number[]): number {
  if (!sortedAsc.length) return NaN;
  const mid = sortedAsc.length >> 1;
  if (sortedAsc.length & 1) return sortedAsc[mid];
  return (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * Compose per-handle ReviewerLoadStats from the three parse helpers.
 * The view layer calls this once before re-ranking.
 */
export interface BuildStatsArgs {
  /** Handle set we care about (lowercase). */
  handles: string[];
  /** Open-PR counts per handle (parsePendingFromGhJson). */
  pendingByHandle: Map<string, number>;
  /** Latency samples per handle (parseAckLatencySamples). */
  ackSamplesByHandle: Map<string, number[]>;
  /** Throughput counts per handle (parseThroughputCounts). */
  throughputByHandle: Map<string, number>;
}

export function buildReviewerLoadStats(args: BuildStatsArgs): ReviewerLoadStats[] {
  const out: ReviewerLoadStats[] = [];
  for (const raw of args.handles) {
    const handle = raw.toLowerCase().replace(/^@/, '');
    if (!handle) continue;
    const pending = args.pendingByHandle.get(handle) ?? 0;
    const recentThroughput = args.throughputByHandle.get(handle) ?? 0;
    const samples = args.ackSamplesByHandle.get(handle);
    const medianAck = samples && samples.length > 0 ? median(samples) : NaN;
    const unknown = pending === 0 && recentThroughput === 0 && Number.isNaN(medianAck);
    out.push({
      handle,
      pending,
      recentThroughput,
      medianAckHours: Number.isFinite(medianAck) ? medianAck : 0,
      unknown,
    });
  }
  return out;
}

/**
 * Concise human-readable summary for a load score (picker detail line).
 *
 *   "queue 2 - 7h ack - 4 recent reviews (score 11.2)"
 *   "no recent signal (neutral)"
 */
export function describeLoadStats(stats: ReviewerLoadStats, score: ReviewerLoadScore): string {
  if (stats.unknown) return 'no recent signal (neutral)';
  const parts: string[] = [`queue ${stats.pending}`];
  if (Number.isFinite(stats.medianAckHours) && stats.medianAckHours > 0) {
    parts.push(`${formatHours(stats.medianAckHours)} ack`);
  }
  if (stats.recentThroughput > 0) {
    parts.push(`${stats.recentThroughput} recent review${stats.recentThroughput === 1 ? '' : 's'}`);
  }
  parts.push(`score ${roundOne(score.score)}`);
  return parts.join(' - ');
}

function formatHours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function roundOne(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/**
 * Build the markdown report body for the "Open report" action.
 *
 * Sections:
 *   # Reviewer Load Report
 *   _N reviewers - lookback Md_
 *   | Reviewer | Queue | Ack | Throughput | Score | Verdict |
 */
export type LoadVerdict = 'fast' | 'busy' | 'slow' | 'neutral' | 'unknown';

export function classifyVerdict(stats: ReviewerLoadStats, score: ReviewerLoadScore): LoadVerdict {
  if (stats.unknown) return 'unknown';
  // Negative score = throughput exceeds queue+latency cost - they ship faster than they pile up.
  if (score.score < 0) return 'fast';
  if (stats.pending >= 5 && score.score >= 25) return 'busy';
  if (Number.isFinite(stats.medianAckHours) && stats.medianAckHours >= 48) return 'slow';
  if (stats.recentThroughput === 0 && stats.pending === 0) return 'neutral';
  return 'neutral';
}

export interface BuildReportArgs {
  stats: ReviewerLoadStats[];
  scores: Map<string, ReviewerLoadScore>;
  lookbackDays: number;
}

export function buildLoadReport(args: BuildReportArgs): string {
  const { stats, scores, lookbackDays } = args;
  const sorted = stats
    .map(s => ({ s, score: scores.get(s.handle) ?? scoreReviewerLoad(s) }))
    .sort((a, b) => a.score.score - b.score.score);

  const lines: string[] = [];
  lines.push('# Reviewer Load Report');
  lines.push('');
  lines.push(`_${stats.length} reviewer${stats.length === 1 ? '' : 's'} - last ${lookbackDays} day${lookbackDays === 1 ? '' : 's'}_`);
  lines.push('');
  if (!stats.length) {
    lines.push('_No reviewer handles fed to the report._');
    return lines.join('\n');
  }
  lines.push('| Reviewer | Queue | Median Ack | Recent Reviews | Score | Verdict |');
  lines.push('| --- | ---:| ---:| ---:| ---:| --- |');
  for (const { s, score } of sorted) {
    const ack = s.unknown ? '-' : formatHours(s.medianAckHours);
    const verdict = classifyVerdict(s, score);
    lines.push(
      `| \`@${escapePipe(s.handle)}\` | ${s.pending} | ${ack} | ${s.recentThroughput} | ${roundOne(score.score)} | ${verdict} |`,
    );
  }
  return lines.join('\n');
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }
