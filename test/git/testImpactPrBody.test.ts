import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildTestImpactBlock,
  injectTestImpactBlock,
  needsTestImpactRewrite,
  stripTestImpactBlock,
  classifyTestImpactSync,
  TEST_IMPACT_OPEN_MARKER,
  TEST_IMPACT_CLOSE_MARKER,
} from '../../src/git/testImpactPrBody';
import { TestImpactSummary } from '../../src/git/testImpact';

function summary(opts: Partial<TestImpactSummary> = {}): TestImpactSummary {
  return {
    rows: [],
    consideredSources: 0,
    coveredSources: 0,
    orphanSources: [],
    ...opts,
  };
}

// ── buildTestImpactBlock ──────────────────────────────────────────────
test('buildTestImpactBlock: opens and closes with the canonical markers', () => {
  const block = buildTestImpactBlock({ summary: summary(), syncedAt: '2026-06-23 06:30 PDT' });
  assert.ok(block.startsWith(TEST_IMPACT_OPEN_MARKER));
  assert.ok(block.endsWith(TEST_IMPACT_CLOSE_MARKER));
});

test('buildTestImpactBlock: empty rows + no sources -> "no source files" stub', () => {
  const block = buildTestImpactBlock({ summary: summary(), syncedAt: 't' });
  assert.match(block, /No source files changed\./);
});

test('buildTestImpactBlock: empty rows + non-zero sources -> "no tests detected" stub', () => {
  const block = buildTestImpactBlock({
    summary: summary({ consideredSources: 5, orphanSources: ['a', 'b'] }),
    syncedAt: 't',
  });
  assert.match(block, /No tests detected for 5 changed source files\./);
});

test('buildTestImpactBlock: renders rows with score + path + signal', () => {
  const block = buildTestImpactBlock({
    summary: summary({
      rows: [
        { testFile: 'test/foo.test.ts', score: 30, sourceFiles: ['src/foo.ts'], signals: ['import'] },
        { testFile: 'test/bar.test.ts', score: 15, sourceFiles: ['src/bar.ts'], signals: ['co-located'] },
      ],
      consideredSources: 2,
      coveredSources: 2,
    }),
    syncedAt: 't',
  });
  assert.match(block, /score 30/);
  assert.match(block, /test\/foo\.test\.ts/);
  assert.match(block, /imports `src\/foo\.ts`/);
  assert.match(block, /co-located with `src\/bar\.ts`/);
});

test('buildTestImpactBlock: caps rows at maxRows and notes the cap', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    testFile: `test/${i}.test.ts`,
    score: 30 - i,
    sourceFiles: [`src/${i}.ts`],
    signals: ['import'] as Array<'import'>,
  }));
  const block = buildTestImpactBlock({
    summary: summary({ rows, consideredSources: 20, coveredSources: 20 }),
    syncedAt: 't',
    maxRows: 5,
  });
  assert.match(block, /Likely-touched tests \(5 of 20\)/);
  assert.ok(block.includes('test/0.test.ts'));
  assert.ok(!block.includes('test/15.test.ts'));
});

test('buildTestImpactBlock: multi-signal rows render the lead + signal count', () => {
  const block = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/foo.test.ts', score: 50, sourceFiles: ['src/foo.ts'], signals: ['import', 'co-located'] }],
      consideredSources: 1,
      coveredSources: 1,
    }),
    syncedAt: 't',
  });
  assert.match(block, /imports \(2 signals\)/);
});

test('buildTestImpactBlock: source-list formatting (1, 2, 3+ sources)', () => {
  const one = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/a.test.ts', score: 1, sourceFiles: ['src/a.ts'], signals: ['import'] }],
      consideredSources: 1, coveredSources: 1,
    }),
    syncedAt: 't',
  });
  assert.match(one, /imports `src\/a\.ts`/);
  const two = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/a.test.ts', score: 1, sourceFiles: ['src/a.ts', 'src/b.ts'], signals: ['import'] }],
      consideredSources: 2, coveredSources: 2,
    }),
    syncedAt: 't',
  });
  assert.match(two, /imports `src\/a\.ts`, `src\/b\.ts`/);
  const three = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/a.test.ts', score: 1, sourceFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], signals: ['import'] }],
      consideredSources: 4, coveredSources: 4,
    }),
    syncedAt: 't',
  });
  assert.match(three, /imports `src\/a\.ts`, `src\/b\.ts`, \+2/);
});

