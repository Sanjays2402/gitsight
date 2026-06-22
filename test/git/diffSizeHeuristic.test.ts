import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseNumstat,
  isNoisyPath,
  computeDiffStats,
  classifyDiffSize,
  extractSubjectType,
} from '../../src/git/diffSizeHeuristic';

test('parseNumstat: parses standard lines', () => {
  const raw = [
    '10\t5\tsrc/a.ts',
    '0\t3\tsrc/b.ts',
    '100\t0\tREADME.md',
  ].join('\n');
  const rows = parseNumstat(raw);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { added: 10, deleted: 5, path: 'src/a.ts', isBinary: false });
  assert.deepEqual(rows[1], { added: 0, deleted: 3, path: 'src/b.ts', isBinary: false });
});

test('parseNumstat: binary files marked + counted as zero lines', () => {
  const raw = '-\t-\tmedia/foo.png';
  const rows = parseNumstat(raw);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { added: 0, deleted: 0, path: 'media/foo.png', isBinary: true });
});

test('parseNumstat: brace-form rename uses new path', () => {
  const raw = '5\t2\tsrc/{old.ts => new.ts}';
  const rows = parseNumstat(raw);
  assert.equal(rows[0].path, 'src/new.ts');
});

test('parseNumstat: simple => rename uses new path', () => {
  const raw = '5\t2\told/foo.ts => new/foo.ts';
  const rows = parseNumstat(raw);
  assert.equal(rows[0].path, 'new/foo.ts');
});

test('parseNumstat: tolerates empty + bad input', () => {
  assert.deepEqual(parseNumstat(''), []);
  assert.deepEqual(parseNumstat('not a numstat line'), []);
  assert.deepEqual(parseNumstat('1\tno-tab-after\t').length, 0);
});

test('isNoisyPath: lockfiles recognised at any depth', () => {
  assert.equal(isNoisyPath('package-lock.json'), true);
  assert.equal(isNoisyPath('frontend/yarn.lock'), true);
  assert.equal(isNoisyPath('apps/web/pnpm-lock.yaml'), true);
  assert.equal(isNoisyPath('Cargo.lock'), true);
});

test('isNoisyPath: vendored / generated dirs recognised', () => {
  assert.equal(isNoisyPath('node_modules/foo/bar.js'), true);
  assert.equal(isNoisyPath('dist/index.js'), true);
  assert.equal(isNoisyPath('out-test/test/x.js'), true);
  assert.equal(isNoisyPath('packages/a/dist/x.js'), true);
});

test('isNoisyPath: min/bundle/map/snapshot suffixes recognised', () => {
  assert.equal(isNoisyPath('public/app.min.js'), true);
  assert.equal(isNoisyPath('public/main.bundle.css'), true);
  assert.equal(isNoisyPath('dist/x.js.map'), true);
  assert.equal(isNoisyPath('__snapshots__/foo.snap'), true);
  assert.equal(isNoisyPath('test/foo.golden'), true);
});

test('isNoisyPath: regular source paths NOT recognised', () => {
  assert.equal(isNoisyPath('src/git/x.ts'), false);
  assert.equal(isNoisyPath('test/foo.ts'), false);
  assert.equal(isNoisyPath('README.md'), false);
  assert.equal(isNoisyPath(''), false);
});

test('computeDiffStats: aggregates counts + noisy subset', () => {
  const rows = parseNumstat([
    '10\t5\tsrc/git/x.ts',
    '5000\t100\tpackage-lock.json',
    '20\t0\tsrc/git/y.ts',
  ].join('\n'));
  const stats = computeDiffStats(rows);
  assert.equal(stats.files, 3);
  assert.equal(stats.added, 5030);
  assert.equal(stats.deleted, 105);
  assert.equal(stats.total, 5135);
  assert.deepEqual(stats.noisyPaths, ['package-lock.json']);
  assert.equal(stats.noisyLines, 5100);
});

