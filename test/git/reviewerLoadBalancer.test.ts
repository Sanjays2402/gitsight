import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  scoreReviewerLoad,
  rerankByLoadBalance,
  parsePendingFromGhJson,
  parseAckLatencySamples,
  parseThroughputCounts,
  median,
  buildReviewerLoadStats,
  describeLoadStats,
  classifyVerdict,
  buildLoadReport,
  ReviewerLoadScore,
  ReviewerLoadStats,
} from '../../src/git/reviewerLoadBalancer';
import { ReviewerSuggestion } from '../../src/git/defaultReviewers';

function stats(handle: string, p: Partial<ReviewerLoadStats> = {}): ReviewerLoadStats {
  return {
    handle: handle.toLowerCase(),
    pending: 0,
    recentThroughput: 0,
    medianAckHours: 0,
    unknown: false,
    ...p,
  };
}

function sug(handle: string, ownedCount: number, kind: 'user' | 'team' = 'user'): ReviewerSuggestion {
  return {
    handle: handle.toLowerCase(),
    displayHandle: `@${handle.toLowerCase()}`,
    kind,
    ownedPaths: Array.from({ length: ownedCount }, (_, i) => `path/${i}`),
    coverage: ownedCount / 5,
  };
}

// ── scoreReviewerLoad ─────────────────────────────────────────────────
test('scoreReviewerLoad: zero stats produces zero score for known reviewer', () => {
  const r = scoreReviewerLoad(stats('alice'));
  assert.equal(r.score, 0);
  assert.equal(r.components.queueComponent, 0);
});

test('scoreReviewerLoad: pending weighted 5 per request by default', () => {
  const r = scoreReviewerLoad(stats('alice', { pending: 3 }));
  assert.equal(r.score, 15);
  assert.equal(r.components.queueComponent, 15);
});

test('scoreReviewerLoad: latency weighted 0.1 per hour', () => {
  const r = scoreReviewerLoad(stats('alice', { medianAckHours: 24 }));
  // 0.1 * 24 in JS = 2.4000000000000004 (floating-point), not exact 2.4
  assert.ok(Math.abs(r.score - 2.4) < 1e-9, `expected ~2.4, got ${r.score}`);
});

test('scoreReviewerLoad: throughput subtracts 2 per recent review (capped at 20)', () => {
  const r1 = scoreReviewerLoad(stats('alice', { recentThroughput: 5, pending: 4 }));
  assert.equal(r1.score, 20 - 10); // 4*5 - 5*2 = 10
  // Throughput cap: 50 recent reviews should still only score as if 20
  const r2 = scoreReviewerLoad(stats('alice', { recentThroughput: 50, pending: 0 }));
  assert.equal(r2.score, 0 - 40); // 0 - min(50,20)*2 = -40
});

test('scoreReviewerLoad: unknown reviewers get neutral 50 by default', () => {
  const r = scoreReviewerLoad(stats('mystery', { unknown: true }));
  assert.equal(r.score, 50);
  assert.equal(r.components.queueComponent, 0);
});

test('scoreReviewerLoad: weights are configurable', () => {
  const r = scoreReviewerLoad(stats('alice', { pending: 2, medianAckHours: 10, recentThroughput: 3 }), {
    pendingWeight: 10,
    latencyWeight: 0.5,
    throughputWeight: 1,
    throughputCap: 5,
  });
  // 2*10 + 10*0.5 - min(3,5)*1 = 20 + 5 - 3 = 22
  assert.equal(r.score, 22);
});

test('scoreReviewerLoad: negative values clamp to zero before weighting', () => {
  const r = scoreReviewerLoad(stats('alice', { pending: -5, medianAckHours: -10, recentThroughput: -3 }));
  assert.equal(r.score, 0);
});

// ── rerankByLoadBalance ───────────────────────────────────────────────
test('rerankByLoadBalance: within a tier, lower score wins', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3), sug('carol', 3)];
  const scores = new Map<string, ReviewerLoadScore>([
    ['alice', { handle: 'alice', score: 30, components: { queueComponent: 30, latencyComponent: 0, throughputComponent: 0 } }],
    ['bob',   { handle: 'bob',   score: 10, components: { queueComponent: 10, latencyComponent: 0, throughputComponent: 0 } }],
    ['carol', { handle: 'carol', score: 20, components: { queueComponent: 20, latencyComponent: 0, throughputComponent: 0 } }],
  ]);
  const result = rerankByLoadBalance({ suggestions, scores });
  assert.deepEqual(result.map(r => r.handle), ['bob', 'carol', 'alice']);
});

