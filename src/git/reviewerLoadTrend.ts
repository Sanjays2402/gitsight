/**
 * Pure helpers for F137 - Reviewer Load Balancer Historical Trend Report.
 *
 * Companion to F124 (load-balancer scoring) and F128 (picker integration).
 * The basic load report (F124's buildLoadReport) shows the CURRENT
 * snapshot. F137 extends it with a TREND view that buckets ack-latency
 * + throughput samples into weekly windows so the user can see whether
 * a reviewer is improving or regressing over the lookback period.
 *
 * Useful for retros: "Bob's median ack latency went from 18h -> 7h
 * over the last 4 weeks - he's clearly making review a priority".
 *
 * Pure - no vscode, no gh. Tests in test/git/reviewerLoadTrend.test.ts.
 *
 * The view layer feeds the same gh JSON shape used by F124's parser
 * (`gh pr list --json url,createdAt,reviews`), but instead of collapsing
 * the samples into a single median, we partition by week (Mon-Sun)
 * and surface per-week aggregates.
 */

import { median } from './reviewerLoadBalancer';

/** A single ack sample with the week-anchor needed for bucketing. */
export interface AckSample {
  /** Lowercase GitHub handle. */
  handle: string;
  /** Hours between PR createdAt and the reviewer's first review submission. */
  ackHours: number;
  /** Epoch milliseconds for the SUBMISSION (we bucket on this). */
  submittedAtMs: number;
}

/** A throughput sample - just a "this PR was reviewed in week N" marker. */
export interface ThroughputSample {
  handle: string;
  /** Epoch milliseconds of the review submission. */
  submittedAtMs: number;
}

/**
 * Parse the same `gh pr list --json url,createdAt,reviews` blob the
 * F124 parser eats, but emit per-sample records (handle + week-anchor)
 * instead of a Map<handle, hours[]>. We need the timestamps to bucket.
 */
export function parseAckSamplesWithTimestamps(raw: string, handles?: Set<string>): AckSample[] {
  const out: AckSample[] = [];
  if (!raw || !raw.trim()) return out;
  let arr: any;
  try { arr = JSON.parse(raw); } catch { return out; }
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
      out.push({
        handle: login,
        ackHours: Math.max(0, (submitted - created) / 3_600_000),
        submittedAtMs: submitted,
      });
    }
  }
  return out;
}

/**
 * Parse throughput samples (one row per PR per reviewer who left at
 * least one review).
 */
export function parseThroughputSamples(raw: string, handles?: Set<string>): ThroughputSample[] {
  const out: ThroughputSample[] = [];
  if (!raw || !raw.trim()) return out;
  let arr: any;
  try { arr = JSON.parse(raw); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const pr of arr) {
    if (!pr || typeof pr !== 'object') continue;
    const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];
    const earliest = new Map<string, number>();
    for (const r of reviews) {
      const login = String(r?.author?.login ?? '').toLowerCase();
      if (!login) continue;
      if (handles && handles.size > 0 && !handles.has(login)) continue;
      const submitted = parseIsoDate(r?.submittedAt);
      if (!submitted) continue;
      const cur = earliest.get(login);
      if (cur === undefined || submitted < cur) earliest.set(login, submitted);
    }
    for (const [login, submitted] of earliest) {
      out.push({ handle: login, submittedAtMs: submitted });
    }
  }
  return out;
}

/**
 * Bucket an epoch-ms timestamp into the Monday-anchored ISO week start.
 * Returns an epoch-ms value representing 00:00 UTC of that Monday.
 *
 * Tests anchor on this so we know exactly which week a sample falls in.
 */
