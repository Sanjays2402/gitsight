import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  dayKey,
  activityLevel,
  buildActivityCalendar,
} from '../../src/shared/activity';

// ── dayKey ───────────────────────────────────────────────────────────

test('dayKey extracts the calendar day from an ISO string', () => {
  assert.equal(dayKey('2026-06-25T10:23:59-07:00'), '2026-06-25');
  assert.equal(dayKey('2026-01-02T00:00:00Z'), '2026-01-02');
});

test('dayKey rejects malformed input', () => {
  assert.equal(dayKey(''), null);
  assert.equal(dayKey('nope'), null);
  assert.equal(dayKey('2026/06/25'), null);
});

// ── activityLevel ────────────────────────────────────────────────────

test('activityLevel buckets counts into 0..4 relative to max', () => {
  assert.equal(activityLevel(0, 8), 0);
  assert.equal(activityLevel(1, 8), 1); // 0.125 -> level 1
  assert.equal(activityLevel(2, 8), 2); // 0.25 -> level 2 (boundary)
  assert.equal(activityLevel(3, 8), 2); // 0.375 -> level 2
  assert.equal(activityLevel(4, 8), 3); // 0.5
  assert.equal(activityLevel(6, 8), 4); // 0.75
  assert.equal(activityLevel(8, 8), 4);
});

test('activityLevel handles a max of 1 (every active day is level 4)', () => {
  assert.equal(activityLevel(1, 1), 4);
  assert.equal(activityLevel(0, 1), 0);
});

// ── buildActivityCalendar ────────────────────────────────────────────

test('buildActivityCalendar returns an empty calendar for no commits', () => {
  const cal = buildActivityCalendar([]);
  assert.deepEqual(cal.weeks, []);
  assert.equal(cal.total, 0);
  assert.equal(cal.first, null);
  assert.equal(cal.last, null);
});

test('buildActivityCalendar aggregates commits per day and aligns to weeks', () => {
  const commits = [
    { date: '2026-06-01T09:00:00Z' }, // Monday
    { date: '2026-06-01T18:00:00Z' },
    { date: '2026-06-03T09:00:00Z' },
    { date: '2026-06-10T09:00:00Z' },
  ];
  const cal = buildActivityCalendar(commits);
  assert.equal(cal.total, 4);
  assert.equal(cal.activeDays, 3);
  assert.equal(cal.max, 2); // Jun 1 had two commits
  assert.equal(cal.first, '2026-06-01');
  assert.equal(cal.last, '2026-06-10');
  // Every week column is exactly 7 days tall.
  for (const week of cal.weeks) assert.equal(week.length, 7);
  // The grid starts on a Sunday (row 0 of the first week).
  const firstCell = cal.weeks[0][0];
  assert.equal(new Date(`${firstCell.date}T00:00:00Z`).getUTCDay(), 0);
  // Jun 1 cell carries count 2.
  const flat = cal.weeks.flat();
  const jun1 = flat.find(d => d.date === '2026-06-01');
  assert.ok(jun1);
  assert.equal(jun1.count, 2);
  assert.equal(jun1.level, 4);
});

test('buildActivityCalendar trims to the most recent maxWeeks', () => {
  // Two commits ~1 year apart -> >53 weeks of span, trimmed to 4.
  const cal = buildActivityCalendar(
    [{ date: '2025-01-01T09:00:00Z' }, { date: '2026-01-01T09:00:00Z' }],
    { maxWeeks: 4 },
  );
  assert.equal(cal.weeks.length, 4);
  // The trimmed window keeps the latest day.
  const last = cal.weeks.flat().some(d => d.date === '2026-01-01');
  assert.equal(last, true);
});

test('buildActivityCalendar emits month labels in column order', () => {
  const cal = buildActivityCalendar([
    { date: '2026-05-20T09:00:00Z' },
    { date: '2026-06-25T09:00:00Z' },
  ]);
  const labels = cal.months.map(m => m.label);
  assert.ok(labels.includes('May'));
  assert.ok(labels.includes('Jun'));
  // weekIndex is non-decreasing.
  for (let i = 1; i < cal.months.length; i++) {
    assert.ok(cal.months[i].weekIndex >= cal.months[i - 1].weekIndex);
  }
});