test('rerankByLoadBalance: tier invariant preserved (higher coverage above lower)', () => {
  // alice owns 3 paths (busy), bob owns 1 path (idle): bob should NOT
  // overtake alice in the final order, despite a better load score.
  const suggestions = [sug('alice', 3), sug('bob', 1)];
  const scores = new Map<string, ReviewerLoadScore>([
    ['alice', { handle: 'alice', score: 100, components: { queueComponent: 100, latencyComponent: 0, throughputComponent: 0 } }],
    ['bob',   { handle: 'bob',   score: 0,   components: { queueComponent: 0,   latencyComponent: 0, throughputComponent: 0 } }],
  ]);
  const result = rerankByLoadBalance({ suggestions, scores });
  assert.deepEqual(result.map(r => r.handle), ['alice', 'bob']);
});

test('rerankByLoadBalance: missing scores treated as positive infinity (sink to bottom of tier)', () => {
  const suggestions = [sug('alice', 2), sug('mystery', 2)];
  const scores = new Map<string, ReviewerLoadScore>([
    ['alice', { handle: 'alice', score: 5, components: { queueComponent: 5, latencyComponent: 0, throughputComponent: 0 } }],
  ]);
  const result = rerankByLoadBalance({ suggestions, scores });
  assert.deepEqual(result.map(r => r.handle), ['alice', 'mystery']);
});

test('rerankByLoadBalance: user before team on tied score', () => {
  const suggestions = [sug('myorg/core', 2, 'team'), sug('alice', 2)];
  const scores = new Map<string, ReviewerLoadScore>([
    ['alice',       { handle: 'alice', score: 0, components: { queueComponent: 0, latencyComponent: 0, throughputComponent: 0 } }],
    ['myorg/core',  { handle: 'myorg/core', score: 0, components: { queueComponent: 0, latencyComponent: 0, throughputComponent: 0 } }],
  ]);
  const result = rerankByLoadBalance({ suggestions, scores });
  assert.deepEqual(result.map(r => r.handle), ['alice', 'myorg/core']);
});

test('rerankByLoadBalance: empty suggestion list returns empty', () => {
  const result = rerankByLoadBalance({ suggestions: [], scores: new Map() });
  assert.deepEqual(result, []);
});

// ── parsePendingFromGhJson ────────────────────────────────────────────
test('parsePendingFromGhJson: counts array entries', () => {
  assert.equal(parsePendingFromGhJson('[{"number":1},{"number":2},{"number":3}]'), 3);
});

test('parsePendingFromGhJson: empty array -> 0', () => {
  assert.equal(parsePendingFromGhJson('[]'), 0);
});

test('parsePendingFromGhJson: empty/invalid input -> 0', () => {
  assert.equal(parsePendingFromGhJson(''), 0);
  assert.equal(parsePendingFromGhJson('not json'), 0);
  assert.equal(parsePendingFromGhJson('null'), 0);
});

test('parsePendingFromGhJson: tolerates older gh single-object shape', () => {
  assert.equal(parsePendingFromGhJson('{"number":42,"url":"x"}'), 1);
});

// ── parseAckLatencySamples ────────────────────────────────────────────
test('parseAckLatencySamples: first review per author per PR', () => {
  const raw = JSON.stringify([
    {
      createdAt: '2026-06-01T00:00:00Z',
      reviews: [
        { author: { login: 'alice' }, submittedAt: '2026-06-01T06:00:00Z' },
        { author: { login: 'alice' }, submittedAt: '2026-06-02T00:00:00Z' }, // second review, ignored
        { author: { login: 'bob' },   submittedAt: '2026-06-01T12:00:00Z' },
      ],
    },
  ]);
  const samples = parseAckLatencySamples({ raw });
  assert.deepEqual(samples.get('alice'), [6]);
  assert.deepEqual(samples.get('bob'), [12]);
});

test('parseAckLatencySamples: aggregates across multiple PRs', () => {
  const raw = JSON.stringify([
    { createdAt: '2026-06-01T00:00:00Z', reviews: [{ author: { login: 'alice' }, submittedAt: '2026-06-01T02:00:00Z' }] },
    { createdAt: '2026-06-02T00:00:00Z', reviews: [{ author: { login: 'alice' }, submittedAt: '2026-06-02T08:00:00Z' }] },
    { createdAt: '2026-06-03T00:00:00Z', reviews: [{ author: { login: 'alice' }, submittedAt: '2026-06-03T04:00:00Z' }] },
  ]);
  const samples = parseAckLatencySamples({ raw });
  assert.deepEqual(samples.get('alice'), [2, 4, 8]); // sorted ascending
});

test('parseAckLatencySamples: handles set filter respected', () => {
  const raw = JSON.stringify([
    { createdAt: '2026-06-01T00:00:00Z', reviews: [
      { author: { login: 'alice' }, submittedAt: '2026-06-01T01:00:00Z' },
      { author: { login: 'bob' },   submittedAt: '2026-06-01T02:00:00Z' },
    ]},
  ]);
  const samples = parseAckLatencySamples({ raw, handles: new Set(['alice']) });
  assert.ok(samples.has('alice'));
  assert.equal(samples.has('bob'), false);
});

