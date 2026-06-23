import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffTestImpact,
  diffTestImpactBlocks,
  parseRowsFromBlock,
  summariseDiffHeadline,
  shouldPostDeltaComment,
  buildDeltaCommentBody,
} from '../../src/git/testImpactPrBodyDelta';
import { TestImpactSummary, TestImpactRow } from '../../src/git/testImpact';

function row(testFile: string, score: number, sourceFiles: string[] = []): TestImpactRow {
  return { testFile, score, sourceFiles, signals: ['import'] };
}

function sum(rows: TestImpactRow[], opts: Partial<TestImpactSummary> = {}): TestImpactSummary {
  return {
    rows,
    consideredSources: opts.consideredSources ?? rows.length,
    coveredSources: opts.coveredSources ?? rows.length,
    orphanSources: opts.orphanSources ?? [],
  };
}

test('diffTestImpact: pure-additions', () => {
  const oldSummary = sum([row('a.test.ts', 10)]);
  const newSummary = sum([row('a.test.ts', 10), row('b.test.ts', 8)]);
  const d = diffTestImpact(oldSummary, newSummary);
  assert.deepEqual(d.added.map(x => x.testFile), ['b.test.ts']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.rescored, []);
  assert.deepEqual(d.unchanged.map(x => x.testFile), ['a.test.ts']);
});

test('diffTestImpact: pure-removals', () => {
  const oldSummary = sum([row('a.test.ts', 10), row('b.test.ts', 8)]);
  const newSummary = sum([row('a.test.ts', 10)]);
  const d = diffTestImpact(oldSummary, newSummary);
  assert.deepEqual(d.removed.map(x => x.testFile), ['b.test.ts']);
  assert.equal(d.removed[0].oldScore, 8);
  assert.equal(d.removed[0].scoreDelta, -8);
});

test('diffTestImpact: rescored row', () => {
  const oldSummary = sum([row('a.test.ts', 10)]);
  const newSummary = sum([row('a.test.ts', 14)]);
  const d = diffTestImpact(oldSummary, newSummary);
  assert.equal(d.rescored.length, 1);
  assert.equal(d.rescored[0].oldScore, 10);
  assert.equal(d.rescored[0].newScore, 14);
  assert.equal(d.rescored[0].scoreDelta, 4);
});

test('diffTestImpact: rescored sorted by abs(delta) desc', () => {
  const oldSummary = sum([row('a.test.ts', 10), row('b.test.ts', 5), row('c.test.ts', 20)]);
  const newSummary = sum([row('a.test.ts', 11), row('b.test.ts', 50), row('c.test.ts', 12)]);
  const d = diffTestImpact(oldSummary, newSummary);
  // b: +45, c: -8, a: +1
  assert.deepEqual(d.rescored.map(r => r.testFile), ['b.test.ts', 'c.test.ts', 'a.test.ts']);
});

test('diffTestImpact: undefined oldSummary -> everything is added', () => {
  const newSummary = sum([row('a.test.ts', 10), row('b.test.ts', 8)]);
  const d = diffTestImpact(undefined, newSummary);
  assert.equal(d.added.length, 2);
  assert.equal(d.removed.length, 0);
});

test('diffTestImpact: sourceDelta and orphanDelta', () => {
  const oldSummary = sum([row('a.test.ts', 10)], { consideredSources: 5, orphanSources: ['x.ts', 'y.ts'] });
  const newSummary = sum([row('a.test.ts', 10)], { consideredSources: 8, orphanSources: ['x.ts'] });
  const d = diffTestImpact(oldSummary, newSummary);
  assert.equal(d.sourceDelta, 3);
  assert.equal(d.orphanDelta, -1);
});

test('diffTestImpact: stable order across same input', () => {
  const oldSummary = sum([row('b.test.ts', 10), row('a.test.ts', 10)]);
  const newSummary = sum([
    row('a.test.ts', 10),
    row('b.test.ts', 10),
    row('c.test.ts', 5),
    row('d.test.ts', 7),
  ]);
  const d1 = diffTestImpact(oldSummary, newSummary);
  const d2 = diffTestImpact(oldSummary, newSummary);
  assert.deepEqual(d1.added.map(x => x.testFile), d2.added.map(x => x.testFile));
  assert.deepEqual(d1.added.map(x => x.testFile), ['c.test.ts', 'd.test.ts']);
});

