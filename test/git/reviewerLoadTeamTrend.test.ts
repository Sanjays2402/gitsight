import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTeamWeeklyTrend,
  classifyTeamTrendVerdict,
  describeTeamTrend,
  buildTeamTrendReport,
  parseTeamMembersJson,
  buildBothTrends,
  TeamWeekBucket,
} from '../../src/git/reviewerLoadTeamTrend';
import { AckSample, ThroughputSample } from '../../src/git/reviewerLoadTrend';

const MON_2026_05_25 = Date.UTC(2026, 4, 25); // Monday
const MON_2026_06_01 = Date.UTC(2026, 5, 1);  // Monday
const MON_2026_06_08 = Date.UTC(2026, 5, 8);  // Monday
const MON_2026_06_15 = Date.UTC(2026, 5, 15); // Monday

function ack(handle: string, ackHours: number, weekStart: number, dayOffset = 0): AckSample {
  return { handle, ackHours, submittedAtMs: weekStart + dayOffset * 24 * 3600 * 1000 };
}

function thr(handle: string, weekStart: number, dayOffset = 0): ThroughputSample {
  return { handle, submittedAtMs: weekStart + dayOffset * 24 * 3600 * 1000 };
}

describe('F140 - buildTeamWeeklyTrend', () => {
  it('aggregates samples for a single team', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice', 'bob'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [
        ack('alice', 10, MON_2026_05_25),
        ack('bob', 20, MON_2026_05_25),
        ack('alice', 5, MON_2026_06_01),
        ack('bob', 15, MON_2026_06_01),
      ],
      throughputSamples: [],
      teams,
    });
    const backend = trend.get('backend')!;
    assert.equal(backend.length, 2);
    // Week 1 median of [10, 20] = 15
    assert.equal(backend[0].medianAckHours, 15);
    // Week 2 median of [5, 15] = 10
    assert.equal(backend[1].medianAckHours, 10);
  });

  it('counts active handles per week', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice', 'bob', 'carol'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [
        ack('alice', 10, MON_2026_05_25),
        ack('bob', 20, MON_2026_05_25),
        // carol absent this week
        ack('alice', 5, MON_2026_06_01),
        // bob absent this week
      ],
      throughputSamples: [],
      teams,
    });
    const backend = trend.get('backend')!;
    assert.equal(backend[0].activeHandles, 2);
    assert.equal(backend[1].activeHandles, 1);
  });

  it('counts throughput separately from ack samples', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice', 'bob'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [],
      throughputSamples: [
        thr('alice', MON_2026_05_25),
        thr('bob', MON_2026_05_25),
        thr('alice', MON_2026_05_25, 2),
      ],
      teams,
    });
    const backend = trend.get('backend')!;
    assert.equal(backend[0].throughput, 3);
    assert.equal(Number.isNaN(backend[0].medianAckHours), true);
    assert.equal(backend[0].ackSampleCount, 0);
  });

  it('drops handles not in any team', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [
        ack('alice', 10, MON_2026_05_25),
        ack('eve', 5, MON_2026_05_25), // not in any team
      ],
      throughputSamples: [],
      teams,
    });
    // 'eve' is dropped silently. Only backend appears.
    assert.equal(trend.size, 1);
    assert.equal(trend.get('backend')!.length, 1);
    assert.equal(trend.get('backend')![0].ackSampleCount, 1);
  });

  it('counts a handle in multiple teams toward both teams', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice'])],
      ['security', new Set(['alice'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [
        ack('alice', 10, MON_2026_05_25),
        ack('alice', 20, MON_2026_05_25),
      ],
      throughputSamples: [],
      teams,
    });
    // Alice's two samples count to each team independently.
    assert.equal(trend.size, 2);
    assert.equal(trend.get('backend')![0].ackSampleCount, 2);
    assert.equal(trend.get('security')![0].ackSampleCount, 2);
  });

  it('lowercases handles before lookup', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [
        ack('Alice', 10, MON_2026_05_25), // case-mismatched
      ],
      throughputSamples: [],
      teams,
    });
    assert.equal(trend.get('backend')![0].ackSampleCount, 1);
  });

  it('returns empty Map when no teams provided', () => {
    const trend = buildTeamWeeklyTrend({
      ackSamples: [ack('alice', 10, MON_2026_05_25)],
      throughputSamples: [],
      teams: new Map(),
    });
    assert.equal(trend.size, 0);
  });

  it('sorts buckets oldest-first', () => {
    const teams = new Map<string, Set<string>>([
      ['backend', new Set(['alice'])],
    ]);
    const trend = buildTeamWeeklyTrend({
      ackSamples: [
        ack('alice', 5, MON_2026_06_15),
        ack('alice', 10, MON_2026_05_25),
        ack('alice', 7, MON_2026_06_01),
      ],
      throughputSamples: [],
      teams,
    });
    const buckets = trend.get('backend')!;
    assert.equal(buckets[0].weekStartMs, MON_2026_05_25);
    assert.equal(buckets[1].weekStartMs, MON_2026_06_01);
    assert.equal(buckets[2].weekStartMs, MON_2026_06_15);
  });
});