test('buildTestImpactBlock: includes coverage summary line when applicable', () => {
  const block = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/foo.test.ts', score: 30, sourceFiles: ['src/foo.ts'], signals: ['import'] }],
      consideredSources: 5,
      coveredSources: 1,
      orphanSources: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    }),
    syncedAt: 't',
  });
  assert.match(block, /1\/5 sources covered, 4 orphans/);
});

test('buildTestImpactBlock: orphan list inside a <details> collapsible (capped)', () => {
  const orphans = Array.from({ length: 15 }, (_, i) => `src/o${i}.ts`);
  const block = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/foo.test.ts', score: 30, sourceFiles: ['src/foo.ts'], signals: ['import'] }],
      consideredSources: 16,
      coveredSources: 1,
      orphanSources: orphans,
    }),
    syncedAt: 't',
    maxOrphans: 5,
  });
  assert.match(block, /<details><summary>15 orphan sources/);
  assert.match(block, /src\/o0\.ts/);
  assert.ok(!block.includes('src/o10.ts'));
  // Pure helper uses the Unicode horizontal ellipsis (\u2026) for the
  // truncation marker - match it explicitly so a regression to ASCII
  // dots would surface here (and to avoid the "/\.\.\.and/" miss seen
  // on the first run of this test).
  assert.match(block, /\u2026and 10 more/);
});

test('buildTestImpactBlock: includeOrphans=false hides the orphan section', () => {
  const block = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/foo.test.ts', score: 30, sourceFiles: ['src/foo.ts'], signals: ['import'] }],
      consideredSources: 3,
      coveredSources: 1,
      orphanSources: ['src/a.ts', 'src/b.ts'],
    }),
    syncedAt: 't',
    includeOrphans: false,
  });
  assert.ok(!block.includes('<details>'));
});

test('buildTestImpactBlock: includes timestamp footer', () => {
  const block = buildTestImpactBlock({ summary: summary(), syncedAt: '2026-06-23 06:30 PDT' });
  assert.match(block, /_Last synced 2026-06-23 06:30 PDT by GitSight\._/);
});

// ── injectTestImpactBlock ─────────────────────────────────────────────
test('injectTestImpactBlock: appends to empty body', () => {
  const block = buildTestImpactBlock({ summary: summary(), syncedAt: 't' });
  const out = injectTestImpactBlock('', block);
  assert.equal(out, block);
});

test('injectTestImpactBlock: appends to non-empty body with blank-line separator', () => {
  const block = buildTestImpactBlock({ summary: summary(), syncedAt: 't' });
  const body = 'Hello world\n\nThis is my PR.';
  const out = injectTestImpactBlock(body, block);
  assert.ok(out.startsWith('Hello world\n\nThis is my PR.\n\n'));
  assert.ok(out.includes(TEST_IMPACT_OPEN_MARKER));
});

