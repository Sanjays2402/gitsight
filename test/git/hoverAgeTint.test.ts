import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyHoverAge,
  hoverTintColor,
  hoverAgeLabel,
  escapeForHtmlSpan,
  tintSpan,
  resolveThresholds,
  DEFAULT_HOVER_AGE_THRESHOLDS,
} from '../../src/git/hoverAgeTint';

const NOW = new Date('2026-06-21T00:00:00Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

test('classifyHoverAge: fresh by default for recent dates', () => {
  assert.equal(classifyHoverAge(daysAgo(0), NOW), 'fresh');
  assert.equal(classifyHoverAge(daysAgo(1), NOW), 'fresh');
  assert.equal(classifyHoverAge(daysAgo(29), NOW), 'fresh');
});

test('classifyHoverAge: aging at default agingDays = 30', () => {
  assert.equal(classifyHoverAge(daysAgo(30), NOW), 'aging');
  assert.equal(classifyHoverAge(daysAgo(120), NOW), 'aging');
  assert.equal(classifyHoverAge(daysAgo(179), NOW), 'aging');
});

test('classifyHoverAge: stale at default staleDays = 180', () => {
  assert.equal(classifyHoverAge(daysAgo(180), NOW), 'stale');
  assert.equal(classifyHoverAge(daysAgo(400), NOW), 'stale');
  assert.equal(classifyHoverAge(daysAgo(719), NOW), 'stale');
});

test('classifyHoverAge: ancient at default ancientDays = 720', () => {
  assert.equal(classifyHoverAge(daysAgo(720), NOW), 'ancient');
  assert.equal(classifyHoverAge(daysAgo(2000), NOW), 'ancient');
});

test('classifyHoverAge: future dates are treated as fresh (clock skew)', () => {
  const future = new Date(NOW.getTime() + 86_400_000);
  assert.equal(classifyHoverAge(future, NOW), 'fresh');
});

test('classifyHoverAge: undefined / NaN date → ancient', () => {
  assert.equal(classifyHoverAge(undefined, NOW), 'ancient');
  assert.equal(classifyHoverAge(new Date(NaN), NOW), 'ancient');
});

test('classifyHoverAge: respects custom thresholds', () => {
  const t = { agingDays: 7, staleDays: 30, ancientDays: 90 };
  assert.equal(classifyHoverAge(daysAgo(6), NOW, t), 'fresh');
  assert.equal(classifyHoverAge(daysAgo(7), NOW, t), 'aging');
  assert.equal(classifyHoverAge(daysAgo(30), NOW, t), 'stale');
  assert.equal(classifyHoverAge(daysAgo(90), NOW, t), 'ancient');
});

test('hoverTintColor: stable hex codes per bucket', () => {
  assert.equal(hoverTintColor('fresh'), '#22c55e');
  assert.equal(hoverTintColor('aging'), '#eab308');
  assert.equal(hoverTintColor('stale'), '#f97316');
  assert.equal(hoverTintColor('ancient'), '#ef4444');
});

test('hoverAgeLabel: format includes bucket + day count', () => {
  assert.equal(hoverAgeLabel('aging', daysAgo(45), NOW), 'aging · 45d');
  assert.equal(hoverAgeLabel('stale', daysAgo(200), NOW), 'stale · 200d');
  assert.equal(hoverAgeLabel('ancient', undefined, NOW), 'ancient');
});

test('escapeForHtmlSpan: blocks closing tag injection from commit authors', () => {
  const evil = `Sanjay</span><script>alert('xss')</script>`;
  const safe = escapeForHtmlSpan(evil);
  assert.ok(!safe.includes('</span>'));
  assert.ok(!safe.includes('<script>'));
  assert.ok(safe.includes('&lt;'));
});

test('escapeForHtmlSpan: idempotent on plain text', () => {
  assert.equal(escapeForHtmlSpan('Sanjay Subramanian'), 'Sanjay Subramanian');
});

test('tintSpan: wraps escaped text in a coloured span', () => {
  assert.equal(tintSpan('aging', 'Sanjay'), '<span style="color:#eab308">Sanjay</span>');
});

test('tintSpan: escapes evil author names', () => {
  const out = tintSpan('stale', `<b>Pwn</b>`);
  assert.ok(out.startsWith('<span style="color:#f97316">'));
  assert.ok(out.endsWith('</span>'));
  assert.ok(out.includes('&lt;b&gt;Pwn&lt;/b&gt;'));
});

test('resolveThresholds: returns defaults when nothing supplied', () => {
  const t = resolveThresholds({});
  assert.deepEqual(t, DEFAULT_HOVER_AGE_THRESHOLDS);
});

test('resolveThresholds: enforces monotonic increase', () => {
  const t = resolveThresholds({ agingDays: 100, staleDays: 50, ancientDays: 20 });
  assert.ok(t.agingDays === 100);
  assert.ok(t.staleDays > t.agingDays);
  assert.ok(t.ancientDays > t.staleDays);
});

test('resolveThresholds: clamps absurd values', () => {
  const t = resolveThresholds({ agingDays: -5, staleDays: 999999, ancientDays: NaN });
  // -5 clamps to 1
  assert.equal(t.agingDays, 1);
  // 999999 clamps to 36500
  assert.equal(t.staleDays, 36500);
  // NaN falls back to default but must remain > stale; since stale hit cap, ancient still > stale
  assert.ok(t.ancientDays > t.staleDays);
});

test('resolveThresholds: non-finite numeric values fall through to defaults then monotonic clamp', () => {
  const t = resolveThresholds({ agingDays: Infinity, staleDays: -1 });
  // Infinity rejected → default aging (30). -1 clamps to 1, but 1 <= 30 → forced to 31.
  assert.equal(t.agingDays, 30);
  assert.equal(t.staleDays, 31);
  // ancient defaults to 720 which is > 31, keep it.
  assert.equal(t.ancientDays, 720);
});
