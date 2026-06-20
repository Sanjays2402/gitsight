import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseLeftRightCount,
  parseShortStat,
  parseShortlog,
  summariseCompare,
  formatCompareMarkdown,
  BranchCompareSummary,
} from '../../src/git/branchCompare';

test('parseLeftRightCount: TAB-separated behind / ahead', () => {
  assert.deepEqual(parseLeftRightCount('3\t7\n'), { behind: 3, ahead: 7 });
  assert.deepEqual(parseLeftRightCount('0 0'), { behind: 0, ahead: 0 });
  assert.deepEqual(parseLeftRightCount(''), { ahead: 0, behind: 0 });
});

test('parseLeftRightCount: malformed input → zeros', () => {
  assert.deepEqual(parseLeftRightCount('foo'), { ahead: 0, behind: 0 });
});

test('parseShortStat: pulls files / insertions / deletions', () => {
  assert.deepEqual(
    parseShortStat(' 12 files changed, 345 insertions(+), 67 deletions(-)'),
    { filesChanged: 12, insertions: 345, deletions: 67 },
  );
  assert.deepEqual(
    parseShortStat(' 1 file changed, 1 insertion(+)'),
    { filesChanged: 1, insertions: 1, deletions: 0 },
  );
});

test('parseShortStat: empty → zeros', () => {
  assert.deepEqual(parseShortStat(''), { filesChanged: 0, insertions: 0, deletions: 0 });
});

test('parseShortlog: parses rows and sorts desc by commit count', () => {
  const out = [
    '     5  Bob <bob@example.com>',
    '    10  Alice <alice@example.com>',
    '     1  Carol <carol@example.com>',
  ].join('\n');
  const rows = parseShortlog(out);
  assert.deepEqual(rows.map(r => r.name), ['Alice', 'Bob', 'Carol']);
  assert.deepEqual(rows.map(r => r.commits), [10, 5, 1]);
});

test('parseShortlog: ignores blank / malformed lines', () => {
  const out = 'garbage\n    7  X <x@y>\n\n';
  assert.deepEqual(parseShortlog(out), [{ name: 'X', email: 'x@y', commits: 7 }]);
});

const sample: BranchCompareSummary = {
  base: 'main',
  head: 'feature/x',
  counts: { ahead: 7, behind: 2 },
  diff: { filesChanged: 12, insertions: 345, deletions: 67 },
  topContributors: [
    { name: 'Alice', email: 'a@x', commits: 5 },
    { name: 'Bob',   email: 'b@x', commits: 1 },
    { name: 'Carol', email: 'c@x', commits: 1 },
  ],
  contributorTotal: 5,
};

test('summariseCompare: one-line summary includes counts, diff, top contributors, +others', () => {
  const line = summariseCompare(sample);
  assert.match(line, /feature\/x vs main/);
  assert.match(line, /7 ahead/);
  assert.match(line, /2 behind/);
  assert.match(line, /12 files/);
  assert.match(line, /\+345\/-67/);
  assert.match(line, /Alice, Bob \+3 others/);
});

test('summariseCompare: no extras → no "+others"', () => {
  const line = summariseCompare({ ...sample, contributorTotal: 2 });
  assert.match(line, /Alice, Bob/);
  assert.doesNotMatch(line, /\+\d+ others/);
});

test('formatCompareMarkdown: lists every shown contributor and notes leftovers', () => {
  const md = formatCompareMarkdown(sample);
  assert.match(md, /## feature\/x vs main/);
  assert.match(md, /- \*\*7\*\* commits ahead/);
  assert.match(md, /Alice <a@x> — 5 commits/);
  assert.match(md, /… and 2 more/);
});
