import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  isTestFile,
  isSourceFile,
  generateSiblingCandidates,
  composeImpact,
  formatImpactHeader,
  buildImpactReport,
  buildImportProbe,
} from '../../src/git/testImpact';

test('isTestFile: .test.ts / .spec.ts / .test.tsx', () => {
  assert.equal(isTestFile('src/foo.test.ts'), true);
  assert.equal(isTestFile('src/foo.spec.ts'), true);
  assert.equal(isTestFile('src/foo.test.tsx'), true);
  assert.equal(isTestFile('src/foo.spec.jsx'), true);
});

test('isTestFile: Go _test.go and Rust _test.rs', () => {
  assert.equal(isTestFile('pkg/handler_test.go'), true);
  assert.equal(isTestFile('src/foo_test.rs'), true);
});

test('isTestFile: Python test_*.py and *_test.py', () => {
  assert.equal(isTestFile('tests/test_foo.py'), true);
  assert.equal(isTestFile('pkg/foo_test.py'), true);
});

test('isTestFile: Ruby _spec.rb and .test.rb', () => {
  assert.equal(isTestFile('spec/foo_spec.rb'), true);
  assert.equal(isTestFile('test/foo.test.rb'), true);
});

test('isTestFile: Cypress .cy.ts', () => {
  assert.equal(isTestFile('cypress/foo.cy.ts'), true);
});

test('isTestFile: __tests__/ directory counts even without suffix', () => {
  assert.equal(isTestFile('src/foo/__tests__/bar.ts'), true);
});

test('isTestFile: src/foo.ts is NOT a test', () => {
  assert.equal(isTestFile('src/foo.ts'), false);
});

test('isTestFile: empty path safe', () => {
  assert.equal(isTestFile(''), false);
});

test('isSourceFile: tracks .ts/.go/.py/.rs', () => {
  for (const p of ['src/foo.ts', 'pkg/main.go', 'src/foo.py', 'src/foo.rs']) {
    assert.equal(isSourceFile(p), true, p);
  }
});

test('isSourceFile: rejects test files', () => {
  assert.equal(isSourceFile('src/foo.test.ts'), false);
  assert.equal(isSourceFile('tests/test_foo.py'), false);
});

test('isSourceFile: rejects assets + lockfiles', () => {
  assert.equal(isSourceFile('src/logo.svg'), false);
  assert.equal(isSourceFile('package-lock.json'), false);
  assert.equal(isSourceFile('yarn.lock'), false);
  assert.equal(isSourceFile('pnpm-lock.yaml'), false);
  assert.equal(isSourceFile('README.md'), false);
});

test('generateSiblingCandidates: TS source emits .test/.spec + __tests__/ + test root', () => {
  const cands = generateSiblingCandidates('src/foo/bar.ts');
  assert.ok(cands.includes('src/foo/bar.test.ts'));
  assert.ok(cands.includes('src/foo/bar.spec.ts'));
  assert.ok(cands.includes('src/foo/__tests__/bar.test.ts'));
  assert.ok(cands.includes('src/foo/__tests__/bar.ts'));
  // src/ stripping
  assert.ok(cands.some(c => c.startsWith('test/foo/')));
});

test('generateSiblingCandidates: Python source emits test_<stem>.py + _test.py + tests/', () => {
  const cands = generateSiblingCandidates('foo/bar.py');
  assert.ok(cands.includes('foo/test_bar.py'));
  assert.ok(cands.includes('foo/bar_test.py'));
  assert.ok(cands.includes('tests/test_bar.py'));
  assert.ok(cands.includes('tests/foo/test_bar.py'));
});

test('generateSiblingCandidates: Go emits _test.go in same dir', () => {
  const cands = generateSiblingCandidates('pkg/handler.go');
  assert.deepEqual(cands, ['pkg/handler_test.go']);
});

test('generateSiblingCandidates: Rust emits _test.rs + tests/ dir', () => {
  const cands = generateSiblingCandidates('src/foo.rs');
  assert.ok(cands.includes('src/foo_test.rs'));
  assert.ok(cands.includes('src/tests/foo.rs'));
});

