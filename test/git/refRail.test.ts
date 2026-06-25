import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyRailRef,
  buildRefRail,
  sortRailRefs,
  buildRailSections,
  refQuery,
} from '../../src/shared/refRail';

// ── classifyRailRef ──────────────────────────────────────────────────

test('classifyRailRef handles HEAD arrow, tag, remote, and plain branch', () => {
  assert.deepEqual(classifyRailRef('HEAD -> main'), { name: 'main', group: 'branch', isHead: true });
  assert.deepEqual(classifyRailRef('tag: v1.0.0'), { name: 'v1.0.0', group: 'tag', isHead: false });
  assert.deepEqual(classifyRailRef('origin/main'), { name: 'origin/main', group: 'remote', isHead: false });
  assert.deepEqual(classifyRailRef('feature/x'), { name: 'feature/x', group: 'remote', isHead: false });
  assert.deepEqual(classifyRailRef('develop'), { name: 'develop', group: 'branch', isHead: false });
});

test('classifyRailRef drops bare HEAD and remote HEAD aliases', () => {
  assert.equal(classifyRailRef('HEAD'), null);
  assert.equal(classifyRailRef('origin/HEAD'), null);
  assert.equal(classifyRailRef('   '), null);
});

// ── buildRefRail ─────────────────────────────────────────────────────

const COMMITS = [
  { sha: 'aaa', refs: ['HEAD -> main', 'origin/main'] },
  { sha: 'bbb', refs: ['tag: v1.0.0', 'feature/login'] },
  { sha: 'ccc', refs: [] },
  { sha: 'ddd', refs: ['main'] }, // a later mention of main — tip stays aaa
];

test('buildRefRail keeps the first (tip) sha per ref and preserves HEAD', () => {
  const rail = buildRefRail(COMMITS);
  const main = rail.find(r => r.name === 'main' && r.group === 'branch');
  assert.ok(main);
  assert.equal(main.tipSha, 'aaa');
  assert.equal(main.isHead, true);

  const tag = rail.find(r => r.group === 'tag')!;
  assert.equal(tag.name, 'v1.0.0');
  assert.equal(tag.tipSha, 'bbb');

  const remote = rail.find(r => r.group === 'remote')!;
  assert.equal(remote.name, 'origin/main');
});

test('buildRefRail de-duplicates a ref seen on multiple commits', () => {
  const rail = buildRefRail([
    { sha: 'a', refs: ['main'] },
    { sha: 'b', refs: ['main'] },
  ]);
  assert.equal(rail.filter(r => r.name === 'main').length, 1);
  assert.equal(rail[0].tipSha, 'a');
});

// ── sortRailRefs ─────────────────────────────────────────────────────

test('sortRailRefs orders by group, HEAD-first within branches, then name', () => {
  const rail = buildRefRail([
    { sha: '1', refs: ['zeta', 'HEAD -> main', 'alpha'] },
    { sha: '2', refs: ['tag: v2', 'origin/feat'] },
  ]);
  const sorted = sortRailRefs(rail);
  assert.deepEqual(
    sorted.map(r => `${r.group}:${r.name}`),
    ['branch:main', 'branch:alpha', 'branch:zeta', 'remote:origin/feat', 'tag:v2'],
  );
  // HEAD branch sorts first regardless of alphabetical order.
  assert.equal(sorted[0].isHead, true);
});

// ── buildRailSections ────────────────────────────────────────────────

test('buildRailSections groups into labelled, non-empty sections', () => {
  const sections = buildRailSections(COMMITS);
  // main -> branch (1); origin/main + feature/login (slash) -> remote (2);
  // v1.0.0 -> tag (1).
  assert.deepEqual(
    sections.map(s => [s.group, s.label, s.refs.length]),
    [
      ['branch', 'Branches', 1],
      ['remote', 'Remotes', 2],
      ['tag', 'Tags', 1],
    ],
  );
});

test('buildRailSections omits empty groups', () => {
  const sections = buildRailSections([{ sha: 'a', refs: ['main'] }]);
  assert.deepEqual(sections.map(s => s.group), ['branch']);
});

// ── refQuery ─────────────────────────────────────────────────────────

test('refQuery builds a ref: term, quoting only when needed', () => {
  assert.equal(refQuery({ name: 'main', group: 'branch', isHead: true, tipSha: 'x' }), 'ref:main');
  assert.equal(refQuery({ name: 'origin/feat', group: 'remote', isHead: false, tipSha: 'x' }), 'ref:origin/feat');
  assert.equal(refQuery({ name: 'has space', group: 'branch', isHead: false, tipSha: 'x' }), 'ref:"has space"');
});