test('summariseDiffHeadline: combinations', () => {
  const empty = { added: [], removed: [], rescored: [], unchanged: [], sourceDelta: 0, orphanDelta: 0 };
  assert.equal(summariseDiffHeadline(empty), 'no change');
  assert.equal(summariseDiffHeadline({ ...empty, added: [
    { testFile: 'a', kind: 'added', scoreDelta: 0, newScore: 5 },
  ] }), '+1 test');
  assert.equal(summariseDiffHeadline({ ...empty, added: [
    { testFile: 'a', kind: 'added', scoreDelta: 0, newScore: 5 },
    { testFile: 'b', kind: 'added', scoreDelta: 0, newScore: 5 },
  ] }), '+2 tests');
  assert.equal(summariseDiffHeadline({ ...empty,
    added: [{ testFile: 'a', kind: 'added', scoreDelta: 0, newScore: 5 }],
    removed: [{ testFile: 'b', kind: 'removed', scoreDelta: -3, oldScore: 3 }],
    rescored: [
      { testFile: 'c', kind: 'rescored', scoreDelta: 4, oldScore: 1, newScore: 5 },
      { testFile: 'd', kind: 'rescored', scoreDelta: -2, oldScore: 8, newScore: 6 },
    ],
  }), '+1 test, -1 stale, 2 rescored');
});

test('shouldPostDeltaComment: gates correctly', () => {
  const empty = { added: [], removed: [], rescored: [], unchanged: [], sourceDelta: 0, orphanDelta: 0 };
  assert.equal(shouldPostDeltaComment({ diff: empty }), 'skip');
  assert.equal(shouldPostDeltaComment({
    diff: { ...empty, added: [{ testFile: 'a', kind: 'added', scoreDelta: 0, newScore: 5 }] },
  }), 'post');
  assert.equal(shouldPostDeltaComment({
    diff: { ...empty, removed: [{ testFile: 'a', kind: 'removed', scoreDelta: -3, oldScore: 3 }] },
  }), 'post');
  // small rescore alone -> skip
  assert.equal(shouldPostDeltaComment({
    diff: { ...empty, rescored: [{ testFile: 'a', kind: 'rescored', scoreDelta: 5, oldScore: 1, newScore: 6 }] },
  }), 'skip');
  // big rescore alone -> post
  assert.equal(shouldPostDeltaComment({
    diff: { ...empty, rescored: [{ testFile: 'a', kind: 'rescored', scoreDelta: 15, oldScore: 1, newScore: 16 }] },
  }), 'post');
  // custom threshold respected
  assert.equal(shouldPostDeltaComment({
    diff: { ...empty, rescored: [{ testFile: 'a', kind: 'rescored', scoreDelta: 5, oldScore: 1, newScore: 6 }] },
    rescoreThreshold: 3,
  }), 'post');
});

test('buildDeltaCommentBody: full sections', () => {
  const diff = {
    added: [
      { testFile: 'test/a.spec.ts', kind: 'added' as const, scoreDelta: 0, newScore: 12 },
      { testFile: 'test/b.spec.ts', kind: 'added' as const, scoreDelta: 0, newScore: 8 },
    ],
    removed: [
      { testFile: 'test/old.spec.ts', kind: 'removed' as const, scoreDelta: -5, oldScore: 5 },
    ],
    rescored: [
      { testFile: 'test/c.spec.ts', kind: 'rescored' as const, scoreDelta: 7, oldScore: 18, newScore: 25 },
    ],
    unchanged: [],
    sourceDelta: 2,
    orphanDelta: 0,
  };
  const body = buildDeltaCommentBody({ diff });
  assert.match(body, /## Test-impact delta/);
  assert.match(body, /\*\*Added \(2\)\*\*/);
  assert.match(body, /test\/a\.spec\.ts.*score 12/);
  assert.match(body, /\*\*Removed \(1\)\*\*/);
  assert.match(body, /test\/old\.spec\.ts.*was score 5/);
  assert.match(body, /\*\*Rescored \(1\)\*\*/);
  assert.match(body, /test\/c\.spec\.ts.*18.*25.*\+7/);
  assert.match(body, /\+2 sources considered/);
});

test('buildDeltaCommentBody: cap honoured', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    testFile: `test/x${i}.spec.ts`,
    kind: 'added' as const,
    scoreDelta: 0,
    newScore: i,
  }));
  const body = buildDeltaCommentBody({
    diff: {
      added: many,
      removed: [],
      rescored: [],
      unchanged: [],
      sourceDelta: 0,
      orphanDelta: 0,
    },
    maxPerSection: 5,
  });
  // 5 listed + truncation marker
  const lines = body.split('\n').filter(l => l.startsWith('- '));
  assert.equal(lines.length, 6);
  assert.match(body, /and 25 more/);
});

