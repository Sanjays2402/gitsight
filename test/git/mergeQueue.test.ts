import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseMergeQueueEntry,
  estimateMergeMinutes,
  formatQueueLabel,
  describeQueueState,
  glyphForQueueState,
} from '../../src/git/mergeQueue';

test('parseMergeQueueEntry: missing entry returns state none + hasEntry false', () => {
  const out = parseMergeQueueEntry(JSON.stringify({ mergeStateStatus: 'CLEAN' }));
  assert.equal(out.state, 'none');
  assert.equal(out.hasEntry, false);
});

test('parseMergeQueueEntry: QUEUED entry maps to state queued', () => {
  const raw = JSON.stringify({
    mergeQueueEntry: { state: 'QUEUED', position: 3, enqueuedAt: '2026-06-22T20:00:00Z' },
  });
  const out = parseMergeQueueEntry(raw);
  assert.equal(out.state, 'queued');
  assert.equal(out.position, 3);
  assert.equal(out.enqueuedAt, '2026-06-22T20:00:00Z');
  assert.equal(out.hasEntry, true);
});

test('parseMergeQueueEntry: AWAITING_CHECKS maps to state processing', () => {
  const raw = JSON.stringify({ mergeQueueEntry: { state: 'AWAITING_CHECKS', position: 1 } });
  const out = parseMergeQueueEntry(raw);
  assert.equal(out.state, 'processing');
});

test('parseMergeQueueEntry: PROCESSING and TESTING both map to processing', () => {
  for (const s of ['PROCESSING', 'TESTING']) {
    const raw = JSON.stringify({ mergeQueueEntry: { state: s } });
    assert.equal(parseMergeQueueEntry(raw).state, 'processing', `state=${s}`);
  }
});

test('parseMergeQueueEntry: LOCKED / UNMERGEABLE both map to blocked', () => {
  for (const s of ['LOCKED', 'UNMERGEABLE']) {
    const raw = JSON.stringify({ mergeQueueEntry: { state: s } });
    assert.equal(parseMergeQueueEntry(raw).state, 'blocked', `state=${s}`);
  }
});

test('parseMergeQueueEntry: MERGED + DEQUEUED states', () => {
  assert.equal(parseMergeQueueEntry(JSON.stringify({ mergeQueueEntry: { state: 'MERGED' } })).state, 'merged');
  assert.equal(
    parseMergeQueueEntry(JSON.stringify({ mergeQueueEntry: { state: 'DEQUEUED', dequeueReason: 'failed required check' } })).state,
    'dequeued',
  );
});

test('parseMergeQueueEntry: unknown state defaults to queued (most graceful)', () => {
  const raw = JSON.stringify({ mergeQueueEntry: { state: 'FOO_BAR' } });
  assert.equal(parseMergeQueueEntry(raw).state, 'queued');
});

test('parseMergeQueueEntry: invalid JSON returns none safely', () => {
  assert.equal(parseMergeQueueEntry('').state, 'none');
  assert.equal(parseMergeQueueEntry('not json').state, 'none');
  assert.equal(parseMergeQueueEntry('null').state, 'none');
  assert.equal(parseMergeQueueEntry('[]').state, 'none');
});

test('parseMergeQueueEntry: position 0 / negative returns undefined', () => {
  const r1 = parseMergeQueueEntry(JSON.stringify({ mergeQueueEntry: { state: 'QUEUED', position: 0 } }));
  assert.equal(r1.position, undefined);
  const r2 = parseMergeQueueEntry(JSON.stringify({ mergeQueueEntry: { state: 'QUEUED', position: -1 } }));
  assert.equal(r2.position, undefined);
});

test('parseMergeQueueEntry: dequeueReason surfaces when present', () => {
  const out = parseMergeQueueEntry(JSON.stringify({
    mergeQueueEntry: { state: 'DEQUEUED', dequeueReason: 'CI failed' },
  }));
  assert.equal(out.dequeueReason, 'CI failed');
});

test('parseMergeQueueEntry: queueLength alternate totalEntries shape parsed', () => {
  const out = parseMergeQueueEntry(JSON.stringify({
    mergeQueueEntry: { state: 'QUEUED', position: 5, totalEntries: 12 },
  }));
  assert.equal(out.queueLength, 12);
});

test('estimateMergeMinutes: none / merged / blocked return undefined', () => {
  for (const state of ['none', 'merged', 'blocked', 'dequeued'] as const) {
    const eta = estimateMergeMinutes({ state, hasEntry: state !== 'none' });
    assert.equal(eta, undefined, `state=${state}`);
  }
});