test('injectTestImpactBlock: replaces existing block in place', () => {
  const oldBlock = `${TEST_IMPACT_OPEN_MARKER}\n## old content\n${TEST_IMPACT_CLOSE_MARKER}`;
  const body = `Prologue\n\n${oldBlock}\n\nEpilogue`;
  const newBlock = `${TEST_IMPACT_OPEN_MARKER}\n## NEW content\n${TEST_IMPACT_CLOSE_MARKER}`;
  const out = injectTestImpactBlock(body, newBlock);
  assert.match(out, /## NEW content/);
  assert.ok(!out.includes('## old content'));
  assert.match(out, /^Prologue/);
  assert.match(out, /Epilogue$/);
});

test('injectTestImpactBlock: round-trips repeatedly without drifting blank-line count', () => {
  const block1 = `${TEST_IMPACT_OPEN_MARKER}\n## v1\n${TEST_IMPACT_CLOSE_MARKER}`;
  const block2 = `${TEST_IMPACT_OPEN_MARKER}\n## v2\n${TEST_IMPACT_CLOSE_MARKER}`;
  const block3 = `${TEST_IMPACT_OPEN_MARKER}\n## v3\n${TEST_IMPACT_CLOSE_MARKER}`;
  let body = 'Hello.';
  body = injectTestImpactBlock(body, block1);
  body = injectTestImpactBlock(body, block2);
  body = injectTestImpactBlock(body, block3);
  // Should not accumulate blank lines.
  assert.ok(!body.includes('\n\n\n\n'));
  assert.match(body, /## v3/);
  assert.ok(!body.includes('## v1'));
});

// ── needsTestImpactRewrite ────────────────────────────────────────────
test('needsTestImpactRewrite: true when no block present', () => {
  assert.equal(needsTestImpactRewrite('No block here.', `${TEST_IMPACT_OPEN_MARKER}\n${TEST_IMPACT_CLOSE_MARKER}`), true);
});

test('needsTestImpactRewrite: false when blocks match (timestamps masked)', () => {
  const fresh = buildTestImpactBlock({ summary: summary(), syncedAt: 'now' });
  const existing = buildTestImpactBlock({ summary: summary(), syncedAt: 'earlier-time' });
  // Different timestamps but same body should NOT trigger rewrite.
  const body = injectTestImpactBlock('', existing);
  assert.equal(needsTestImpactRewrite(body, fresh), false);
});

test('needsTestImpactRewrite: true when content differs', () => {
  const fresh = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/new.test.ts', score: 30, sourceFiles: ['src/new.ts'], signals: ['import'] }],
      consideredSources: 1, coveredSources: 1,
    }),
    syncedAt: 't',
  });
  const existing = buildTestImpactBlock({ summary: summary(), syncedAt: 't' });
  const body = injectTestImpactBlock('', existing);
  assert.equal(needsTestImpactRewrite(body, fresh), true);
});

// ── stripTestImpactBlock ──────────────────────────────────────────────
test('stripTestImpactBlock: removes the managed block + surrounding blanks', () => {
  const block = `${TEST_IMPACT_OPEN_MARKER}\n## content\n${TEST_IMPACT_CLOSE_MARKER}`;
  const body = `Prologue\n\n${block}\n\nEpilogue`;
  const out = stripTestImpactBlock(body);
  assert.match(out, /^Prologue/);
  assert.match(out, /Epilogue$/);
  assert.ok(!out.includes(TEST_IMPACT_OPEN_MARKER));
});

test('stripTestImpactBlock: no-op when no block is present', () => {
  assert.equal(stripTestImpactBlock('Just text.'), 'Just text.');
});

test('stripTestImpactBlock: empty when block is the only content', () => {
  const body = `${TEST_IMPACT_OPEN_MARKER}\n## content\n${TEST_IMPACT_CLOSE_MARKER}`;
  assert.equal(stripTestImpactBlock(body), '');
});

// ── classifyTestImpactSync ────────────────────────────────────────────
test('classifyTestImpactSync: insert when no block present', () => {
  assert.equal(classifyTestImpactSync('Body without block', 'block'), 'insert');
});

test('classifyTestImpactSync: no-change when content matches', () => {
  const fresh = buildTestImpactBlock({ summary: summary(), syncedAt: 'now' });
  const existing = buildTestImpactBlock({ summary: summary(), syncedAt: 'earlier' });
  const body = injectTestImpactBlock('Hello.', existing);
  assert.equal(classifyTestImpactSync(body, fresh), 'no-change');
});

test('classifyTestImpactSync: replace when content differs', () => {
  const fresh = buildTestImpactBlock({
    summary: summary({
      rows: [{ testFile: 'test/new.test.ts', score: 30, sourceFiles: ['src/new.ts'], signals: ['import'] }],
      consideredSources: 1, coveredSources: 1,
    }),
    syncedAt: 'now',
  });
  const existing = buildTestImpactBlock({ summary: summary(), syncedAt: 'now' });
  const body = injectTestImpactBlock('Hello.', existing);
  assert.equal(classifyTestImpactSync(body, fresh), 'replace');
});
