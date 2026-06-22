import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  clusterDiffRows,
  buildSplitCommands,
  describeCluster,
  summariseClusters,
  DiffCluster,
} from '../../src/git/diffSplitSuggester';
import { DiffNumstatRow } from '../../src/git/diffSizeHeuristic';

function row(path: string, added = 10, deleted = 5, isBinary = false): DiffNumstatRow {
  return { path, added, deleted, isBinary };
}

test('clusterDiffRows: empty input -> empty', () => {
  assert.deepEqual(clusterDiffRows({ rows: [] }), []);
});

test('clusterDiffRows: groups by top-level + classifies kinds', () => {
  const rows = [
    row('src/foo/a.ts', 100, 20),
    row('src/foo/b.ts', 50, 10),
    row('test/foo/a.test.ts', 30, 5),
    row('docs/intro.md', 8, 2),
    row('package-lock.json', 500, 50),
  ];
  const out = clusterDiffRows({ rows, preferredType: 'feat' });
  assert.equal(out.length, 4);
  const kinds = out.map(c => c.kind);
  // Lockfile lives at the bottom regardless of churn.
  assert.equal(kinds[kinds.length - 1], 'lockfile');
  // Source cluster (highest churn) lives first.
  assert.equal(kinds[0], 'source');
  // 'test/...' rooted file lands in tests cluster.
  assert.ok(out.some(c => c.kind === 'tests' && c.paths.includes('test/foo/a.test.ts')));
  // docs picked up.
  assert.ok(out.some(c => c.kind === 'docs' && c.paths.includes('docs/intro.md')));
});

test('clusterDiffRows: separates by top-level directory', () => {
  const rows = [
    row('frontend/app.ts', 10, 5),
    row('backend/server.ts', 20, 10),
  ];
  const out = clusterDiffRows({ rows });
  assert.equal(out.length, 2);
  const tops = out.map(c => c.topLevel).sort();
  assert.deepEqual(tops, ['backend', 'frontend']);
});

test('clusterDiffRows: lockfile + snapshots always at bottom', () => {
  const rows = [
    row('src/index.ts', 5, 1),
    row('package-lock.json', 5000, 5000),
    row('test/__snapshots__/a.snap', 1000, 200),
  ];
  const out = clusterDiffRows({ rows });
  // Source first despite tiny churn; lockfile + snapshots at end.
  assert.equal(out[0].kind, 'source');
  const lastTwo = out.slice(-2).map(c => c.kind).sort();
  assert.deepEqual(lastTwo, ['lockfile', 'snapshots']);
});

test('clusterDiffRows: caps at 6 clusters', () => {
  const rows: DiffNumstatRow[] = [];
  for (let i = 0; i < 10; i++) rows.push(row(`top${i}/x.ts`, 5, 5));
  const out = clusterDiffRows({ rows });
  assert.equal(out.length, 6);
});

test('clusterDiffRows: source uses preferred type when supplied', () => {
  const rows = [row('src/foo.ts', 10, 5)];
  const out = clusterDiffRows({ rows, preferredType: 'fix', preferredScope: 'core' });
  assert.equal(out[0].kind, 'source');
  assert.equal(out[0].suggestedSubject, 'fix(core): src changes');
});

test('clusterDiffRows: source defaults to refactor when no type given', () => {
  const rows = [row('src/foo.ts', 1, 1)];
  const out = clusterDiffRows({ rows });
  assert.equal(out[0].suggestedSubject, 'refactor: src changes');
});

test('clusterDiffRows: tests + docs + snapshots subjects are sensible', () => {
  const rows = [
    row('test/util/x.test.ts', 5, 1),
    row('docs/intro.md', 5, 0),
    row('__snapshots__/x.snap', 5, 0),
  ];
  const out = clusterDiffRows({ rows });
  const byKind = Object.fromEntries(out.map(c => [c.kind, c]));
  assert.equal(byKind.tests.suggestedSubject, 'test: update test tests');
  assert.equal(byKind.docs.suggestedSubject, 'docs: update');
  assert.match(byKind.snapshots.suggestedSubject, /^test:/);
});

test('clusterDiffRows: repo-root files use (repo root) marker', () => {
  const rows = [row('README.md', 3, 0)];
  const out = clusterDiffRows({ rows });
  assert.equal(out[0].topLevel, '(repo root)');
  assert.equal(out[0].kind, 'docs');
});

test('clusterDiffRows: spec.ts is classified as tests', () => {
  const rows = [row('src/widget.spec.ts', 12, 0)];
  const out = clusterDiffRows({ rows });
  assert.equal(out[0].kind, 'tests');
});