test('buildDeltaCommentBody: no structural change emits stub', () => {
  const body = buildDeltaCommentBody({
    diff: { added: [], removed: [], rescored: [], unchanged: [], sourceDelta: 0, orphanDelta: 0 },
  });
  assert.match(body, /No structural changes/);
});

test('buildDeltaCommentBody: includeHeader=false skips heading', () => {
  const body = buildDeltaCommentBody({
    diff: { added: [], removed: [], rescored: [], unchanged: [], sourceDelta: 0, orphanDelta: 0 },
    includeHeader: false,
  });
  assert.doesNotMatch(body, /## Test-impact delta/);
});

test('buildDeltaCommentBody: orphanDelta and negative source delta surface', () => {
  const body = buildDeltaCommentBody({
    diff: {
      added: [],
      removed: [],
      rescored: [],
      unchanged: [],
      sourceDelta: -3,
      orphanDelta: 4,
    },
  });
  assert.match(body, /-3 sources considered/);
  assert.match(body, /\+4 orphans/);
});

test('parseRowsFromBlock: extracts test rows with scores', () => {
  const block = [
    '<!-- GITSIGHT:TEST-IMPACT -->',
    '',
    '## Likely-touched tests (3)',
    '',
    '- score 32 \u2014 `test/foo.spec.ts` (imports `src/foo.ts`)',
    '- score 18 \u2014 `__tests__/bar.test.ts` (co-located with `src/bar.ts`)',
    '- score 4 \u2014 `test/baz.spec.ts` (naming sibling of `src/baz.ts`)',
    '',
    '<!-- /GITSIGHT:TEST-IMPACT -->',
  ].join('\n');
  const rows = parseRowsFromBlock(block);
  assert.deepEqual(rows.map(r => r.testFile), [
    'test/foo.spec.ts',
    '__tests__/bar.test.ts',
    'test/baz.spec.ts',
  ]);
  assert.deepEqual(rows.map(r => r.score), [32, 18, 4]);
});

test('parseRowsFromBlock: empty block returns empty list', () => {
  assert.deepEqual(parseRowsFromBlock(''), []);
  assert.deepEqual(parseRowsFromBlock('not a block'), []);
});

test('parseRowsFromBlock: ignores malformed rows', () => {
  const block = [
    '<!-- GITSIGHT:TEST-IMPACT -->',
    '- score 10 \u2014 `valid.spec.ts` (imports)',
    '- malformed line',
    '- score not-a-number \u2014 `broken.spec.ts` (imports)',
    '<!-- /GITSIGHT:TEST-IMPACT -->',
  ].join('\n');
  const rows = parseRowsFromBlock(block);
  assert.deepEqual(rows.map(r => r.testFile), ['valid.spec.ts']);
});

test('diffTestImpactBlocks: composes parser + diff', () => {
  const oldBlock = [
    '<!-- GITSIGHT:TEST-IMPACT -->',
    '- score 10 \u2014 `a.spec.ts` (imports)',
    '- score 5 \u2014 `b.spec.ts` (imports)',
    '<!-- /GITSIGHT:TEST-IMPACT -->',
  ].join('\n');
  const newBlock = [
    '<!-- GITSIGHT:TEST-IMPACT -->',
    '- score 10 \u2014 `a.spec.ts` (imports)',
    '- score 12 \u2014 `c.spec.ts` (imports)',
    '<!-- /GITSIGHT:TEST-IMPACT -->',
  ].join('\n');
  const d = diffTestImpactBlocks(oldBlock, newBlock);
  assert.deepEqual(d.added.map(r => r.testFile), ['c.spec.ts']);
  assert.deepEqual(d.removed.map(r => r.testFile), ['b.spec.ts']);
  assert.equal(d.rescored.length, 0);
  assert.equal(d.unchanged.length, 1);
});

test('diffTestImpactBlocks: rescore picked up on same file', () => {
  const oldBlock = '- score 5 \u2014 `x.spec.ts` (imports)';
  const newBlock = '- score 15 \u2014 `x.spec.ts` (imports)';
  const d = diffTestImpactBlocks(oldBlock, newBlock);
  assert.equal(d.rescored.length, 1);
  assert.equal(d.rescored[0].scoreDelta, 10);
});

test('diffTestImpactBlocks: empty blocks give empty diff', () => {
  const d = diffTestImpactBlocks('', '');
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});