test('generateSiblingCandidates: Ruby emits spec/ + test/ variants', () => {
  const cands = generateSiblingCandidates('lib/foo.rb');
  assert.ok(cands.includes('spec/lib/foo_spec.rb'));
  assert.ok(cands.includes('test/lib/foo_test.rb'));
});

test('generateSiblingCandidates: empty / no-extension input safe', () => {
  assert.deepEqual(generateSiblingCandidates(''), []);
  assert.deepEqual(generateSiblingCandidates('LICENSE'), []);
});

test('composeImpact: empty input returns empty rows + zero stats', () => {
  const out = composeImpact({
    sourceFiles: [], testFilesChanged: [],
    importMatches: {}, coLocated: {}, namingSiblings: {},
  });
  assert.equal(out.rows.length, 0);
  assert.equal(out.consideredSources, 0);
});

test('composeImpact: import signal dominates by score (weight 10 vs 5 vs 3)', () => {
  const out = composeImpact({
    sourceFiles: ['src/foo.ts', 'src/bar.ts'],
    testFilesChanged: [],
    importMatches: { 'test/foo.test.ts': ['src/foo.ts'] },
    coLocated: { 'src/bar.test.ts': ['src/bar.ts'] },
    namingSiblings: { 'tests/bar.test.ts': ['src/bar.ts'] },
  });
  assert.equal(out.rows[0].testFile, 'test/foo.test.ts');
  assert.equal(out.rows[0].score, 10);
  // Co-located bar.test.ts (5) > naming sibling (3)
  assert.equal(out.rows[1].testFile, 'src/bar.test.ts');
});

test('composeImpact: multiple signals on same test merge, signals deduped', () => {
  const out = composeImpact({
    sourceFiles: ['src/foo.ts'],
    testFilesChanged: [],
    importMatches: { 'test/foo.test.ts': ['src/foo.ts'] },
    coLocated: { 'test/foo.test.ts': ['src/foo.ts'] },
    namingSiblings: { 'test/foo.test.ts': ['src/foo.ts'] },
  });
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0].signals, ['import', 'co-located', 'naming-sibling']);
  // Source de-duped (one source counted once for the file)
  assert.deepEqual(out.rows[0].sourceFiles, ['src/foo.ts']);
  // Score = 10 (import) + 5 (co-loc) + 3 (sib) = 18
  assert.equal(out.rows[0].score, 18);
});

test('composeImpact: more sources -> higher score per signal', () => {
  const out = composeImpact({
    sourceFiles: ['a.ts', 'b.ts', 'c.ts'],
    testFilesChanged: [],
    importMatches: {
      'big.test.ts': ['a.ts', 'b.ts', 'c.ts'],
      'small.test.ts': ['a.ts'],
    },
    coLocated: {},
    namingSiblings: {},
  });
  assert.equal(out.rows[0].testFile, 'big.test.ts');
  assert.equal(out.rows[0].score, 30); // 10 * 3
  assert.equal(out.rows[1].score, 10);
});

test('composeImpact: stable tiebreak by testFile asc when score + count match', () => {
  const out = composeImpact({
    sourceFiles: ['a.ts'],
    testFilesChanged: [],
    importMatches: {
      'z/test.test.ts': ['a.ts'],
      'a/test.test.ts': ['a.ts'],
    },
    coLocated: {},
    namingSiblings: {},
  });
  assert.equal(out.rows[0].testFile, 'a/test.test.ts');
  assert.equal(out.rows[1].testFile, 'z/test.test.ts');
});

test('composeImpact: tests already touched by the PR are excluded', () => {
  const out = composeImpact({
    sourceFiles: ['src/foo.ts'],
    testFilesChanged: ['src/foo.test.ts'],
    importMatches: { 'src/foo.test.ts': ['src/foo.ts'] },
    coLocated: {},
    namingSiblings: {},
  });
  assert.equal(out.rows.length, 0);
});

test('composeImpact: orphan sources surface (those with no suggestions)', () => {
  const out = composeImpact({
    sourceFiles: ['src/covered.ts', 'src/orphan.ts'],
    testFilesChanged: [],
    importMatches: { 'src/covered.test.ts': ['src/covered.ts'] },
    coLocated: {},
    namingSiblings: {},
  });
  assert.deepEqual(out.orphanSources, ['src/orphan.ts']);
  assert.equal(out.coveredSources, 1);
});

