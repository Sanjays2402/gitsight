import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  findStagedMarkers,
  classifyMarkerLine,
  groupByFile,
  summarisePill,
  tooltipLines,
  firstMarkerLine,
} from '../../src/git/stagedConflictGate';

const diffWithMarkers = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index aaa..bbb 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,0 +10,6 @@',
  '+<<<<<<< HEAD',
  '+const ours = 1;',
  '+=======',
  '+const theirs = 2;',
  '+>>>>>>> feature/x',
  '+const after = 3;',
  '',
  'diff --git a/src/bar.ts b/src/bar.ts',
  'index ccc..ddd 100644',
  '--- a/src/bar.ts',
  '+++ b/src/bar.ts',
  '@@ -50,0 +50,3 @@',
  '+<<<<<<< HEAD',
  '+=======',
  '+>>>>>>> origin/main',
].join('\n');

test('classifyMarkerLine recognises all four marker kinds', () => {
  assert.deepEqual(classifyMarkerLine('<<<<<<< HEAD'), { kind: 'start', refName: 'HEAD' });
  assert.deepEqual(classifyMarkerLine('======='), { kind: 'separator', refName: '' });
  assert.deepEqual(classifyMarkerLine('>>>>>>> feature/x'), { kind: 'end', refName: 'feature/x' });
  assert.deepEqual(classifyMarkerLine('||||||| base'), { kind: 'base', refName: 'base' });
});

test('classifyMarkerLine rejects bare angle brackets and partial matches', () => {
  assert.equal(classifyMarkerLine('<<<<'), undefined);
  assert.equal(classifyMarkerLine('<<<<<<<<<<<'), undefined); // 11 brackets
  assert.equal(classifyMarkerLine('======'), undefined);     // 6 equals
  assert.equal(classifyMarkerLine('========'), undefined);   // 8 equals
  assert.equal(classifyMarkerLine('not a marker'), undefined);
});

test('classifyMarkerLine tolerates a trailing CR', () => {
  assert.deepEqual(classifyMarkerLine('=======\r'), { kind: 'separator', refName: '' });
  assert.deepEqual(classifyMarkerLine('<<<<<<< HEAD\r'), { kind: 'start', refName: 'HEAD' });
});

test('findStagedMarkers extracts markers from a multi-file diff with correct line numbers', () => {
  const found = findStagedMarkers(diffWithMarkers);
  // Two files; foo.ts has three markers (start, separator, end), bar.ts has three.
  assert.equal(found.length, 6);
  // First three are in foo.ts, starting at line 10.
  assert.equal(found[0].path, 'src/foo.ts');
  assert.equal(found[0].kind, 'start');
  assert.equal(found[0].line, 10);
  assert.equal(found[0].refName, 'HEAD');
  assert.equal(found[1].path, 'src/foo.ts');
  assert.equal(found[1].kind, 'separator');
  assert.equal(found[1].line, 12);
  assert.equal(found[2].path, 'src/foo.ts');
  assert.equal(found[2].kind, 'end');
  assert.equal(found[2].line, 14);
  assert.equal(found[2].refName, 'feature/x');
  // Then three in bar.ts starting at line 50.
  assert.equal(found[3].path, 'src/bar.ts');
  assert.equal(found[3].line, 50);
  assert.equal(found[5].path, 'src/bar.ts');
  assert.equal(found[5].kind, 'end');
  assert.equal(found[5].refName, 'origin/main');
});

test('findStagedMarkers ignores markers that appear only in the "-" side (resolution)', () => {
  // A user staging the RESOLUTION of a conflict: the `<<<<<<<` only
  // appears in the `-` lines (the old conflicted version), and the new
  // file has none of those markers.
  const resolution = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index aaa..bbb 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -10,5 +10,1 @@',
    '-<<<<<<< HEAD',
    '-const ours = 1;',
    '-=======',
    '-const theirs = 2;',
    '->>>>>>> feature/x',
    '+const resolved = 1;',
  ].join('\n');
  const found = findStagedMarkers(resolution);
  // No markers on the `+` side — the resolution path is correctly silent.
  assert.equal(found.length, 0);
});