describe('F140 - classifyTeamTrendVerdict', () => {
  it('improving on 20%+ drop', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: 20, throughput: 5, activeHandles: 3, ackSampleCount: 5 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 14, throughput: 6, activeHandles: 3, ackSampleCount: 6 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'improving');
  });

  it('regressing on 20%+ rise', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 5, activeHandles: 3, ackSampleCount: 5 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 18, throughput: 6, activeHandles: 3, ackSampleCount: 6 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'regressing');
  });

  it('steady on <20% delta', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 5, activeHandles: 3, ackSampleCount: 5 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 11, throughput: 6, activeHandles: 3, ackSampleCount: 6 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'steady');
  });

  it('sparse-data on < 2 weeks of finite median', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 5, activeHandles: 3, ackSampleCount: 5 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'sparse-data');
  });

  it('sparse-data when both weeks lack finite ack', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: NaN, throughput: 0, activeHandles: 0, ackSampleCount: 0 },
      { weekStartMs: MON_2026_06_01, medianAckHours: NaN, throughput: 0, activeHandles: 0, ackSampleCount: 0 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'sparse-data');
  });

  it('steady on 0 -> 0', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: 0, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 0, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'steady');
  });

  it('regressing on 0 -> >1h', () => {
    const buckets: TeamWeekBucket[] = [
      { weekStartMs: MON_2026_05_25, medianAckHours: 0, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 5, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ];
    assert.equal(classifyTeamTrendVerdict(buckets), 'regressing');
  });
});

describe('F140 - describeTeamTrend', () => {
  const improving: TeamWeekBucket[] = [
    { weekStartMs: MON_2026_05_25, medianAckHours: 22, throughput: 4, activeHandles: 6, ackSampleCount: 4 },
    { weekStartMs: MON_2026_06_01, medianAckHours: 14, throughput: 5, activeHandles: 6, ackSampleCount: 5 },
  ];

  it('describes improving with arrow + active', () => {
    const s = describeTeamTrend('backend', improving);
    assert.match(s, /backend.*improving.*22h.*14h.*2w.*6 active/);
  });

  it('describes sparse data with week count', () => {
    const s = describeTeamTrend('security', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 1, activeHandles: 2, ackSampleCount: 1 },
    ]);
    assert.match(s, /sparse data.*1 week.*2 active/);
  });

  it('describes steady around average', () => {
    const s = describeTeamTrend('platform', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 6, throughput: 2, activeHandles: 3, ackSampleCount: 2 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 7, throughput: 2, activeHandles: 3, ackSampleCount: 2 },
    ]);
    assert.match(s, /steady.*~7h/); // (6+7)/2 = 6.5 -> rounds to 7h
  });

  it('formats minutes for sub-1h values', () => {
    const s = describeTeamTrend('platform', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 0.5, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 0.3, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ]);
    assert.match(s, /\d+m/);
  });

  it('formats days for >=48h values', () => {
    const s = describeTeamTrend('platform', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 72, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 60, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ]);
    assert.match(s, /\d+d/);
  });
});