test('parseAckLatencySamples: skips bad timestamps and bad shapes', () => {
  const raw = JSON.stringify([
    { createdAt: 'not-a-date', reviews: [{ author: { login: 'alice' }, submittedAt: '2026-06-01T00:00:00Z' }] },
    { createdAt: '2026-06-01T00:00:00Z', reviews: [{ author: null, submittedAt: '2026-06-01T01:00:00Z' }] },
    { createdAt: '2026-06-01T00:00:00Z', reviews: [{ author: { login: 'bob' }, submittedAt: 'bad' }] },
    null,
  ]);
  const samples = parseAckLatencySamples({ raw });
  assert.equal(samples.size, 0);
});

test('parseAckLatencySamples: negative latencies clamp to zero', () => {
  // Review submitted BEFORE the PR was created? Possible from clock skew
  // or imported PRs. Clamp to 0 rather than producing a negative ack.
  const raw = JSON.stringify([
    { createdAt: '2026-06-01T06:00:00Z', reviews: [{ author: { login: 'alice' }, submittedAt: '2026-06-01T00:00:00Z' }] },
  ]);
  const samples = parseAckLatencySamples({ raw });
  assert.deepEqual(samples.get('alice'), [0]);
});

test('parseAckLatencySamples: empty or unparseable input returns empty map', () => {
  assert.equal(parseAckLatencySamples({ raw: '' }).size, 0);
  assert.equal(parseAckLatencySamples({ raw: 'garbage' }).size, 0);
  assert.equal(parseAckLatencySamples({ raw: '{"not":"array"}' }).size, 0);
});

// ── parseThroughputCounts ─────────────────────────────────────────────
test('parseThroughputCounts: counts distinct (PR, author) pairs', () => {
  const raw = JSON.stringify([
    {
      reviews: [
        { author: { login: 'alice' } },
        { author: { login: 'alice' } }, // same PR, deduped
        { author: { login: 'bob' } },
      ],
    },
    { reviews: [{ author: { login: 'alice' } }] },
  ]);
  const counts = parseThroughputCounts(raw);
  assert.equal(counts.get('alice'), 2);
  assert.equal(counts.get('bob'), 1);
});

test('parseThroughputCounts: ignores empty reviews / null entries', () => {
  const raw = JSON.stringify([
    { reviews: [] },
    { reviews: [{ author: null }] },
    null,
    { reviews: [{ author: { login: 'carol' } }] },
  ]);
  const counts = parseThroughputCounts(raw);
  assert.equal(counts.get('carol'), 1);
  assert.equal(counts.size, 1);
});

// ── median ────────────────────────────────────────────────────────────
test('median: odd-length picks the middle element', () => {
  assert.equal(median([1, 2, 3, 4, 5]), 3);
});