test('classifyDiffSize: empty staging -> ok with empty pill', () => {
  const result = classifyDiffSize({
    stats: computeDiffStats([]),
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  assert.equal(result.severity, 'ok');
  assert.match(result.pillLabel, /staged: empty/);
});

test('classifyDiffSize: small diff -> ok', () => {
  const stats = computeDiffStats(parseNumstat('30\t10\tsrc/git/x.ts'));
  const result = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  assert.equal(result.severity, 'ok');
});

test('classifyDiffSize: above line threshold but not huge -> warning', () => {
  const stats = computeDiffStats(parseNumstat([
    '500\t100\tsrc/git/big.ts',
  ].join('\n')));
  const result = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  assert.equal(result.severity, 'warning');
  assert.match(result.summary, /Consider splitting/);
});

test('classifyDiffSize: file-count threshold triggers warning', () => {
  const rows = parseNumstat(Array.from({ length: 25 }, (_, i) => `5\t0\tsrc/f${i}.ts`).join('\n'));
  const result = classifyDiffSize({
    stats: computeDiffStats(rows),
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  assert.equal(result.severity, 'warning');
});

test('classifyDiffSize: huge threshold triggers huge severity', () => {
  const stats = computeDiffStats(parseNumstat('2500\t0\tsrc/giant.ts'));
  const result = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  assert.equal(result.severity, 'huge');
  assert.match(result.summary, /Huge staged diff/);
});

test('classifyDiffSize: huge-but-noisy bucket gets `noisy` if 70%+ is lockfile', () => {
  const rows = parseNumstat([
    '50\t10\tsrc/git/x.ts',  // 60 normal
    '4900\t0\tpackage-lock.json', // 4900 noise
  ].join('\n'));
  // Total = 4960; noise fraction = 4900/4960 = 98.8%.
  const result = classifyDiffSize({
    stats: computeDiffStats(rows),
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  assert.equal(result.severity, 'noisy');
  assert.match(result.detail, /lockfile/);
});

test('classifyDiffSize: noisy dominance threshold takes precedence over warning', () => {
  // 600 line diff, 500 of which are noise -> noisy not warning
  const rows = parseNumstat([
    '500\t0\tdist/bundle.js',
    '100\t0\tsrc/git/x.ts',
  ].join('\n'));
  const result = classifyDiffSize({
    stats: computeDiffStats(rows),
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
  });
  // 500/600 = 83% noise -> noisy
  assert.equal(result.severity, 'noisy');
});

test('classifyDiffSize: style/chore commits exempt from warning', () => {
  const stats = computeDiffStats(parseNumstat('500\t100\tsrc/style.ts'));
  const styleResult = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
    subjectType: 'style',
  });
  assert.equal(styleResult.severity, 'ok');
  const chore = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
    subjectType: 'chore',
  });
  assert.equal(chore.severity, 'ok');
});

test('classifyDiffSize: feat/fix NOT exempt from warning', () => {
  const stats = computeDiffStats(parseNumstat('500\t100\tsrc/git/x.ts'));
  const feat = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
    subjectType: 'feat',
  });
  assert.equal(feat.severity, 'warning');
});

test('classifyDiffSize: huge severity NOT bypassed by exempt type', () => {
  // Style commits with 3000 lines should still get flagged — that's
  // beyond \"naturally big sweep\" into \"actually too big to review\".
  const stats = computeDiffStats(parseNumstat('3000\t0\tsrc/styles.ts'));
  const result = classifyDiffSize({
    stats,
    lineThreshold: 400, fileThreshold: 20, hugeLineThreshold: 2000, noisyDominanceThreshold: 0.7,
    subjectType: 'style',
  });
  // Huge applies BEFORE the exempt-type check.
  assert.equal(result.severity, 'huge');
});

test('extractSubjectType: standard conventional headers', () => {
  assert.equal(extractSubjectType('feat(git): foo'), 'feat');
  assert.equal(extractSubjectType('fix: bar'), 'fix');
  assert.equal(extractSubjectType('chore(deps)!: bump'), 'chore');
  assert.equal(extractSubjectType('docs: README'), 'docs');
});

test('extractSubjectType: returns undefined on garbage', () => {
  assert.equal(extractSubjectType(''), undefined);
  assert.equal(extractSubjectType(undefined), undefined);
  assert.equal(extractSubjectType('WIP'), undefined);
  assert.equal(extractSubjectType('feat'), undefined); // no colon-space
  assert.equal(extractSubjectType('Feat: foo'), undefined); // uppercase first letter not matched
});

test('extractSubjectType: only considers first line', () => {
  assert.equal(extractSubjectType('feat: line one\n\nbody text continues'), 'feat');
});
