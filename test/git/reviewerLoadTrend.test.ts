import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAckSamplesWithTimestamps,
  parseThroughputSamples,
  bucketWeekStart,
  buildWeeklyTrend,
  classifyTrendVerdict,
  describeHandleTrend,
  buildTrendReport,
  AckSample,
  WeekBucket,
} from '../../src/git/reviewerLoadTrend';

// Anchor dates for stable bucketing.
// 2026-06-22 is a Monday in UTC. Reference dates below all use this week.
const MONDAY = Date.UTC(2026, 5, 22); // 2026-06-22 (Mon)
const TUESDAY = Date.UTC(2026, 5, 23);
const SUNDAY_NEXT = Date.UTC(2026, 5, 28); // still same week
const NEXT_MONDAY = Date.UTC(2026, 5, 29); // next week
const THREE_WEEKS_AGO_MON = Date.UTC(2026, 5, 1); // 2026-06-01 Mon
const TWO_WEEKS_AGO_MON = Date.UTC(2026, 5, 8); // 2026-06-08 Mon
const LAST_WEEK_MON = Date.UTC(2026, 5, 15); // 2026-06-15 Mon

function sample(handle: string, ackHours: number, atMs: number): AckSample {
  return { handle, ackHours, submittedAtMs: atMs };
}

test('bucketWeekStart: Monday returns same date floor', () => {
  assert.equal(bucketWeekStart(MONDAY), MONDAY);
});

test('bucketWeekStart: Tuesday rounds back to Monday', () => {
  assert.equal(bucketWeekStart(TUESDAY), MONDAY);
});

test('bucketWeekStart: Sunday rounds back to PREVIOUS Monday', () => {
  assert.equal(bucketWeekStart(SUNDAY_NEXT), MONDAY);
});

test('bucketWeekStart: next-Monday starts new bucket', () => {
  assert.equal(bucketWeekStart(NEXT_MONDAY), NEXT_MONDAY);
});

test('bucketWeekStart: mid-day rounds to UTC midnight Monday', () => {
  const noon = MONDAY + 12 * 3600_000;
  assert.equal(bucketWeekStart(noon), MONDAY);
});

