import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  hasTestImpactBlock,
  classifyAutoSync,
  buildTestImpactBlock,
  TEST_IMPACT_OPEN_MARKER,
  TEST_IMPACT_CLOSE_MARKER,
} from '../../src/git/testImpactPrBody';
import { TestImpactSummary, TestImpactRow } from '../../src/git/testImpact';

function makeRow(testFile = 'test/a.test.ts', sourceFiles = ['src/a.ts']): TestImpactRow {
  return {
    testFile,
    sourceFiles,
    score: 10,
    signals: ['import'],
  };
}

function summary(overrides: Partial<TestImpactSummary> = {}): TestImpactSummary {
  return {
    rows: overrides.rows ?? [makeRow()],
    consideredSources: overrides.consideredSources ?? 1,
    coveredSources: overrides.coveredSources ?? 1,
    orphanSources: overrides.orphanSources ?? [],
  };
}

function makeBlock(syncedAt = '2026-06-23 11:00'): string {
  return buildTestImpactBlock({
    summary: summary(),
    syncedAt,
    maxRows: 12,
    maxOrphans: 10,
    includeOrphans: true,
  });
}

function injectBlockInto(body: string, block: string): string {
  // Cheap helper - same shape injectTestImpactBlock would produce.
  return body ? `${body}\n\n${block}\n` : block;
}

// ── hasTestImpactBlock ────────────────────────────────────────────────

test('hasTestImpactBlock: empty body returns false', () => {
  assert.equal(hasTestImpactBlock(''), false);
});

test('hasTestImpactBlock: body with no markers returns false', () => {
  assert.equal(hasTestImpactBlock('Just a normal PR body with no test impact section.'), false);
});

test('hasTestImpactBlock: body with both markers in order returns true', () => {
  const block = makeBlock();
  const body = injectBlockInto('Description.', block);
  assert.equal(hasTestImpactBlock(body), true);
});

test('hasTestImpactBlock: body with only OPEN marker returns false (malformed)', () => {
  const body = `Description.\n\n${TEST_IMPACT_OPEN_MARKER}\nbroken left over`;
  assert.equal(hasTestImpactBlock(body), false);
});

test('hasTestImpactBlock: body with only CLOSE marker returns false', () => {
  const body = `Description.\n\nstuff\n${TEST_IMPACT_CLOSE_MARKER}`;
  assert.equal(hasTestImpactBlock(body), false);
});

test('hasTestImpactBlock: markers in REVERSE order returns false', () => {
  const body = `${TEST_IMPACT_CLOSE_MARKER}\nstuff\n${TEST_IMPACT_OPEN_MARKER}`;
  assert.equal(hasTestImpactBlock(body), false);
});

test('hasTestImpactBlock: undefined body returns false (typesafe)', () => {
  assert.equal(hasTestImpactBlock(undefined as any), false);
});

// ── classifyAutoSync ──────────────────────────────────────────────────

test('classifyAutoSync: disabled -> skipped with reason', () => {
  const r = classifyAutoSync({ currentBody: 'anything', freshBlock: makeBlock(), enabled: false });
  assert.equal(r.outcome, 'skipped');
  assert.match(r.reason ?? '', /disabled/);
});

test('classifyAutoSync: undefined body (no PR) -> no-pr', () => {
  const r = classifyAutoSync({ currentBody: undefined, freshBlock: makeBlock(), enabled: true });
  assert.equal(r.outcome, 'no-pr');
});

test('classifyAutoSync: body without block -> no-block', () => {
  const r = classifyAutoSync({
    currentBody: 'A plain PR with no test-impact section.',
    freshBlock: makeBlock(),
    enabled: true,
  });
  assert.equal(r.outcome, 'no-block');
});

test('classifyAutoSync: body with matching block (only timestamp differs) -> no-change', () => {
  const existing = makeBlock('2026-06-23 09:00');
  const fresh = makeBlock('2026-06-23 11:00');
  const body = injectBlockInto('Description.', existing);
  const r = classifyAutoSync({ currentBody: body, freshBlock: fresh, enabled: true });
  assert.equal(r.outcome, 'no-change');
});

test('classifyAutoSync: body with stale block (content differs) -> refreshed', () => {
  const existing = buildTestImpactBlock({
    summary: summary({ rows: [makeRow('test/old.test.ts', ['src/old.ts'])] }),
    syncedAt: '2026-06-23 09:00',
    maxRows: 12,
    maxOrphans: 10,
    includeOrphans: true,
  });
  const fresh = makeBlock();
  const body = injectBlockInto('Description.', existing);
  const r = classifyAutoSync({ currentBody: body, freshBlock: fresh, enabled: true });
  assert.equal(r.outcome, 'refreshed');
});

test('classifyAutoSync: empty string body -> no-block (not no-pr)', () => {
  // Empty-string body still means "the PR exists but has no description".
  // no-pr is reserved for the "no PR returned by gh" case.
  const r = classifyAutoSync({ currentBody: '', freshBlock: makeBlock(), enabled: true });
  assert.equal(r.outcome, 'no-block');
});

test('classifyAutoSync: outcome shape covers every documented state', () => {
  // Mostly a smoke test of the union being exhaustive at runtime;
  // here we just assert the 4 outcomes returned by the classifier match.
  const outcomes = new Set<string>();
  outcomes.add(classifyAutoSync({ currentBody: 'plain', freshBlock: makeBlock(), enabled: true }).outcome);
  outcomes.add(classifyAutoSync({ currentBody: undefined, freshBlock: makeBlock(), enabled: true }).outcome);
  outcomes.add(classifyAutoSync({ currentBody: 'plain', freshBlock: makeBlock(), enabled: false }).outcome);
  const matched = makeBlock();
  outcomes.add(classifyAutoSync({ currentBody: injectBlockInto('D', matched), freshBlock: matched, enabled: true }).outcome);
  assert.equal(outcomes.size, 4);
  assert.ok(outcomes.has('skipped'));
  assert.ok(outcomes.has('no-pr'));
  assert.ok(outcomes.has('no-block'));
  assert.ok(outcomes.has('no-change'));
});

test('classifyAutoSync: gracefully degrades when block has nonsense timestamp', () => {
  // The timestamp-strip uses a relaxed regex so an unconventional timestamp
  // shouldn't force a needless rewrite.
  const existing = makeBlock('NOW');
  const fresh = makeBlock('LATER');
  const body = injectBlockInto('D', existing);
  const r = classifyAutoSync({ currentBody: body, freshBlock: fresh, enabled: true });
  assert.equal(r.outcome, 'no-change');
});

test('classifyAutoSync: reason field absent on non-skipped outcomes', () => {
  const matched = makeBlock();
  const r = classifyAutoSync({ currentBody: injectBlockInto('D', matched), freshBlock: matched, enabled: true });
  assert.equal(r.outcome, 'no-change');
  assert.equal(r.reason, undefined);
});

test('hasTestImpactBlock: detects block surrounded by other markdown', () => {
  const block = makeBlock();
  const body = `## Description\n\nFixes #42.\n\n## Testing\n\n${block}\n\n## Risk\n\nLow.`;
  assert.equal(hasTestImpactBlock(body), true);
});