test('estimateMergeMinutes: processing returns floor or half-average (whichever is higher)', () => {
  const eta = estimateMergeMinutes({ state: 'processing', hasEntry: true }, { averageMinutesPerPr: 10 });
  assert.equal(eta, 5);
});

test('estimateMergeMinutes: queued multiplies position by average minutes', () => {
  const eta = estimateMergeMinutes(
    { state: 'queued', position: 4, hasEntry: true },
    { averageMinutesPerPr: 5 },
  );
  assert.equal(eta, 20);
});

test('estimateMergeMinutes: queued without position returns undefined', () => {
  assert.equal(estimateMergeMinutes({ state: 'queued', hasEntry: true }), undefined);
});

test('estimateMergeMinutes: respects floor for tiny positions', () => {
  const eta = estimateMergeMinutes(
    { state: 'queued', position: 1, hasEntry: true },
    { averageMinutesPerPr: 1, floorMinutes: 3 },
  );
  assert.equal(eta, 3);
});

test('formatQueueLabel: none state returns undefined', () => {
  assert.equal(formatQueueLabel({ state: 'none', hasEntry: false }), undefined);
});

test('formatQueueLabel: queued with position renders "#N (~Tm)"', () => {
  const lbl = formatQueueLabel(
    { state: 'queued', position: 2, hasEntry: true },
    { averageMinutesPerPr: 6 },
  );
  assert.equal(lbl, 'queue #2 (~12m)');
});

test('formatQueueLabel: queued without position renders "queue waiting"', () => {
  const lbl = formatQueueLabel({ state: 'queued', hasEntry: true });
  assert.equal(lbl, 'queue waiting');
});

test('formatQueueLabel: processing with eta', () => {
  const lbl = formatQueueLabel({ state: 'processing', hasEntry: true }, { averageMinutesPerPr: 6 });
  assert.equal(lbl, 'queue checking ~3m');
});

test('formatQueueLabel: blocked / merged / dequeued have stable labels', () => {
  assert.equal(formatQueueLabel({ state: 'blocked', hasEntry: true }), 'queue blocked');
  assert.equal(formatQueueLabel({ state: 'merged', hasEntry: true }), 'queue merged');
  assert.equal(formatQueueLabel({ state: 'dequeued', hasEntry: true }), 'queue dequeued');
});

test('describeQueueState: queued shows position + eta + enqueuedAt', () => {
  const md = describeQueueState({ state: 'queued', position: 5, queueLength: 10, enqueuedAt: '2026-06-22T20:00:00Z', hasEntry: true }, { averageMinutesPerPr: 6 });
  assert.match(md, /Position: 5 of 10/);
  assert.match(md, /ETA: ~30 min/);
  assert.match(md, /Enqueued at: 2026-06-22T20:00:00Z/);
});

test('describeQueueState: dequeued surfaces reason', () => {
  const md = describeQueueState({ state: 'dequeued', dequeueReason: 'failed required check', hasEntry: true });
  assert.match(md, /dequeued/);
  assert.match(md, /Dequeue reason: failed required check/);
});

test('describeQueueState: none state notes "not in queue"', () => {
  const md = describeQueueState({ state: 'none', hasEntry: false });
  assert.match(md, /not in queue/);
});

test('glyphForQueueState codicon glyph per state (no emoji)', () => {
  assert.equal(glyphForQueueState('queued'), 'list-ordered');
  assert.equal(glyphForQueueState('processing'), 'sync');
  assert.equal(glyphForQueueState('blocked'), 'warning');
  assert.equal(glyphForQueueState('merged'), 'git-merge');
  assert.equal(glyphForQueueState('dequeued'), 'circle-slash');
  assert.equal(glyphForQueueState('none'), 'circle-outline');
});

test('estimateMergeMinutes: averageMinutesPerPr <= 0 is clamped to 1', () => {
  const eta = estimateMergeMinutes(
    { state: 'queued', position: 4, hasEntry: true },
    { averageMinutesPerPr: 0, floorMinutes: 0 },
  );
  // avg = max(1, 0) = 1; 1 * 4 = 4
  assert.equal(eta, 4);
});

test('parseMergeQueueEntry: enqueuedAt non-string ignored', () => {
  const out = parseMergeQueueEntry(JSON.stringify({
    mergeQueueEntry: { state: 'QUEUED', position: 1, enqueuedAt: 12345 },
  }));
  assert.equal(out.enqueuedAt, undefined);
});
