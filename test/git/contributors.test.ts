import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildContributors,
  sharePercent,
  parseChurnByEmail,
  applyChurn,
  sortContributors,
  contributorChurn,
  isContributorSort,
  contributorSortKeyAction,
  churnShare,
  maxContributorChurn,
} from '../../src/shared/contributors';

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

// ── Churn aggregate + sort (W60) ─────────────────────────────────────

test('buildContributors seeds zero churn until folded', () => {
  const stats = buildContributors(COMMITS);
  assert.ok(stats.contributors.every(c => c.insertions === 0 && c.deletions === 0));
});

test('parseChurnByEmail folds numstat by lowercased email', () => {
  const RECORD = '\x1e';
  const stdout =
    `${RECORD}Ada@Example.com\n` +
    `10\t2\tsrc/a.ts\n` +
    `5\t0\tsrc/b.ts\n` +
    `${RECORD}grace@example.com\n` +
    `3\t3\tsrc/c.ts`;
  const churn = parseChurnByEmail(stdout);
  assert.equal(churn.get('ada@example.com')?.insertions, 15);
  assert.equal(churn.get('ada@example.com')?.deletions, 2);
  assert.equal(churn.get('grace@example.com')?.insertions, 3);
  assert.equal(churn.get('grace@example.com')?.deletions, 3);
});

test('parseChurnByEmail ignores binary rows', () => {
  const stdout = `\x1ebob@x.com\n-\t-\tassets/logo.png\n4\t1\tsrc/d.ts`;
  const churn = parseChurnByEmail(stdout);
  assert.equal(churn.get('bob@x.com')?.insertions, 4);
  assert.equal(churn.get('bob@x.com')?.deletions, 1);
});

test('parseChurnByEmail tolerates empty input', () => {
  assert.equal(parseChurnByEmail('').size, 0);
});

test('applyChurn merges totals without mutating the input', () => {
  const stats = buildContributors(COMMITS);
  const churn = new Map([['ada@example.com', { insertions: 40, deletions: 8 }]]);
  const merged = applyChurn(stats.contributors, churn);
  const ada = merged.find(c => c.email === 'ada@example.com')!;
  assert.equal(ada.insertions, 40);
  assert.equal(ada.deletions, 8);
  // Grace has no churn entry -> stays zero.
  const grace = merged.find(c => c.email === 'grace@example.com')!;
  assert.equal(grace.insertions, 0);
  // The original list is untouched.
  assert.equal(stats.contributors.find(c => c.email === 'ada@example.com')!.insertions, 0);
});

test('contributorChurn sums insertions + deletions, clamping negatives', () => {
  assert.equal(contributorChurn({ insertions: 10, deletions: 4 }), 14);
  assert.equal(contributorChurn({ insertions: -1, deletions: 3 }), 3);
});

test('sortContributors by churn ranks the busiest author first', () => {
  const stats = buildContributors(COMMITS);
  const merged = applyChurn(
    stats.contributors,
    new Map([
      ['ada@example.com', { insertions: 5, deletions: 1 }],
      ['grace@example.com', { insertions: 100, deletions: 0 }],
    ]),
  );
  const sorted = sortContributors(merged, 'churn');
  assert.equal(sorted[0].email, 'grace@example.com');
  assert.equal(sorted[1].email, 'ada@example.com');
});

test('sortContributors by recent ranks the latest lastDate first', () => {
  const stats = buildContributors(COMMITS);
  // Ada's last commit (Jun 20) is newer than Grace's (Jun 01).
  const sorted = sortContributors(stats.contributors, 'recent');
  assert.equal(sorted[0].email, 'ada@example.com');
});

test('sortContributors by name is alphabetical and does not mutate', () => {
  const stats = buildContributors(COMMITS);
  const before = stats.contributors.slice();
  const sorted = sortContributors(stats.contributors, 'name');
  assert.deepEqual(sorted.map(c => c.name), ['Ada L.', 'Grace Hopper']);
  assert.deepEqual(stats.contributors, before);
});

test('sortContributors by commits matches the default leaderboard order', () => {
  const stats = buildContributors(COMMITS);
  const sorted = sortContributors(stats.contributors, 'commits');
  assert.deepEqual(sorted.map(c => c.commits), [3, 1]);
});

test('isContributorSort guards the key set', () => {
  assert.ok(isContributorSort('churn'));
  assert.ok(isContributorSort('recent'));
  assert.ok(!isContributorSort('downloads'));
  assert.ok(!isContributorSort(42));
});

test('contributorSortKeyAction maps n/c/r/m to sorts, ignores others (W122)', () => {
  assert.equal(contributorSortKeyAction('n'), 'name');
  assert.equal(contributorSortKeyAction('c'), 'commits');
  assert.equal(contributorSortKeyAction('r'), 'recent');
  assert.equal(contributorSortKeyAction('m'), 'churn');
  // Uppercase mirrors lowercase.
  assert.equal(contributorSortKeyAction('M'), 'churn');
  assert.equal(contributorSortKeyAction('x'), null);
  assert.equal(contributorSortKeyAction('Enter'), null);
  // Every mapped key is a real sort key (round-trips the guard).
  for (const k of ['n', 'c', 'r', 'm']) assert.ok(isContributorSort(contributorSortKeyAction(k)));
});

// ── Churn bars (W67) ─────────────────────────────────────────────────

test('maxContributorChurn returns the busiest author total, 0 when empty', () => {
  const list = [
    { insertions: 5, deletions: 1 }, // 6
    { insertions: 100, deletions: 20 }, // 120
    { insertions: 0, deletions: 0 }, // 0
  ];
  assert.equal(maxContributorChurn(list), 120);
  assert.equal(maxContributorChurn([]), 0);
});

test('churnShare is the 0..1 fraction of the busiest author', () => {
  const max = 120;
  assert.equal(churnShare({ insertions: 100, deletions: 20 }, max), 1); // the busiest fills
  assert.equal(churnShare({ insertions: 30, deletions: 30 }, max), 0.5); // half
  assert.equal(churnShare({ insertions: 0, deletions: 0 }, max), 0); // none
});

test('churnShare collapses to 0 on a non-positive max (no churn folded)', () => {
  assert.equal(churnShare({ insertions: 0, deletions: 0 }, 0), 0);
  assert.equal(churnShare({ insertions: 5, deletions: 5 }, 0), 0);
  assert.equal(churnShare({ insertions: 5, deletions: 5 }, -3), 0);
});

test('churnShare clamps to 0..1 and ignores negative (binary -1) counts', () => {
  // A churn larger than max (shouldn't happen, but defensive) clamps to 1.
  assert.equal(churnShare({ insertions: 200, deletions: 0 }, 100), 1);
  // Negative counts (binary rows folded as -1) floor to 0 via contributorChurn.
  assert.equal(churnShare({ insertions: -1, deletions: -1 }, 100), 0);
});