test('parseAckSamplesWithTimestamps: extracts first-review-per-PR', () => {
  const raw = JSON.stringify([
    {
      createdAt: new Date(MONDAY).toISOString(),
      reviews: [
        { author: { login: 'Alice' }, submittedAt: new Date(MONDAY + 4 * 3600_000).toISOString() },
        { author: { login: 'alice' }, submittedAt: new Date(MONDAY + 8 * 3600_000).toISOString() },
      ],
    },
  ]);
  const out = parseAckSamplesWithTimestamps(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
  assert.equal(out[0].ackHours, 4);
});

test('parseAckSamplesWithTimestamps: handles filter restricts output', () => {
  const raw = JSON.stringify([
    {
      createdAt: new Date(MONDAY).toISOString(),
      reviews: [
        { author: { login: 'alice' }, submittedAt: new Date(MONDAY + 1 * 3600_000).toISOString() },
        { author: { login: 'bob' }, submittedAt: new Date(MONDAY + 2 * 3600_000).toISOString() },
      ],
    },
  ]);
  const out = parseAckSamplesWithTimestamps(raw, new Set(['alice']));
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('parseAckSamplesWithTimestamps: empty / invalid input -> empty', () => {
  assert.deepEqual(parseAckSamplesWithTimestamps(''), []);
  assert.deepEqual(parseAckSamplesWithTimestamps('not json'), []);
  assert.deepEqual(parseAckSamplesWithTimestamps('{}'), []);
});

test('parseThroughputSamples: one row per (PR, reviewer)', () => {
  const raw = JSON.stringify([
    {
      reviews: [
        { author: { login: 'alice' }, submittedAt: new Date(MONDAY).toISOString() },
        { author: { login: 'alice' }, submittedAt: new Date(MONDAY + 3600_000).toISOString() },
        { author: { login: 'bob' }, submittedAt: new Date(MONDAY).toISOString() },
      ],
    },
    {
      reviews: [
        { author: { login: 'alice' }, submittedAt: new Date(NEXT_MONDAY).toISOString() },
      ],
    },
  ]);
  const out = parseThroughputSamples(raw);
  assert.equal(out.length, 3); // alice x2 (one per PR), bob x1
  const alice = out.filter(s => s.handle === 'alice');
  assert.equal(alice.length, 2);
});

test('parseThroughputSamples: empty / invalid input -> empty', () => {
  assert.deepEqual(parseThroughputSamples(''), []);
  assert.deepEqual(parseThroughputSamples('garbage'), []);
});

test('buildWeeklyTrend: aggregates ack samples per week', () => {
  const ack = [
    sample('alice', 18, THREE_WEEKS_AGO_MON),
    sample('alice', 20, THREE_WEEKS_AGO_MON + 24 * 3600_000),
    sample('alice', 7, LAST_WEEK_MON),
  ];
  const trend = buildWeeklyTrend({ ackSamples: ack, throughputSamples: [] });
  const aliceBuckets = trend.get('alice')!;
  assert.equal(aliceBuckets.length, 2);
  assert.equal(aliceBuckets[0].weekStartMs, THREE_WEEKS_AGO_MON);
  assert.equal(aliceBuckets[0].medianAckHours, 19); // median of [18, 20]
  assert.equal(aliceBuckets[1].weekStartMs, LAST_WEEK_MON);
  assert.equal(aliceBuckets[1].medianAckHours, 7);
});

test('buildWeeklyTrend: throughput counts per week', () => {
  const tp = [
    { handle: 'alice', submittedAtMs: THREE_WEEKS_AGO_MON },
    { handle: 'alice', submittedAtMs: THREE_WEEKS_AGO_MON + 3600_000 },
    { handle: 'alice', submittedAtMs: LAST_WEEK_MON },
  ];
  const trend = buildWeeklyTrend({ ackSamples: [], throughputSamples: tp });
  const buckets = trend.get('alice')!;
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].throughput, 2);
  assert.equal(buckets[1].throughput, 1);
});

test('buildWeeklyTrend: handles filter restricts handles', () => {
  const ack = [
    sample('alice', 5, MONDAY),
    sample('bob', 12, MONDAY),
  ];
  const trend = buildWeeklyTrend({
    ackSamples: ack,
    throughputSamples: [],
    handles: new Set(['alice']),
  });
  assert.equal(trend.size, 1);
  assert.ok(trend.has('alice'));
});

test('buildWeeklyTrend: bucket sample count separate from throughput', () => {
  const trend = buildWeeklyTrend({
    ackSamples: [
      sample('alice', 1, MONDAY),
      sample('alice', 3, MONDAY),
    ],
    throughputSamples: [
      { handle: 'alice', submittedAtMs: MONDAY },
    ],
  });
  const b = trend.get('alice')![0];
  assert.equal(b.ackSampleCount, 2);
  assert.equal(b.throughput, 1);
});

test('buildWeeklyTrend: buckets sorted ascending by weekStartMs', () => {
  const ack = [
    sample('alice', 5, NEXT_MONDAY),
    sample('alice', 3, MONDAY),
    sample('alice', 9, NEXT_MONDAY + 7 * 24 * 3600_000),
  ];
  const trend = buildWeeklyTrend({ ackSamples: ack, throughputSamples: [] });
  const buckets = trend.get('alice')!;
  assert.equal(buckets[0].weekStartMs, MONDAY);
  assert.equal(buckets[1].weekStartMs, NEXT_MONDAY);
  assert.equal(buckets[2].weekStartMs, NEXT_MONDAY + 7 * 24 * 3600_000);
});

test('classifyTrendVerdict: improving when latest median dropped >=20%', () => {
  const b: WeekBucket[] = [
    { weekStartMs: THREE_WEEKS_AGO_MON, medianAckHours: 20, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: TWO_WEEKS_AGO_MON, medianAckHours: 15, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: LAST_WEEK_MON, medianAckHours: 8, throughput: 5, ackSampleCount: 5 },
  ];
  assert.equal(classifyTrendVerdict(b), 'improving');
});

test('classifyTrendVerdict: regressing when latest median rose >=20%', () => {
  const b: WeekBucket[] = [
    { weekStartMs: THREE_WEEKS_AGO_MON, medianAckHours: 5, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: LAST_WEEK_MON, medianAckHours: 25, throughput: 5, ackSampleCount: 5 },
  ];
  assert.equal(classifyTrendVerdict(b), 'regressing');
});

test('classifyTrendVerdict: steady inside +-20% window', () => {
  const b: WeekBucket[] = [
    { weekStartMs: THREE_WEEKS_AGO_MON, medianAckHours: 10, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: LAST_WEEK_MON, medianAckHours: 11, throughput: 5, ackSampleCount: 5 },
  ];
  assert.equal(classifyTrendVerdict(b), 'steady');
});

test('classifyTrendVerdict: fewer than 2 buckets with finite medians -> sparse-data', () => {
  assert.equal(classifyTrendVerdict([]), 'sparse-data');
  assert.equal(classifyTrendVerdict([
    { weekStartMs: MONDAY, medianAckHours: 10, throughput: 5, ackSampleCount: 5 },
  ]), 'sparse-data');
  assert.equal(classifyTrendVerdict([
    { weekStartMs: MONDAY, medianAckHours: NaN, throughput: 5, ackSampleCount: 0 },
    { weekStartMs: NEXT_MONDAY, medianAckHours: 5, throughput: 5, ackSampleCount: 1 },
  ]), 'sparse-data');
});

test('classifyTrendVerdict: zero -> nonzero with delta > 1h -> regressing', () => {
  const b: WeekBucket[] = [
    { weekStartMs: MONDAY, medianAckHours: 0, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: NEXT_MONDAY, medianAckHours: 5, throughput: 5, ackSampleCount: 5 },
  ];
  assert.equal(classifyTrendVerdict(b), 'regressing');
});

test('classifyTrendVerdict: zero -> small positive -> steady', () => {
  const b: WeekBucket[] = [
    { weekStartMs: MONDAY, medianAckHours: 0, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: NEXT_MONDAY, medianAckHours: 0.5, throughput: 5, ackSampleCount: 5 },
  ];
  assert.equal(classifyTrendVerdict(b), 'steady');
});

test('describeHandleTrend: improving format', () => {
  const b: WeekBucket[] = [
    { weekStartMs: THREE_WEEKS_AGO_MON, medianAckHours: 18, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: LAST_WEEK_MON, medianAckHours: 7, throughput: 5, ackSampleCount: 5 },
  ];
  const d = describeHandleTrend('alice', b);
  assert.match(d, /alice: improving \(18h \u2192 7h over 2w\)/);
});

test('describeHandleTrend: steady format', () => {
  const b: WeekBucket[] = [
    { weekStartMs: MONDAY, medianAckHours: 6, throughput: 5, ackSampleCount: 5 },
    { weekStartMs: NEXT_MONDAY, medianAckHours: 7, throughput: 5, ackSampleCount: 5 },
  ];
  const d = describeHandleTrend('alice', b);
  assert.match(d, /alice: steady \(~7h across 2w\)/); // avg of [6,7] rounded
});

test('describeHandleTrend: sparse data format', () => {
  assert.equal(describeHandleTrend('alice', []), 'alice: sparse data (0 weeks)');
  assert.equal(describeHandleTrend('alice', [
    { weekStartMs: MONDAY, medianAckHours: 5, throughput: 5, ackSampleCount: 5 },
  ]), 'alice: sparse data (1 week)');
});

test('buildTrendReport: empty trend emits stub', () => {
  const md = buildTrendReport({ trend: new Map(), lookbackWeeks: 4 });
  assert.match(md, /# Reviewer Load Trend/);
  assert.match(md, /No reviewer data in the lookback window/);
});

test('buildTrendReport: multi-handle output sorted by handle asc by default', () => {
  const trend = new Map([
    ['carol', [{ weekStartMs: MONDAY, medianAckHours: 10, throughput: 1, ackSampleCount: 1 }]],
    ['alice', [{ weekStartMs: MONDAY, medianAckHours: 5, throughput: 1, ackSampleCount: 1 }]],
    ['bob', [{ weekStartMs: MONDAY, medianAckHours: 7, throughput: 1, ackSampleCount: 1 }]],
  ]);
  const md = buildTrendReport({ trend, lookbackWeeks: 4 });
  const aliceIdx = md.indexOf('@alice');
  const bobIdx = md.indexOf('@bob');
  const carolIdx = md.indexOf('@carol');
  assert.ok(aliceIdx >= 0 && bobIdx > aliceIdx && carolIdx > bobIdx);
});

test('buildTrendReport: respects handleOrder', () => {
  const trend = new Map([
    ['alice', [{ weekStartMs: MONDAY, medianAckHours: 5, throughput: 1, ackSampleCount: 1 }]],
    ['bob', [{ weekStartMs: MONDAY, medianAckHours: 7, throughput: 1, ackSampleCount: 1 }]],
  ]);
  const md = buildTrendReport({ trend, lookbackWeeks: 4, handleOrder: ['bob', 'alice'] });
  assert.ok(md.indexOf('@bob') < md.indexOf('@alice'));
});

test('buildTrendReport: per-handle table includes verdict + week rows', () => {
  const trend = new Map([
    ['alice', [
      { weekStartMs: MONDAY, medianAckHours: 18, throughput: 4, ackSampleCount: 4 },
      { weekStartMs: NEXT_MONDAY, medianAckHours: 6, throughput: 5, ackSampleCount: 5 },
    ]],
  ]);
  const md = buildTrendReport({ trend, lookbackWeeks: 4 });
  assert.match(md, /## `@alice` \(improving\)/);
  assert.match(md, /\| Week starting \| Median Ack \| Throughput \| Samples \|/);
  assert.match(md, /2026-06-22.*18h.*4.*4/);
  assert.match(md, /2026-06-29.*6h.*5.*5/);
});

test('buildTrendReport: NaN medians render as -', () => {
  const trend = new Map([
    ['alice', [
      { weekStartMs: MONDAY, medianAckHours: NaN, throughput: 0, ackSampleCount: 0 },
      { weekStartMs: NEXT_MONDAY, medianAckHours: 5, throughput: 1, ackSampleCount: 1 },
    ]],
  ]);
  const md = buildTrendReport({ trend, lookbackWeeks: 2 });
  // The NaN row should have "-" in the median column.
  assert.match(md, /\| 2026-06-22 \| - \| 0 \| 0 \|/);
});

test('buildTrendReport: header pluralisation', () => {
  const trend1 = new Map([['alice', []]]);
  const md1 = buildTrendReport({ trend: trend1, lookbackWeeks: 1 });
  assert.match(md1, /1 handle, last 1 week_/);
  const trend2 = new Map([
    ['alice', [{ weekStartMs: MONDAY, medianAckHours: 5, throughput: 1, ackSampleCount: 1 }]],
    ['bob', [{ weekStartMs: MONDAY, medianAckHours: 7, throughput: 1, ackSampleCount: 1 }]],
  ]);
  const md2 = buildTrendReport({ trend: trend2, lookbackWeeks: 4 });
  assert.match(md2, /2 handles, last 4 weeks_/);
});