test('composeImpact: empty source-file array in input is silently dropped (no row)', () => {
  const out = composeImpact({
    sourceFiles: ['a.ts'],
    testFilesChanged: [],
    importMatches: { 't.test.ts': [] },
    coLocated: {},
    namingSiblings: {},
  });
  assert.equal(out.rows.length, 0);
});

test('formatImpactHeader: empty -> "no source files changed"', () => {
  const s = composeImpact({ sourceFiles: [], testFilesChanged: [], importMatches: {}, coLocated: {}, namingSiblings: {} });
  assert.equal(formatImpactHeader(s), 'no source files changed');
});

test('formatImpactHeader: sources but no tests -> orphan-only message', () => {
  const s = composeImpact({
    sourceFiles: ['a.ts', 'b.ts'],
    testFilesChanged: [], importMatches: {}, coLocated: {}, namingSiblings: {},
  });
  assert.match(formatImpactHeader(s), /no test impact found for 2 source files/);
});

test('formatImpactHeader: covered with orphans renders count', () => {
  const s = composeImpact({
    sourceFiles: ['a.ts', 'b.ts'],
    testFilesChanged: [],
    importMatches: { 'a.test.ts': ['a.ts'] },
    coLocated: {}, namingSiblings: {},
  });
  const out = formatImpactHeader(s);
  assert.match(out, /1 test/);
  assert.match(out, /1\/2 source/);
  assert.match(out, /1 orphan/);
});

test('formatImpactHeader: zero orphans drops the orphans clause', () => {
  const s = composeImpact({
    sourceFiles: ['a.ts'],
    testFilesChanged: [],
    importMatches: { 'a.test.ts': ['a.ts'] },
    coLocated: {}, namingSiblings: {},
  });
  assert.equal(/orphan/.test(formatImpactHeader(s)), false);
});

test('buildImpactReport: no rows but sources changed -> orphan list', () => {
  const s = composeImpact({
    sourceFiles: ['src/a.ts', 'src/b.ts'],
    testFilesChanged: [], importMatches: {}, coLocated: {}, namingSiblings: {},
  });
  const md = buildImpactReport(s);
  assert.match(md, /No tests detected\./);
  assert.match(md, /`src\/a\.ts`/);
  assert.match(md, /`src\/b\.ts`/);
});

test('buildImpactReport: non-empty renders markdown table', () => {
  const s = composeImpact({
    sourceFiles: ['src/foo.ts'],
    testFilesChanged: [],
    importMatches: { 'test/foo.test.ts': ['src/foo.ts'] },
    coLocated: {},
    namingSiblings: {},
  });
  const md = buildImpactReport(s);
  assert.match(md, /^# PR Test Impact/);
  assert.match(md, /\| Test \| Score \| Signals \| Sources \|/);
  assert.match(md, /`test\/foo\.test\.ts`/);
});

test('buildImpactReport: orphans surface as a second section', () => {
  const s = composeImpact({
    sourceFiles: ['src/covered.ts', 'src/orphan.ts'],
    testFilesChanged: [],
    importMatches: { 'src/covered.test.ts': ['src/covered.ts'] },
    coLocated: {}, namingSiblings: {},
  });
  const md = buildImpactReport(s);
  assert.match(md, /## Orphan sources/);
  assert.match(md, /`src\/orphan\.ts`/);
});

test('buildImportProbe: strips src/ prefix + drops extension', () => {
  const p = buildImportProbe('src/foo/bar.ts');
  // Forward slashes are NOT regex metacharacters in JS; only the dots
  // need escaping. Match the literal `foo/bar` substring.
  assert.match(p.pattern, /foo\/bar/);
  assert.equal(/\\\.ts/.test(p.pattern), false);
});

test('buildImportProbe: regex-escapes special characters in path', () => {
  const p = buildImportProbe('src/foo.bar.module.ts');
  assert.match(p.pattern, /foo\\\.bar\\\.module/);
});

test('buildImportProbe: quoted form wraps with single quotes', () => {
  const p = buildImportProbe('src/foo.ts');
  assert.match(p.quoted, /^'.*'$/);
});
