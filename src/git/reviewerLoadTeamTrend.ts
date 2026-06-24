/**
 * F140 - Reviewer load-balancer per-team trend report.
 *
 * Companion to F137 (per-handle weekly trend). Where F137 surfaces
 * "how is alice's median ack latency evolving over the last 4
 * weeks?", F140 rolls those samples up by GitHub TEAM so a manager
 * can see team-wide trends:
 *
 *   "team/backend-reviews median ack: 22h -> 14h over 4w (improving)"
 *   "team/security-reviews median ack: 6h -> 8h over 4w (steady)"
 *
 * Without team data, F137 is per-individual which doesn't scale -
 * if your org has 200 reviewers the per-handle table is useless.
 * F140 gives you the macro view.
 *
 * The view layer feeds team membership from
 * `gh api orgs/:o/teams/:team_slug/members` (one call per team).
 * That mapping is passed in here as a plain `Map<team_slug, Set<handle>>`
 * so the pure module stays testable.
 *
 * Pure - no vscode, no gh. Tests in test/git/reviewerLoadTeamTrend.test.ts.
 */

import {
  AckSample,
  ThroughputSample,
  WeekBucket,
  buildWeeklyTrend,
  classifyTrendVerdict,
  TrendVerdict,
} from './reviewerLoadTrend';
import { median } from './reviewerLoadBalancer';

/**
 * A team-aggregated weekly bucket.
 *
 * The team-level median is computed by pooling ALL handle samples in
 * the team for that week (not by averaging per-handle medians, which
 * would weight a slow-but-rarely-reviewing reviewer the same as a
 * fast high-volume reviewer - misleading).
 *
 * `activeHandles` counts the distinct handles that contributed an
 * ack sample in that week (i.e. the "how many team members were
 * actually reviewing?" signal).
 */
export interface TeamWeekBucket {
  weekStartMs: number;
  /** Pooled median across all handles in the team. NaN when no samples. */
  medianAckHours: number;
  /** Total throughput (sum of per-handle weekly throughput). */
  throughput: number;
  /** Distinct team handles with at least one ack sample that week. */
  activeHandles: number;
  /** Total ack samples in the pool. */
  ackSampleCount: number;
}

/** Input for the team-aggregated trend builder. */
export interface TeamTrendArgs {
  ackSamples: AckSample[];
  throughputSamples: ThroughputSample[];
  /** team_slug -> set of lowercase handle members. */
  teams: Map<string, ReadonlySet<string>>;
}

/**
 * Build the per-team weekly trend. Returns one Map keyed by team slug;
 * each value is an array of TeamWeekBucket sorted by weekStartMs asc.
 *
 * Handles that aren't in ANY team are silently dropped - we only
 * report on team-affiliated activity. A handle that's in multiple
 * teams contributes its samples to EACH team (this matches GitHub's
 * mental model where a person on @org/backend AND @org/security
 * counts toward both teams' load).
 */
export function buildTeamWeeklyTrend(args: TeamTrendArgs): Map<string, TeamWeekBucket[]> {
  const out = new Map<string, TeamWeekBucket[]>();
  if (args.teams.size === 0) return out;
  // Pre-index handle -> set of team slugs for cheap lookup.
  const handleToTeams = new Map<string, string[]>();
  for (const [team, members] of args.teams) {
    for (const h of members) {
      const handle = h.toLowerCase();
      const teams = handleToTeams.get(handle) ?? [];
      teams.push(team);
      handleToTeams.set(handle, teams);
    }
  }
  // Per-team per-week aggregations.
  type WeekAgg = { ackHours: number[]; throughput: number; activeHandles: Set<string>; };
  const perTeam = new Map<string, Map<number, WeekAgg>>();
  function getOrCreate(team: string, week: number): WeekAgg {
    let perWeek = perTeam.get(team);
    if (!perWeek) { perWeek = new Map(); perTeam.set(team, perWeek); }
    let agg = perWeek.get(week);
    if (!agg) {
      agg = { ackHours: [], throughput: 0, activeHandles: new Set() };
      perWeek.set(week, agg);
    }
    return agg;
  }

  for (const s of args.ackSamples) {
    const teams = handleToTeams.get(s.handle.toLowerCase());
    if (!teams) continue;
    const week = bucketWeekStartUtc(s.submittedAtMs);
    for (const team of teams) {
      const agg = getOrCreate(team, week);
      agg.ackHours.push(s.ackHours);
      agg.activeHandles.add(s.handle.toLowerCase());
    }
  }
  for (const s of args.throughputSamples) {
    const teams = handleToTeams.get(s.handle.toLowerCase());
    if (!teams) continue;
    const week = bucketWeekStartUtc(s.submittedAtMs);
    for (const team of teams) {
      const agg = getOrCreate(team, week);
      agg.throughput += 1;
    }
  }

  for (const [team, perWeek] of perTeam) {
    const buckets: TeamWeekBucket[] = [];
    for (const [week, agg] of perWeek) {
      const sorted = agg.ackHours.length > 0 ? [...agg.ackHours].sort((a, b) => a - b) : [];
      buckets.push({
        weekStartMs: week,
        medianAckHours: sorted.length > 0 ? median(sorted) : NaN,
        throughput: agg.throughput,
        activeHandles: agg.activeHandles.size,
        ackSampleCount: agg.ackHours.length,
      });
    }
    buckets.sort((a, b) => a.weekStartMs - b.weekStartMs);
    out.set(team, buckets);
  }
  return out;
}