export function bucketWeekStart(ms: number): number {
  const d = new Date(ms);
  // ISO weeks start on Monday. JS getUTCDay: Sun=0, Mon=1, ..., Sat=6.
  const dow = d.getUTCDay();
  const daysFromMonday = (dow + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  // Compute Monday's UTC date floor.
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
  return monday;
}

/** Per-week aggregate for a single handle. */
export interface WeekBucket {
  weekStartMs: number;
  /** Median ack latency in hours; NaN when no samples. */
  medianAckHours: number;
  /** Count of throughput samples that week. */
  throughput: number;
  /** Sample count for the ack median (separately from throughput
   *  because not every review is the first by that handle on a PR). */
  ackSampleCount: number;
}

/**
 * Build a per-handle, per-week breakdown.
 *
 *   Handle 'alice' -> [ {week W-3, medianAck 18h, throughput 5}, ... ]
 *
 * The output map is keyed by lowercase handle; each value is an array
 * of WeekBucket sorted by weekStartMs ascending (oldest-first).
 *
 * Weeks with no samples are NOT padded; the caller can fill gaps if
 * they want a continuous timeline (the report does for the chart).
 */
export interface BuildTrendArgs {
  ackSamples: AckSample[];
  throughputSamples: ThroughputSample[];
  /** When set, restrict output to these handles. */
  handles?: ReadonlySet<string>;
}

export function buildWeeklyTrend(args: BuildTrendArgs): Map<string, WeekBucket[]> {
  const ackByHandleWeek = new Map<string, Map<number, number[]>>();
  for (const s of args.ackSamples) {
    if (args.handles && !args.handles.has(s.handle)) continue;
    const week = bucketWeekStart(s.submittedAtMs);
    let perHandle = ackByHandleWeek.get(s.handle);
    if (!perHandle) { perHandle = new Map(); ackByHandleWeek.set(s.handle, perHandle); }
    let samples = perHandle.get(week);
    if (!samples) { samples = []; perHandle.set(week, samples); }
    samples.push(s.ackHours);
  }
  const throughputByHandleWeek = new Map<string, Map<number, number>>();
  for (const s of args.throughputSamples) {
    if (args.handles && !args.handles.has(s.handle)) continue;
    const week = bucketWeekStart(s.submittedAtMs);
    let perHandle = throughputByHandleWeek.get(s.handle);
    if (!perHandle) { perHandle = new Map(); throughputByHandleWeek.set(s.handle, perHandle); }
    perHandle.set(week, (perHandle.get(week) ?? 0) + 1);
  }

  const handles = new Set<string>([
    ...ackByHandleWeek.keys(),
    ...throughputByHandleWeek.keys(),
  ]);
  const out = new Map<string, WeekBucket[]>();
  for (const handle of handles) {
    const ackWeeks = ackByHandleWeek.get(handle) ?? new Map<number, number[]>();
    const tpWeeks = throughputByHandleWeek.get(handle) ?? new Map<number, number>();
    const allWeeks = new Set<number>([...ackWeeks.keys(), ...tpWeeks.keys()]);
    const buckets: WeekBucket[] = [];
    for (const week of allWeeks) {
      const ackList = ackWeeks.get(week);
      const ackSorted = ackList ? [...ackList].sort((a, b) => a - b) : undefined;
      buckets.push({
        weekStartMs: week,
        medianAckHours: ackSorted && ackSorted.length > 0 ? median(ackSorted) : NaN,
        throughput: tpWeeks.get(week) ?? 0,
        ackSampleCount: ackList?.length ?? 0,
      });
    }
    buckets.sort((a, b) => a.weekStartMs - b.weekStartMs);
    out.set(handle, buckets);
  }
  return out;
}

/**
 * Compute a verdict for a handle's trend: improving / regressing /
 * steady / sparse-data.
 *
 *   - improving      -> latest week median < oldest week median by >=
 *                       20% AND at least 2 buckets
 *   - regressing     -> latest week median > oldest week median by >=
 *                       20% AND at least 2 buckets
 *   - steady         -> at least 2 buckets, neither improving nor regressing
 *   - sparse-data    -> fewer than 2 buckets with finite medians
 */
export type TrendVerdict = 'improving' | 'regressing' | 'steady' | 'sparse-data';

export function classifyTrendVerdict(buckets: WeekBucket[]): TrendVerdict {
  const withAck = buckets.filter(b => Number.isFinite(b.medianAckHours));
  if (withAck.length < 2) return 'sparse-data';
  const first = withAck[0].medianAckHours;
  const last = withAck[withAck.length - 1].medianAckHours;
  if (first === 0 && last === 0) return 'steady';
  if (first === 0) {
    // From zero to anything positive -> regressing only if last is > 1h.
    return last > 1 ? 'regressing' : 'steady';
  }
  const delta = (last - first) / first;
  if (delta <= -0.2) return 'improving';
  if (delta >= 0.2) return 'regressing';
  return 'steady';
}

/**
 * Concise per-handle headline for the report or hover.
 *
 *   "alice: improving (18h -> 7h over 4w)"
 *   "bob: regressing (5h -> 22h over 3w)"
 *   "carol: steady (~6h across 4w)"
 *   "dave: sparse data (1 week)"
 */
export function describeHandleTrend(handle: string, buckets: WeekBucket[]): string {
  const verdict = classifyTrendVerdict(buckets);
  const withAck = buckets.filter(b => Number.isFinite(b.medianAckHours));
  if (verdict === 'sparse-data') {
    const n = buckets.length;
    return `${handle}: sparse data (${n} week${n === 1 ? '' : 's'})`;
  }
  const first = withAck[0].medianAckHours;
  const last = withAck[withAck.length - 1].medianAckHours;
  const weeks = withAck.length;
  if (verdict === 'steady') {
    const avg = (first + last) / 2;
    return `${handle}: steady (~${formatHours(avg)} across ${weeks}w)`;
  }
  return `${handle}: ${verdict} (${formatHours(first)} \u2192 ${formatHours(last)} over ${weeks}w)`;
}

/**
 * Build the markdown report body for the "Show trend" action.
 *
 *   # Reviewer Load Trend
 *
 *   _N handles, last M weeks_
 *
 *   ## alice (improving)
 *   | Week starting | Median Ack | Throughput |
 *   | --- | ---:| ---:|
 *   | 2026-05-25 | 18h | 4 |
 *   ...
 */
export interface BuildTrendReportArgs {
  trend: Map<string, WeekBucket[]>;
  /** Total lookback weeks for the header. */
  lookbackWeeks: number;
  /** Display order. When omitted, sort by handle asc. */
  handleOrder?: string[];
}

export function buildTrendReport(args: BuildTrendReportArgs): string {
  const { trend, lookbackWeeks } = args;
  const lines: string[] = [];
  lines.push('# Reviewer Load Trend');
  lines.push('');
  lines.push(`_${trend.size} handle${trend.size === 1 ? '' : 's'}, last ${lookbackWeeks} week${lookbackWeeks === 1 ? '' : 's'}_`);
  lines.push('');
  if (trend.size === 0) {
    lines.push('_No reviewer data in the lookback window._');
    return lines.join('\n');
  }
  const handles = args.handleOrder
    ? args.handleOrder.filter(h => trend.has(h))
    : [...trend.keys()].sort();
  for (const handle of handles) {
    const buckets = trend.get(handle)!;
    const verdict = classifyTrendVerdict(buckets);
    lines.push(`## \`@${escapePipe(handle)}\` (${verdict})`);
    lines.push('');
    lines.push(describeHandleTrend(handle, buckets));
    lines.push('');
    if (buckets.length === 0) {
      lines.push('_No weekly samples._');
      lines.push('');
      continue;
    }
    lines.push('| Week starting | Median Ack | Throughput | Samples |');
    lines.push('| --- | ---:| ---:| ---:|');
    for (const b of buckets) {
      const ack = Number.isFinite(b.medianAckHours) ? formatHours(b.medianAckHours) : '-';
      const week = formatYmd(b.weekStartMs);
      lines.push(`| ${week} | ${ack} | ${b.throughput} | ${b.ackSampleCount} |`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/g, '');
}

function parseIsoDate(s: any): number | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : undefined;
}

function formatHours(h: number): string {
  if (!Number.isFinite(h)) return '-';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function formatYmd(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }
