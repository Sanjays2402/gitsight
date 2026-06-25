import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  stripDiffPrefix,
  parseHunkHeader,
  parseUnifiedDiff,
  parseSingleFileDiff,
} from '../../src/shared/diffParse';

// ── stripDiffPrefix ──────────────────────────────────────────────────

test('stripDiffPrefix removes a/ and b/ but preserves /dev/null', () => {
  assert.equal(stripDiffPrefix('a/src/x.ts'), 'src/x.ts');
  assert.equal(stripDiffPrefix('b/src/x.ts'), 'src/x.ts');
  assert.equal(stripDiffPrefix('/dev/null'), '/dev/null');
  // Only the first a/ b/ is stripped.
  assert.equal(stripDiffPrefix('a/a/b.ts'), 'a/b.ts');
});

// ── parseHunkHeader ──────────────────────────────────────────────────

test('parseHunkHeader reads counts and an optional section', () => {
  assert.deepEqual(parseHunkHeader('@@ -1,3 +1,4 @@'), {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    section: '',
  });
  assert.deepEqual(parseHunkHeader('@@ -10 +12 @@ function foo()'), {
    oldStart: 10,
    oldLines: 1,
    newStart: 12,
    newLines: 1,
    section: 'function foo()',
  });
  assert.equal(parseHunkHeader('not a hunk'), null);
});

// ── parseUnifiedDiff ─────────────────────────────────────────────────

const MODIFY = [
  'diff --git a/keep.txt b/keep.txt',
  'index de98044..a7bc997 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,3 +1,4 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '+d',
].join('\n');

test('parseUnifiedDiff tracks old/new line numbers and counts', () => {
  const [f] = parseUnifiedDiff(MODIFY);
  assert.equal(f.path, 'keep.txt');
  assert.equal(f.status, 'modified');
  assert.equal(f.binary, false);
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);

  const lines = f.hunks[0].lines;
  assert.deepEqual(
    lines.map(l => [l.kind, l.text, l.oldLine, l.newLine]),
    [
      ['context', 'a', 1, 1],
      ['del', 'b', 2, null],
      ['add', 'B', null, 2],
      ['context', 'c', 3, 3],
      ['add', 'd', null, 4],
    ],
  );
});

const ADD = [
  'diff --git a/added.txt b/added.txt',
  'new file mode 100644',
  'index 0000000..3fafc4e',
  '--- /dev/null',
  '+++ b/added.txt',
  '@@ -0,0 +1,2 @@',
  '+new file',
  '+line2',
].join('\n');

test('parseUnifiedDiff recognises an added file with /dev/null old side', () => {
  const f = parseSingleFileDiff(ADD);
  assert.ok(f);
  assert.equal(f.status, 'added');
  assert.equal(f.path, 'added.txt');
  assert.equal(f.oldPath, 'added.txt'); // /dev/null ignored, b/ side wins
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
});

const RENAME = [
  'diff --git a/old-name.txt b/new-name.txt',
  'similarity index 80%',
  'rename from old-name.txt',
  'rename to new-name.txt',
  'index 1111111..2222222 100644',
  '--- a/old-name.txt',
  '+++ b/new-name.txt',
  '@@ -1,2 +1,3 @@',
  ' keep',
  ' stay',
  '+added',
].join('\n');

test('parseUnifiedDiff captures rename old/new paths and status', () => {
  const f = parseSingleFileDiff(RENAME);
  assert.ok(f);
  assert.equal(f.status, 'renamed');
  assert.equal(f.oldPath, 'old-name.txt');
  assert.equal(f.path, 'new-name.txt');
  assert.equal(f.additions, 1);
});

const BINARY = [
  'diff --git a/blob.bin b/blob.bin',
  'new file mode 100644',
  'index 0000000..c94be36',
  'Binary files /dev/null and b/blob.bin differ',
].join('\n');

test('parseUnifiedDiff flags binary files with no hunks', () => {
  const f = parseSingleFileDiff(BINARY);
  assert.ok(f);
  assert.equal(f.binary, true);
  assert.equal(f.status, 'added');
  assert.equal(f.hunks.length, 0);
});

const DELETE = [
  'diff --git a/del.txt b/del.txt',
  'deleted file mode 100644',
  'index 5555555..0000000 100644',
  '--- a/del.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  '\\ No newline at end of file',
].join('\n');

test('parseUnifiedDiff marks deletions and the no-newline flag', () => {
  const f = parseSingleFileDiff(DELETE);
  assert.ok(f);
  assert.equal(f.status, 'deleted');
  assert.equal(f.deletions, 1);
  const last = f.hunks[0].lines[0];
  assert.equal(last.kind, 'del');
  assert.equal(last.noNewline, true);
});

test('parseUnifiedDiff splits a multi-file diff into separate entries', () => {
  const f = parseUnifiedDiff(MODIFY + '\n' + ADD);
  assert.equal(f.length, 2);
  assert.equal(f[0].path, 'keep.txt');
  assert.equal(f[1].path, 'added.txt');
});

test('parseUnifiedDiff ignores leading commit-message noise', () => {
  const noisy = 'commit abcdef\nAuthor: x\n\n    subject\n\n' + MODIFY;
  const f = parseUnifiedDiff(noisy);
  assert.equal(f.length, 1);
  assert.equal(f[0].path, 'keep.txt');
});

test('parseUnifiedDiff handles multiple hunks in one file', () => {
  const multi = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,2 +1,2 @@',
    ' one',
    '-two',
    '+TWO',
    '@@ -10,2 +10,3 @@ section header',
    ' ten',
    '+eleven',
    ' twelve',
  ].join('\n');
  const f = parseSingleFileDiff(multi);
  assert.ok(f);
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[1].section, 'section header');
  assert.equal(f.hunks[1].newStart, 10);
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
});

test('parseUnifiedDiff returns empty for non-diff text', () => {
  assert.deepEqual(parseUnifiedDiff('just some text\nno diff here'), []);
  assert.equal(parseSingleFileDiff(''), null);
});