test('clusterDiffRows: __snapshots__ path is snapshots kind', () => {
  const rows = [row('src/components/__snapshots__/button.snap', 100, 50)];
  const out = clusterDiffRows({ rows });
  assert.equal(out[0].kind, 'snapshots');
});

test('clusterDiffRows: yarn.lock at root recognised as lockfile', () => {
  const rows = [row('yarn.lock', 100, 50)];
  const out = clusterDiffRows({ rows });
  assert.equal(out[0].kind, 'lockfile');
  assert.match(out[0].suggestedSubject, /^chore\(deps\):/);
});

test('clusterDiffRows: deterministic alphabetical tiebreak on equal churn', () => {
  const rows = [
    row('zoo/a.ts', 5, 5),
    row('aardvark/b.ts', 5, 5),
  ];
  const out = clusterDiffRows({ rows });
  assert.equal(out[0].topLevel, 'aardvark');
  assert.equal(out[1].topLevel, 'zoo');
});

test('buildSplitCommands: empty -> empty', () => {
  assert.deepEqual(buildSplitCommands([]), []);
});

test('buildSplitCommands: emits reset + add + commit per cluster', () => {
  const clusters: DiffCluster[] = [
    {
      kind: 'source',
      topLevel: 'src',
      paths: ['src/a.ts', 'src/b.ts'],
      added: 10, deleted: 5, churn: 15,
      suggestedSubject: 'feat: src changes',
    },
  ];
  const cmds = buildSplitCommands(clusters);
  // First two lines reset the stage.
  assert.match(cmds[0], /Reset staging/);
  assert.equal(cmds[1], 'git reset HEAD');
  // The cluster block emits an `add` + `commit`.
  const text = cmds.join('\n');
  assert.match(text, /git add -- src\/a\.ts/);
  assert.match(text, /git add -- src\/a\.ts \\\n  src\/b\.ts/);
  assert.match(text, /git commit -m 'feat: src changes'/);
});

test('buildSplitCommands: quotes paths with whitespace', () => {
  const clusters: DiffCluster[] = [
    {
      kind: 'docs',
      topLevel: 'docs',
      paths: ['docs/with space.md'],
      added: 1, deleted: 0, churn: 1,
      suggestedSubject: 'docs: update',
    },
  ];
  const cmds = buildSplitCommands(clusters);
  const text = cmds.join('\n');
  assert.match(text, /'docs\/with space\.md'/);
});

test('buildSplitCommands: escapes single-quotes in subject', () => {
  const clusters: DiffCluster[] = [
    {
      kind: 'source',
      topLevel: 'src',
      paths: ['src/a.ts'],
      added: 1, deleted: 0, churn: 1,
      suggestedSubject: "feat: don't break",
    },
  ];
  const text = buildSplitCommands(clusters).join('\n');
  assert.match(text, /git commit -m 'feat: don'\\''t break'/);
});

test('describeCluster: clear human label', () => {
  const c: DiffCluster = {
    kind: 'tests', topLevel: 'test', paths: [],
    added: 0, deleted: 0, churn: 0, suggestedSubject: '',
  };
  assert.equal(describeCluster(c), 'tests \u00b7 test/');
});

test('describeCluster: repo-root files drop the path scope', () => {
  const c: DiffCluster = {
    kind: 'lockfile', topLevel: '(repo root)', paths: ['package-lock.json'],
    added: 100, deleted: 50, churn: 150, suggestedSubject: '',
  };
  assert.equal(describeCluster(c), 'lockfile / generated');
});

test('summariseClusters: empty -> friendly message', () => {
  assert.equal(summariseClusters([]), 'No split suggestions.');
});

test('summariseClusters: arrow-joined list', () => {
  const cs: DiffCluster[] = [
    { kind: 'source', topLevel: 'src', paths: [], added: 0, deleted: 0, churn: 0, suggestedSubject: '' },
    { kind: 'tests', topLevel: 'test', paths: [], added: 0, deleted: 0, churn: 0, suggestedSubject: '' },
    { kind: 'lockfile', topLevel: '(repo root)', paths: [], added: 0, deleted: 0, churn: 0, suggestedSubject: '' },
  ];
  const s = summariseClusters(cs);
  assert.match(s, /3 suggested commits/);
  assert.match(s, /source \u00b7 src\/.*tests \u00b7 test\/.*lockfile \/ generated/);
});

test('clusterDiffRows: binary file rows count as 0 churn but still cluster', () => {
  const rows = [row('assets/image.png', 0, 0, true)];
  const out = clusterDiffRows({ rows });
  assert.equal(out.length, 1);
  assert.equal(out[0].churn, 0);
  assert.deepEqual(out[0].paths, ['assets/image.png']);
});