function bucketWeekStartUtc(ms: number): number {
  // Identical bucketing semantics to F137's bucketWeekStart, kept
  // local so we don't need to re-export it from reviewerLoadTrend.ts.
  const d = new Date(ms);
  const dow = d.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
}

/**
 * Classify the team's verdict using the same shape as F137 but
 * gated on samples-per-team (so a 1-member team doesn't get
 * regressing on a one-week blip).
 */
export function classifyTeamTrendVerdict(buckets: TeamWeekBucket[]): TrendVerdict {
  const withAck = buckets.filter(b => Number.isFinite(b.medianAckHours));
  if (withAck.length < 2) return 'sparse-data';
  const first = withAck[0].medianAckHours;
  const last = withAck[withAck.length - 1].medianAckHours;
  if (first === 0 && last === 0) return 'steady';
  if (first === 0) {
    return last > 1 ? 'regressing' : 'steady';
  }
  const delta = (last - first) / first;
  if (delta <= -0.2) return 'improving';
  if (delta >= 0.2) return 'regressing';
  return 'steady';
}

/**
 * Headline for the picker row. Examples:
 *   "team/backend-reviews: improving (22h -> 14h over 4w, 6 active)"
 *   "team/security-reviews: sparse data (1w, 2 active)"
 */
export function describeTeamTrend(team: string, buckets: TeamWeekBucket[]): string {
  const verdict = classifyTeamTrendVerdict(buckets);
  const withAck = buckets.filter(b => Number.isFinite(b.medianAckHours));
  if (verdict === 'sparse-data') {
    const n = buckets.length;
    const totalActive = uniqueActive(buckets);
    return `${team}: sparse data (${n} week${n === 1 ? '' : 's'}, ${totalActive} active)`;
  }
  const first = withAck[0].medianAckHours;
  const last = withAck[withAck.length - 1].medianAckHours;
  const weeks = withAck.length;
  const totalActive = uniqueActive(buckets);
  if (verdict === 'steady') {
    const avg = (first + last) / 2;
    return `${team}: steady (~${formatHours(avg)} across ${weeks}w, ${totalActive} active)`;
  }
  return `${team}: ${verdict} (${formatHours(first)} \\u2192 ${formatHours(last)} over ${weeks}w, ${totalActive} active)`;
}

function uniqueActive(buckets: TeamWeekBucket[]): number {
  if (buckets.length === 0) return 0;
  // We don't have the SET of handles here, just per-bucket counts.
  // Best estimate: max count across buckets (a handle that reviewed
  // in week 1 + week 4 would otherwise be counted as 2; the max gives
  // a stable "how big was the active subset at peak?").
  let max = 0;
  for (const b of buckets) {
    if (b.activeHandles > max) max = b.activeHandles;
  }
  return max;
}

