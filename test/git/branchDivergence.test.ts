import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDivergenceCounts,
  parseShortlog,
  describeDivergence,
  shouldNotify,
  DivergenceContext,
} from '../../src/git/branchDivergence';

test('parseDivergenceCounts: tab-separated behind/ahead', () => {
  assert.deepEqual(parseDivergenceCounts('4\t2\n'), { ahead: 2, behind: 4 });
  assert.deepEqual(parseDivergenceCounts('0\t0'), { ahead: 0, behind: 0 });
  assert.deepEqual(parseDivergenceCounts('12 7'), { ahead: 7, behind: 12 });
});

test('parseDivergenceCounts: malformed returns zero', () => {
  assert.deepEqual(parseDivergenceCounts(''), { ahead: 0, behind: 0 });
  assert.deepEqual(parseDivergenceCounts('garbage'), { ahead: 0, behind: 0 });
  assert.deepEqual(parseDivergenceCounts('5'), { ahead: 0, behind: 0 });
  // Negative numbers are nonsensical — clamped to 0.
  assert.deepEqual(parseDivergenceCounts('-3\t-1'), { ahead: 0, behind: 0 });
});

test('parseShortlog: sorts desc by count', () => {
  const out = parseShortlog([
    '    3\tCarol <c@c.com>',
    '   12\tAlice <a@a.com>',
    '    5\tBob <b@b.com>',
  ].join('\n'));
  assert.deepEqual(out.map(r => r.name), ['Alice', 'Bob', 'Carol']);
  assert.equal(out[0].commits, 12);
  assert.equal(out[1].email, 'b@b.com');
});

test('parseShortlog: handles names with spaces and emails with subdomains', () => {
  const out = parseShortlog([
    '    7\tAlice Q. Public <alice.public@dev.example.com>',
    '    2\tBob-O\'Brian <bob@e.com>',
  ].join('\n'));
  assert.equal(out[0].name, 'Alice Q. Public');
  assert.equal(out[0].email, 'alice.public@dev.example.com');
  assert.equal(out[1].name, "Bob-O'Brian");
});

test('parseShortlog: empty / malformed lines skipped', () => {
  assert.deepEqual(parseShortlog(''), []);
  assert.deepEqual(parseShortlog('garbage\n'), []);
});

test('describeDivergence: returns undefined when not behind', () => {
  const ctx: DivergenceContext = {
    branch: 'feature/x', upstream: 'origin/main',
    counts: { ahead: 2, behind: 0 },
    topContributors: [], contributorTotal: 0,
  };
  assert.equal(describeDivergence(ctx), undefined);
});

test('describeDivergence: behind-only sentence', () => {
  const ctx: DivergenceContext = {
    branch: 'feature/x', upstream: 'origin/main',
    counts: { ahead: 0, behind: 4 },
    topContributors: [{ name: 'Alice', email: 'a@a.com', commits: 3 }],
    contributorTotal: 1,
  };
  const msg = describeDivergence(ctx)!;
  assert.match(msg, /`feature\/x` is 4 commits behind `origin\/main`\./);
  assert.match(msg, /Top contributor: Alice\./);
  assert.doesNotMatch(msg, /ahead/);
});

test('describeDivergence: behind=1 uses singular "commit"', () => {
  const ctx: DivergenceContext = {
    branch: 'feature/x', upstream: 'origin/main',
    counts: { ahead: 0, behind: 1 },
    topContributors: [],
    contributorTotal: 0,
  };
  const msg = describeDivergence(ctx)!;
  assert.match(msg, /1 commit behind/);
  assert.doesNotMatch(msg, /1 commits/);
});

test('describeDivergence: ahead + behind appends conflict warning', () => {
  const ctx: DivergenceContext = {
    branch: 'feature/x', upstream: 'origin/main',
    counts: { ahead: 3, behind: 5 },
    topContributors: [
      { name: 'Alice', email: 'a@a.com', commits: 4 },
      { name: 'Bob', email: 'b@b.com', commits: 2 },
    ],
    contributorTotal: 2,
  };
  const msg = describeDivergence(ctx)!;
  assert.match(msg, /3 commits ahead/);
  assert.match(msg, /Top contributors: Alice, Bob\./);
});

test('describeDivergence: "+N others" when more than two contributors', () => {
  const ctx: DivergenceContext = {
    branch: 'feature/x', upstream: 'origin/main',
    counts: { ahead: 0, behind: 7 },
    topContributors: [
      { name: 'Alice', email: 'a@a.com', commits: 5 },
      { name: 'Bob', email: 'b@b.com', commits: 3 },
      { name: 'Carol', email: 'c@c.com', commits: 2 },
    ],
    contributorTotal: 5,
  };
  const msg = describeDivergence(ctx)!;
  assert.match(msg, /Top contributors: Alice, Bob \+3 others\./);
});

test('shouldNotify: false when no behind, true when behind', () => {
  const base: DivergenceContext = {
    branch: 'feature/x', upstream: 'origin/main',
    counts: { ahead: 0, behind: 0 },
    topContributors: [], contributorTotal: 0,
  };
  assert.equal(shouldNotify(base), false);
  assert.equal(shouldNotify({ ...base, counts: { ahead: 0, behind: 3 } }), true);
});

test('shouldNotify: refuses self-referential checkout', () => {
  const ctx: DivergenceContext = {
    branch: 'origin/main', upstream: 'origin/main',
    counts: { ahead: 0, behind: 5 },
    topContributors: [], contributorTotal: 0,
  };
  assert.equal(shouldNotify(ctx), false);
});
