import test from 'node:test';
import { strict as assert } from 'node:assert';
import { buildContributors, sharePercent } from '../../src/shared/contributors';

const COMMITS = [
  { author: 'Ada Lovelace', email: 'Ada@Example.com', date: '2026-06-10T09:00:00Z' },
  { author: 'Ada Lovelace', email: 'ada@example.com', date: '2026-06-12T09:00:00Z' },
  { author: 'Grace Hopper', email: 'grace@example.com', date: '2026-06-01T09:00:00Z' },
  { author: 'Ada L.', email: 'ada@example.com', date: '2026-06-20T09:00:00Z' }, // newest -> name wins
];

test('buildContributors groups by lowercased email and counts commits', () => {
  const stats = buildContributors(COMMITS);
  assert.equal(stats.totalCommits, 4);
  assert.equal(stats.totalAuthors, 2);
  const ada = stats.contributors[0];
  assert.equal(ada.email, 'ada@example.com');
  assert.equal(ada.commits, 3);
});

test('buildContributors uses the most-recent commit name for an author', () => {
  const stats = buildContributors(COMMITS);
  const ada = stats.contributors.find(c => c.email === 'ada@example.com');
  assert.ok(ada);
  // Newest commit (Jun 20) spelled the name "Ada L." -> that wins.
  assert.equal(ada.name, 'Ada L.');
  assert.equal(ada.firstDate, '2026-06-10T09:00:00Z');
  assert.equal(ada.lastDate, '2026-06-20T09:00:00Z');
});

test('buildContributors sorts by commit count desc then name', () => {
  const stats = buildContributors(COMMITS);
  assert.equal(stats.contributors[0].commits, 3);
  assert.equal(stats.contributors[1].commits, 1);
  assert.equal(stats.contributors[1].name, 'Grace Hopper');
});

test('buildContributors shares sum to ~1', () => {
  const stats = buildContributors(COMMITS);
  const sum = stats.contributors.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('sharePercent rounds to a whole percent', () => {
  const stats = buildContributors(COMMITS);
  const ada = stats.contributors.find(c => c.email === 'ada@example.com')!;
  assert.equal(sharePercent(ada), 75);
});

test('buildContributors falls back to author name when email is blank', () => {
  const stats = buildContributors([
    { author: 'Anon', email: '', date: '2026-06-01T09:00:00Z' },
    { author: 'Anon', email: '', date: '2026-06-02T09:00:00Z' },
  ]);
  assert.equal(stats.totalAuthors, 1);
  assert.equal(stats.contributors[0].commits, 2);
  assert.equal(stats.contributors[0].email, 'anon');
});

test('buildContributors handles an empty list', () => {
  const stats = buildContributors([]);
  assert.deepEqual(stats.contributors, []);
  assert.equal(stats.totalCommits, 0);
});