function formatHours(h: number): string {
  if (!Number.isFinite(h)) return '-';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Build the markdown report body. Same shape as F137's per-handle
 * report but rolled up by team.
 */
export interface BuildTeamTrendReportArgs {
  trend: Map<string, TeamWeekBucket[]>;
  lookbackWeeks: number;
  /** Display order. When omitted, sort by verdict-priority then team asc. */
  teamOrder?: string[];
}

export function buildTeamTrendReport(args: BuildTeamTrendReportArgs): string {
  const { trend, lookbackWeeks } = args;
  const lines: string[] = [];
  lines.push('# Reviewer Load Trend (per Team)');
  lines.push('');
  lines.push(`_${trend.size} team${trend.size === 1 ? '' : 's'}, last ${lookbackWeeks} week${lookbackWeeks === 1 ? '' : 's'}_`);
  lines.push('');
  if (trend.size === 0) {
    lines.push('_No team data in the lookback window._');
    return lines.join('\n');
  }
  const teams = args.teamOrder
    ? args.teamOrder.filter(t => trend.has(t))
    : sortByVerdictPriority(trend);
  for (const team of teams) {
    const buckets = trend.get(team)!;
    const verdict = classifyTeamTrendVerdict(buckets);
    lines.push(`## \`${escapePipe(team)}\` (${verdict})`);
    lines.push('');
    lines.push(describeTeamTrend(team, buckets));
    lines.push('');
    if (buckets.length === 0) {
      lines.push('_No weekly samples._');
      lines.push('');
      continue;
    }
    lines.push('| Week starting | Median Ack | Throughput | Active | Samples |');
    lines.push('| --- | ---:| ---:| ---:| ---:|');
    for (const b of buckets) {
      const ack = Number.isFinite(b.medianAckHours) ? formatHours(b.medianAckHours) : '-';
      const week = formatYmd(b.weekStartMs);
      lines.push(`| ${week} | ${ack} | ${b.throughput} | ${b.activeHandles} | ${b.ackSampleCount} |`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/g, '');
}

function sortByVerdictPriority(trend: Map<string, TeamWeekBucket[]>): string[] {
  // Order: regressing first (most urgent), then improving (celebrate),
  // then steady, then sparse-data. Within each tier, alpha by team.
  const rank = { regressing: 0, improving: 1, steady: 2, 'sparse-data': 3 };
  const entries = [...trend.entries()].map(([team, buckets]) => ({
    team,
    verdict: classifyTeamTrendVerdict(buckets),
  }));
  entries.sort((a, b) => {
    const ra = rank[a.verdict];
    const rb = rank[b.verdict];
    if (ra !== rb) return ra - rb;
    return a.team.localeCompare(b.team);
  });
  return entries.map(e => e.team);
}

function formatYmd(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }

/**
 * Parse the `gh api orgs/:o/teams` JSON shape into a normalised
 * Map<team_slug, Set<handle>>. The view layer fans this out from
 * a per-team `members` API call.
 *
 * Shape tolerated:
 *   [
 *     { "slug": "backend-reviews", "members": [{ "login": "alice" }, ...] },
 *     ...
 *   ]
 *
 * Returns an empty Map on bad input - the report just renders
 * "no team data".
 */
export function parseTeamMembersJson(raw: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!raw || !raw.trim()) return out;
  let arr: any;
  try { arr = JSON.parse(raw); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const team of arr) {
    if (!team || typeof team !== 'object') continue;
    const slug = (team.slug ?? team.name ?? '').toString().toLowerCase();
    if (!slug) continue;
    const members = Array.isArray(team.members) ? team.members : [];
    const set = new Set<string>();
    for (const m of members) {
      const login = (m?.login ?? '').toString().toLowerCase();
      if (login) set.add(login);
    }
    if (set.size > 0) out.set(slug, set);
  }
  return out;
}

/**
 * Convenience: produce both the per-handle AND per-team trend in
 * one call. Handy for the report view that wants both.
 */
export interface BuildBothTrendsArgs {
  ackSamples: AckSample[];
  throughputSamples: ThroughputSample[];
  teams: Map<string, ReadonlySet<string>>;
  handles?: ReadonlySet<string>;
}

export interface BothTrendsResult {
  perHandle: Map<string, WeekBucket[]>;
  perTeam: Map<string, TeamWeekBucket[]>;
}

export function buildBothTrends(args: BuildBothTrendsArgs): BothTrendsResult {
  const perHandle = buildWeeklyTrend({
    ackSamples: args.ackSamples,
    throughputSamples: args.throughputSamples,
    handles: args.handles,
  });
  const perTeam = buildTeamWeeklyTrend({
    ackSamples: args.ackSamples,
    throughputSamples: args.throughputSamples,
    teams: args.teams,
  });
  return { perHandle, perTeam };
}
