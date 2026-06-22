import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { timeAgo, formatBlame, colorForAuthor, heatmapColor, gravatarUrl } from '../../src/git/format';

test('timeAgo: seconds / minutes / hours / days', () => {
  const now = Date.now();
  assert.equal(timeAgo(new Date(now - 5_000)), '5s ago');
  assert.equal(timeAgo(new Date(now - 5 * 60_000)), '5m ago');
  assert.equal(timeAgo(new Date(now - 3 * 3_600_000)), '3h ago');
  assert.equal(timeAgo(new Date(now - 5 * 86_400_000)), '5d ago');
});

test('timeAgo: months and years', () => {
  const now = Date.now();
  assert.equal(timeAgo(new Date(now - 60 * 86_400_000)), '2mo ago');
  assert.equal(timeAgo(new Date(now - 365 * 2 * 86_400_000)), '2y ago');
});

test('formatBlame: substitutes all tokens', () => {
  const out = formatBlame('${author}, ${ago} • ${message} [${sha}] @ ${date}', {
    author: 'cake',
    ago: '3h ago',
    date: '2025-01-01',
    sha: 'abc1234',
    message: 'fix things',
  });
  assert.equal(out, 'cake, 3h ago • fix things [abc1234] @ 2025-01-01');
});

test('formatBlame: tokens repeat correctly', () => {
  const out = formatBlame('${author}/${author}', {
    author: 'cake', ago: '', date: '', sha: '', message: '',
  });
  assert.equal(out, 'cake/cake');
});

test('colorForAuthor: deterministic, hsl format', () => {
  const a = colorForAuthor('alice');
  const b = colorForAuthor('alice');
  assert.equal(a, b);
  assert.match(a, /^hsl\(\d+, 65%, 60%\)$/);
  assert.notEqual(colorForAuthor('alice'), colorForAuthor('bob'));
});

test('heatmapColor: hot (red) at 0 days, cold (blue) near coldDays', () => {
  const hot = heatmapColor(new Date(), 365);
  const cold = heatmapColor(new Date(Date.now() - 365 * 86_400_000), 365);
  // Hot side: hue is 220 * ratio where ratio ≈ 0; tolerate scientific notation
  // (e.g. "6.97e-9") that JS Number.toString emits for very small values.
  assert.match(hot, /^hsl\(0(?:\.\d+(?:e-?\d+)?)?, 70%, 50%\)$/);
  assert.match(cold, /^hsl\(220(?:\.\d+(?:e[+-]?\d+)?)?, 70%, 50%\)$/);
});

test('heatmapColor: clamps very-old dates to fully cold', () => {
  const ancient = heatmapColor(new Date(0), 365);
  assert.match(ancient, /^hsl\(220(?:\.\d+(?:e[+-]?\d+)?)?, 70%, 50%\)$/);
});

test('gravatarUrl: hashes lowercase email, supports size', () => {
  const a = gravatarUrl('Cake@Example.com', 64);
  const b = gravatarUrl('cake@example.com', 64);
  assert.equal(a, b);
  assert.match(a, /^https:\/\/www\.gravatar\.com\/avatar\/[a-f0-9]{32}\?s=64&d=identicon$/);
});
