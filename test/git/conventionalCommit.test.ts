import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  composeHeader,
  suggestScope,
  suggestType,
  applyHeader,
  CONVENTIONAL_TYPES,
} from '../../src/git/conventionalCommit';

test('CONVENTIONAL_TYPES covers the canonical set', () => {
  const names = CONVENTIONAL_TYPES.map(t => t.type);
  for (const n of ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'chore', 'build', 'ci', 'style', 'revert']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('composeHeader: bare, scoped, breaking', () => {
  assert.equal(composeHeader('feat', undefined, 'add thing'), 'feat: add thing');
  assert.equal(composeHeader('feat', 'git', 'add thing'), 'feat(git): add thing');
  assert.equal(composeHeader('feat', undefined, 'add thing', true), 'feat!: add thing');
  assert.equal(composeHeader('feat', 'api', 'rip out old endpoint', true), 'feat(api)!: rip out old endpoint');
});

test('composeHeader: trims whitespace around scope + subject', () => {
  assert.equal(composeHeader('fix', ' x ', '  Y  '), 'fix(x): Y');
});

test('suggestScope: empty input → undefined', () => {
  assert.equal(suggestScope([]), undefined);
});

test('suggestScope: README/CHANGELOG/LICENSE → docs', () => {
  assert.equal(suggestScope(['README.md']), 'docs');
  assert.equal(suggestScope(['README.md', 'CHANGELOG.md']), 'docs');
  assert.equal(suggestScope(['docs/intro.md', 'docs/api.md']), 'docs');
});

test('suggestScope: lockfiles + manifests → deps', () => {
  assert.equal(suggestScope(['package.json', 'package-lock.json']), 'deps');
  assert.equal(suggestScope(['Cargo.toml', 'Cargo.lock']), 'deps');
  assert.equal(suggestScope(['pnpm-lock.yaml']), 'deps');
});

test('suggestScope: .github/workflows/** → ci', () => {
  assert.equal(suggestScope(['.github/workflows/test.yml']), 'ci');
});

test('suggestScope: src/<segment>/* with a clear majority', () => {
  assert.equal(suggestScope([
    'src/git/git.ts',
    'src/git/format.ts',
    'src/git/branchCleanup.ts',
    'src/views/sync.ts',
  ]), 'git');
});

test('suggestScope: single src file uses the file stem', () => {
  assert.equal(suggestScope(['src/extension.ts']), 'extension');
});

test('suggestScope: no majority → undefined (noisy)', () => {
  assert.equal(suggestScope([
    'src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts', 'src/d/w.ts',
  ]), undefined);
});

test('suggestType: docs-only → docs', () => {
  assert.equal(suggestType(['README.md', 'docs/intro.md']).type, 'docs');
});

test('suggestType: tests-only → test', () => {
  assert.equal(suggestType(['test/foo.test.ts', 'tests/bar.spec.ts']).type, 'test');
});

test('suggestType: ci-only → ci', () => {
  assert.equal(suggestType(['.github/workflows/test.yml']).type, 'ci');
});

test('suggestType: lockfiles → build', () => {
  assert.equal(suggestType(['package-lock.json']).type, 'build');
});

test('suggestType: mixed → feat (default)', () => {
  assert.equal(suggestType(['src/extension.ts', 'README.md']).type, 'feat');
});

test('suggestType: empty → chore with confidence 0', () => {
  const s = suggestType([]);
  assert.equal(s.type, 'chore');
  assert.equal(s.confidence, 0);
});

test('applyHeader: replaces first line, preserves the rest', () => {
  const cur = 'old header\n\nbody line 1\nbody line 2\n';
  const out = applyHeader(cur, 'feat(x): new');
  assert.equal(out, 'feat(x): new\n\nbody line 1\nbody line 2\n');
});

test('applyHeader: single-line message gets replaced wholesale', () => {
  assert.equal(applyHeader('wip', 'fix(api): handle null'), 'fix(api): handle null');
  assert.equal(applyHeader('', 'feat: x'), 'feat: x');
});