describe('F140 - buildTeamTrendReport', () => {
  it('renders header + per-team sections', () => {
    const teams = new Map<string, TeamWeekBucket[]>([
      ['backend', [
        { weekStartMs: MON_2026_05_25, medianAckHours: 20, throughput: 4, activeHandles: 5, ackSampleCount: 4 },
        { weekStartMs: MON_2026_06_01, medianAckHours: 14, throughput: 5, activeHandles: 5, ackSampleCount: 5 },
      ]],
    ]);
    const md = buildTeamTrendReport({ trend: teams, lookbackWeeks: 4 });
    assert.match(md, /^# Reviewer Load Trend \(per Team\)/m);
    assert.match(md, /1 team, last 4 weeks/);
    assert.match(md, /## `backend`/);
    // Table header
    assert.match(md, /Week starting/);
    assert.match(md, /Median Ack/);
    assert.match(md, /Active/);
  });

  it('emits placeholder when trend is empty', () => {
    const md = buildTeamTrendReport({ trend: new Map(), lookbackWeeks: 4 });
    assert.match(md, /No team data/);
  });

  it('sorts regressing first, then improving, then steady, then sparse', () => {
    const trend = new Map<string, TeamWeekBucket[]>();
    trend.set('alpha-steady', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 10, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ]);
    trend.set('zeta-regressing', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 30, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ]);
    trend.set('mid-improving', [
      { weekStartMs: MON_2026_05_25, medianAckHours: 20, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
      { weekStartMs: MON_2026_06_01, medianAckHours: 8, throughput: 1, activeHandles: 1, ackSampleCount: 1 },
    ]);
    const md = buildTeamTrendReport({ trend, lookbackWeeks: 4 });
    const regrIdx = md.indexOf('zeta-regressing');
    const imprIdx = md.indexOf('mid-improving');
    const steadyIdx = md.indexOf('alpha-steady');
    assert.ok(regrIdx >= 0 && imprIdx >= 0 && steadyIdx >= 0);
    assert.ok(regrIdx < imprIdx, 'regressing must come before improving');
    assert.ok(imprIdx < steadyIdx, 'improving must come before steady');
  });

  it('honours an explicit teamOrder', () => {
    const trend = new Map<string, TeamWeekBucket[]>();
    trend.set('a', [{ weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 1, activeHandles: 1, ackSampleCount: 1 }]);
    trend.set('b', [{ weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 1, activeHandles: 1, ackSampleCount: 1 }]);
    const md = buildTeamTrendReport({ trend, lookbackWeeks: 1, teamOrder: ['b', 'a'] });
    assert.ok(md.indexOf('## `b`') < md.indexOf('## `a`'));
  });

  it('drops teamOrder entries not present in trend', () => {
    const trend = new Map<string, TeamWeekBucket[]>();
    trend.set('a', [{ weekStartMs: MON_2026_05_25, medianAckHours: 10, throughput: 1, activeHandles: 1, ackSampleCount: 1 }]);
    const md = buildTeamTrendReport({ trend, lookbackWeeks: 1, teamOrder: ['ghost', 'a'] });
    assert.doesNotMatch(md, /ghost/);
    assert.match(md, /## `a`/);
  });
});

describe('F140 - parseTeamMembersJson', () => {
  it('parses the canonical shape', () => {
    const json = JSON.stringify([
      { slug: 'backend', members: [{ login: 'alice' }, { login: 'bob' }] },
      { slug: 'security', members: [{ login: 'eve' }] },
    ]);
    const m = parseTeamMembersJson(json);
    assert.equal(m.size, 2);
    assert.deepEqual([...m.get('backend')!].sort(), ['alice', 'bob']);
    assert.deepEqual([...m.get('security')!], ['eve']);
  });

  it('lowercases slugs and handles', () => {
    const json = JSON.stringify([
      { slug: 'BACKEND', members: [{ login: 'AliCe' }] },
    ]);
    const m = parseTeamMembersJson(json);
    assert.ok(m.get('backend'));
    assert.ok(m.get('backend')!.has('alice'));
  });

  it('falls back to "name" when "slug" missing', () => {
    const json = JSON.stringify([
      { name: 'platform', members: [{ login: 'alice' }] },
    ]);
    const m = parseTeamMembersJson(json);
    assert.ok(m.get('platform'));
  });

  it('drops teams with no members', () => {
    const json = JSON.stringify([
      { slug: 'empty', members: [] },
      { slug: 'real', members: [{ login: 'alice' }] },
    ]);
    const m = parseTeamMembersJson(json);
    assert.equal(m.size, 1);
    assert.ok(m.get('real'));
  });

  it('returns empty Map on garbage', () => {
    assert.equal(parseTeamMembersJson('not-json').size, 0);
    assert.equal(parseTeamMembersJson('').size, 0);
    assert.equal(parseTeamMembersJson('{"not": "array"}').size, 0);
  });
});

describe('F140 - buildBothTrends compose', () => {
  it('builds per-handle AND per-team in one call', () => {
    const teams = new Map<string, Set<string>>([['backend', new Set(['alice'])]]);
    const both = buildBothTrends({
      ackSamples: [ack('alice', 10, MON_2026_05_25), ack('alice', 5, MON_2026_06_01)],
      throughputSamples: [],
      teams,
    });
    assert.equal(both.perHandle.size, 1);
    assert.ok(both.perHandle.get('alice'));
    assert.equal(both.perTeam.size, 1);
    assert.ok(both.perTeam.get('backend'));
  });

  it('honours a handles filter on the per-handle side', () => {
    const teams = new Map<string, Set<string>>([['backend', new Set(['alice', 'bob'])]]);
    const both = buildBothTrends({
      ackSamples: [
        ack('alice', 10, MON_2026_05_25),
        ack('bob', 20, MON_2026_05_25),
      ],
      throughputSamples: [],
      teams,
      handles: new Set(['alice']),
    });
    assert.equal(both.perHandle.size, 1, 'handles filter restricts per-handle map');
    // Team rollup still includes both members.
    assert.equal(both.perTeam.get('backend')![0].ackSampleCount, 2);
  });
});