test('findStagedMarkers returns empty for empty input', () => {
  assert.deepEqual(findStagedMarkers(''), []);
  assert.deepEqual(findStagedMarkers('not a diff'), []);
});

test('findStagedMarkers resets hunkLine across files (no bleed)', () => {
  // foo.ts hunk has a marker at line 10. bar.ts then has a marker at line 5.
  // We must NOT compute bar.ts line as (10 + 5).
  const multi = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -10,0 +10,1 @@',
    '+<<<<<<< HEAD',
    'diff --git a/src/bar.ts b/src/bar.ts',
    '--- a/src/bar.ts',
    '+++ b/src/bar.ts',
    '@@ -5,0 +5,1 @@',
    '+=======',
  ].join('\n');
  const found = findStagedMarkers(multi);
  assert.equal(found.length, 2);
  assert.equal(found[0].path, 'src/foo.ts');
  assert.equal(found[0].line, 10);
  assert.equal(found[1].path, 'src/bar.ts');
  assert.equal(found[1].line, 5);
});

test('groupByFile sorts files alphabetically and tallies kinds', () => {
  const found = findStagedMarkers(diffWithMarkers);
  const groups = groupByFile(found);
  // bar.ts comes first alphabetically.
  assert.equal(groups[0].path, 'src/bar.ts');
  assert.equal(groups[1].path, 'src/foo.ts');
  // Each well-formed conflict has 1 start + 1 separator + 1 end.
  assert.equal(groups[0].byKind.start, 1);
  assert.equal(groups[0].byKind.separator, 1);
  assert.equal(groups[0].byKind.end, 1);
  assert.equal(groups[0].byKind.base, 0);
});

test('groupByFile orders markers within a file by line', () => {
  const out: ReturnType<typeof groupByFile> = groupByFile([
    { path: 'src/a.ts', line: 30, kind: 'end', refName: 'x' },
    { path: 'src/a.ts', line: 10, kind: 'start', refName: 'HEAD' },
    { path: 'src/a.ts', line: 20, kind: 'separator', refName: '' },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].markers.map(m => m.line), [10, 20, 30]);
});

test('summarisePill uses start-count as the conflict count', () => {
  const findings = groupByFile(findStagedMarkers(diffWithMarkers));
  const summary = summarisePill(findings);
  assert.equal(summary, '2 conflicts in 2 staged files');
});

test('summarisePill singularises labels for a single conflict in a single file', () => {
  const summary = summarisePill([{
    path: 'src/x.ts',
    markers: [{ path: 'src/x.ts', line: 1, kind: 'start', refName: 'HEAD' }],
    byKind: { start: 1, separator: 0, end: 0, base: 0 },
  }]);
  assert.equal(summary, '1 conflict in 1 staged file');
});

test('tooltipLines renders per-file ref hints', () => {
  const findings = groupByFile(findStagedMarkers(diffWithMarkers));
  const lines = tooltipLines(findings);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('`src/bar.ts`'));
  assert.ok(lines[0].includes('HEAD'));
  assert.ok(lines[0].includes('origin/main'));
  assert.ok(lines[1].includes('`src/foo.ts`'));
});

test('firstMarkerLine returns the line of the first marker', () => {
  const finding = {
    path: 'src/x.ts',
    markers: [
      { path: 'src/x.ts', line: 7, kind: 'start' as const, refName: 'HEAD' },
      { path: 'src/x.ts', line: 12, kind: 'end' as const, refName: 'feat' },
    ],
    byKind: { start: 1, separator: 0, end: 1, base: 0 },
  };
  assert.equal(firstMarkerLine(finding), 7);
});

test('firstMarkerLine returns undefined for an empty marker list', () => {
  assert.equal(firstMarkerLine({ path: 'x', markers: [], byKind: { start: 0, separator: 0, end: 0, base: 0 } }), undefined);
});