test('median: even-length averages the two middle elements', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('median: empty array -> NaN', () => {
  assert.ok(Number.isNaN(median([])));
});

// ── buildReviewerLoadStats ────────────────────────────────────────────
test('buildReviewerLoadStats: composes pending + throughput + median ack', () => {
  const out = buildReviewerLoadStats({
    handles: ['Alice', 'bob'],
    pendingByHandle: new Map([['alice', 3], ['bob', 1]]),
    ackSamplesByHandle: new Map([['alice', [4, 6, 8]], ['bob', [1]]]),
    throughputByHandle: new Map([['alice', 5], ['bob', 12]]),
  });
  assert.equal(out.length, 2);
  const alice = out.find(s => s.handle === 'alice')!;
  assert.equal(alice.pending, 3);
  assert.equal(alice.medianAckHours, 6);
  assert.equal(alice.recentThroughput, 5);
  assert.equal(alice.unknown, false);
});

test('buildReviewerLoadStats: handles with zero signal flagged unknown', () => {
  const out = buildReviewerLoadStats({
    handles: ['mystery'],
    pendingByHandle: new Map(),
    ackSamplesByHandle: new Map(),
    throughputByHandle: new Map(),
  });
  assert.equal(out[0].unknown, true);
});

test('buildReviewerLoadStats: handles with throughput only are NOT unknown', () => {
  const out = buildReviewerLoadStats({
    handles: ['alice'],
    pendingByHandle: new Map(),
    ackSamplesByHandle: new Map(),
    throughputByHandle: new Map([['alice', 7]]),
  });
  assert.equal(out[0].unknown, false);
  assert.equal(out[0].recentThroughput, 7);
});

test('buildReviewerLoadStats: handle normalisation (lowercase, strip @)', () => {
  const out = buildReviewerLoadStats({
    handles: ['@ALICE'],
    pendingByHandle: new Map([['alice', 2]]),
    ackSamplesByHandle: new Map(),
    throughputByHandle: new Map(),
  });
  assert.equal(out[0].handle, 'alice');
  assert.equal(out[0].pending, 2);
});

// ── describeLoadStats ─────────────────────────────────────────────────
test('describeLoadStats: unknown reviewer returns neutral string', () => {
  const s = stats('mystery', { unknown: true });
  assert.equal(describeLoadStats(s, scoreReviewerLoad(s)), 'no recent signal (neutral)');
});

test('describeLoadStats: formats hours/days/minutes for ack', () => {
  const s1 = stats('alice', { pending: 1, medianAckHours: 0.5, recentThroughput: 2 });
  assert.match(describeLoadStats(s1, scoreReviewerLoad(s1)), /30m ack/);
  const s2 = stats('alice', { pending: 1, medianAckHours: 30, recentThroughput: 2 });
  assert.match(describeLoadStats(s2, scoreReviewerLoad(s2)), /30h ack/);
  const s3 = stats('alice', { pending: 1, medianAckHours: 72, recentThroughput: 2 });
  assert.match(describeLoadStats(s3, scoreReviewerLoad(s3)), /3d ack/);
});

test('describeLoadStats: pluralises "review" correctly', () => {
  const s1 = stats('alice', { pending: 0, recentThroughput: 1 });
  assert.match(describeLoadStats(s1, scoreReviewerLoad(s1)), /1 recent review\b/);
  const s2 = stats('alice', { pending: 0, recentThroughput: 5 });
  assert.match(describeLoadStats(s2, scoreReviewerLoad(s2)), /5 recent reviews\b/);
});

// ── classifyVerdict ───────────────────────────────────────────────────
test('classifyVerdict: unknown is its own verdict', () => {
  const s = stats('mystery', { unknown: true });
  assert.equal(classifyVerdict(s, scoreReviewerLoad(s)), 'unknown');
});

test('classifyVerdict: negative score (high throughput) = fast', () => {
  const s = stats('alice', { pending: 0, recentThroughput: 10 });
  const verdict = classifyVerdict(s, scoreReviewerLoad(s));
  assert.equal(verdict, 'fast');
});

test('classifyVerdict: high queue + high score = busy', () => {
  const s = stats('alice', { pending: 6, recentThroughput: 0 });
  const verdict = classifyVerdict(s, scoreReviewerLoad(s));
  assert.equal(verdict, 'busy');
});

test('classifyVerdict: >= 48h median ack = slow', () => {
  const s = stats('alice', { pending: 1, medianAckHours: 72, recentThroughput: 1 });
  const verdict = classifyVerdict(s, scoreReviewerLoad(s));
  assert.equal(verdict, 'slow');
});

test('classifyVerdict: zero pending + zero throughput = neutral (not unknown)', () => {
  const s = stats('alice', { pending: 0, recentThroughput: 0, medianAckHours: 4 });
  const verdict = classifyVerdict(s, scoreReviewerLoad(s));
  assert.equal(verdict, 'neutral');
});

// ── buildLoadReport ───────────────────────────────────────────────────
test('buildLoadReport: produces a markdown table sorted by score ascending', () => {
  const s1 = stats('alice', { pending: 5 });
  const s2 = stats('bob', { pending: 1, recentThroughput: 3 });
  const scores = new Map<string, ReviewerLoadScore>([
    ['alice', scoreReviewerLoad(s1)],
    ['bob', scoreReviewerLoad(s2)],
  ]);
  const md = buildLoadReport({ stats: [s1, s2], scores, lookbackDays: 30 });
  assert.match(md, /^# Reviewer Load Report/m);
  assert.match(md, /2 reviewers - last 30 days/);
  const aliceIdx = md.indexOf('alice');
  const bobIdx = md.indexOf('bob');
  // Bob has lower score (less queue + more throughput) -> appears first.
  assert.ok(bobIdx < aliceIdx, 'lower-score reviewer should appear first');
});

test('buildLoadReport: empty stats produces a "no reviewers" stub', () => {
  const md = buildLoadReport({ stats: [], scores: new Map(), lookbackDays: 30 });
  assert.match(md, /No reviewer handles fed/);
});

test('buildLoadReport: dashes the median-ack column for unknown reviewers', () => {
  const s = stats('mystery', { unknown: true });
  const scores = new Map<string, ReviewerLoadScore>([['mystery', scoreReviewerLoad(s)]]);
  const md = buildLoadReport({ stats: [s], scores, lookbackDays: 14 });
  // ack column = '-' for unknown reviewers
  assert.match(md, /@mystery.*\| - \|/);
});

test('buildLoadReport: singular "day" word for lookback=1', () => {
  const md = buildLoadReport({ stats: [], scores: new Map(), lookbackDays: 1 });
  assert.match(md, /last 1 day_/);
});
