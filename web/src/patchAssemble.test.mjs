/**
 * Patch-assembler tests (W52).
 *
 *   node --test src/*.test.mjs
 *
 * The strongest property is round-trip: assembling a set of FileDiffs into a
 * patch and re-parsing it (with the shared parseUnifiedDiff) yields back the
 * same files/hunks/lines. We assert that plus the individual formatters.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  formatHunkHeader,
  formatDiffLine,
  assembleFilePatch,
  assemblePatch,
  patchSummary,
} from './patchAssemble.ts';
import { parseUnifiedDiff } from '../../src/shared/diffParse.ts';

/** A small modified-file FileDiff fixture. */
function modifiedFile() {
  return {
    path: 'src/app.ts',
    oldPath: 'src/app.ts',
    status: 'modified',
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        section: 'function main()',
        lines: [
          { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
          { kind: 'del', text: 'const b = 2;', oldLine: 2, newLine: null },
          { kind: 'add', text: 'const b = 3;', oldLine: null, newLine: 2 },
          { kind: 'context', text: 'return a + b;', oldLine: 3, newLine: 3 },
        ],
      },
    ],
  };
}

// ── formatHunkHeader / formatDiffLine ────────────────────────────────

test('formatHunkHeader emits the @@ line with the section', () => {
  assert.equal(
    formatHunkHeader({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, section: 'fn x()' }),
    '@@ -1,3 +1,4 @@ fn x()',
  );
});

test('formatHunkHeader omits an empty section', () => {
  assert.equal(
    formatHunkHeader({ oldStart: 5, oldLines: 2, newStart: 5, newLines: 2, section: '' }),
    '@@ -5,2 +5,2 @@',
  );
});

test('formatDiffLine prefixes +/-/space by kind', () => {
  assert.equal(formatDiffLine({ kind: 'add', text: 'x' }), '+x');
  assert.equal(formatDiffLine({ kind: 'del', text: 'y' }), '-y');
  assert.equal(formatDiffLine({ kind: 'context', text: 'z' }), ' z');
});

// ── assembleFilePatch ────────────────────────────────────────────────

test('assembleFilePatch emits a well-formed modified-file stanza', () => {
  const text = assembleFilePatch(modifiedFile());
  const lines = text.split('\n');
  assert.equal(lines[0], 'diff --git a/src/app.ts b/src/app.ts');
  assert.equal(lines[1], '--- a/src/app.ts');
  assert.equal(lines[2], '+++ b/src/app.ts');
  assert.equal(lines[3], '@@ -1,3 +1,3 @@ function main()');
  assert.ok(text.includes('-const b = 2;'));
  assert.ok(text.includes('+const b = 3;'));
});

test('assembleFilePatch marks an added file with new file mode + /dev/null', () => {
  const f = {
    path: 'NEW.md', oldPath: 'NEW.md', status: 'added', binary: false,
    additions: 1, deletions: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: '', lines: [
      { kind: 'add', text: '# New', oldLine: null, newLine: 1 },
    ] }],
  };
  const text = assembleFilePatch(f);
  assert.ok(text.includes('new file mode 100644'));
  assert.ok(text.includes('--- /dev/null'));
  assert.ok(text.includes('+++ b/NEW.md'));
});

test('assembleFilePatch marks a deleted file with /dev/null on the new side', () => {
  const f = {
    path: 'OLD.md', oldPath: 'OLD.md', status: 'deleted', binary: false,
    additions: 0, deletions: 1,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, section: '', lines: [
      { kind: 'del', text: '# Old', oldLine: 1, newLine: null },
    ] }],
  };
  const text = assembleFilePatch(f);
  assert.ok(text.includes('deleted file mode 100644'));
  assert.ok(text.includes('+++ /dev/null'));
});

test('assembleFilePatch emits a binary marker instead of hunks', () => {
  const f = { path: 'logo.png', oldPath: 'logo.png', status: 'modified', binary: true, additions: 0, deletions: 0, hunks: [] };
  const text = assembleFilePatch(f);
  assert.ok(text.includes('Binary files a/logo.png and b/logo.png differ'));
  assert.ok(!text.includes('@@'));
});

test('assembleFilePatch emits rename lines for a pure rename (no hunks)', () => {
  const f = { path: 'b.ts', oldPath: 'a.ts', status: 'renamed', binary: false, additions: 0, deletions: 0, hunks: [] };
  const text = assembleFilePatch(f);
  assert.ok(text.includes('rename from a.ts'));
  assert.ok(text.includes('rename to b.ts'));
  assert.ok(!text.includes('@@'));
});

test('assembleFilePatch preserves a no-newline marker', () => {
  const f = {
    path: 'x', oldPath: 'x', status: 'modified', binary: false, additions: 1, deletions: 0,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, section: '', lines: [
      { kind: 'add', text: 'last', oldLine: null, newLine: 1, noNewline: true },
    ] }],
  };
  assert.ok(assembleFilePatch(f).includes('\\ No newline at end of file'));
});

// ── assemblePatch (multi-file + round-trip) ──────────────────────────

test('assemblePatch joins multiple files and ends with a newline', () => {
  const out = assemblePatch([modifiedFile(), modifiedFile()]);
  assert.ok(out.endsWith('\n'));
  // Two stanzas -> two diff --git headers.
  assert.equal(out.match(/^diff --git /gm).length, 2);
});

test('assemblePatch returns empty for no files', () => {
  assert.equal(assemblePatch([]), '');
});

test('parseUnifiedDiff(assembleFilePatch(x)) round-trips a modified file', () => {
  const original = modifiedFile();
  // assembleFilePatch returns no trailing newline, so re-parsing it doesn't
  // gain the trailing empty context line that the format terminator (the \n
  // assemblePatch appends for git-apply) would produce.
  const reparsed = parseUnifiedDiff(assembleFilePatch(original));
  assert.equal(reparsed.length, 1);
  const f = reparsed[0];
  assert.equal(f.path, original.path);
  assert.equal(f.status, original.status);
  assert.equal(f.additions, original.additions);
  assert.equal(f.deletions, original.deletions);
  assert.equal(f.hunks.length, 1);
  assert.equal(f.hunks[0].section, original.hunks[0].section);
  assert.deepEqual(
    f.hunks[0].lines.map(l => ({ kind: l.kind, text: l.text })),
    original.hunks[0].lines.map(l => ({ kind: l.kind, text: l.text })),
  );
});

test('round-trip preserves an added + a deleted file across a multi-file patch', () => {
  const added = {
    path: 'NEW.md', oldPath: 'NEW.md', status: 'added', binary: false, additions: 1, deletions: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: '', lines: [
      { kind: 'add', text: '# New', oldLine: null, newLine: 1 },
    ] }],
  };
  const deleted = {
    path: 'OLD.md', oldPath: 'OLD.md', status: 'deleted', binary: false, additions: 0, deletions: 1,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, section: '', lines: [
      { kind: 'del', text: '# Old', oldLine: 1, newLine: null },
    ] }],
  };
  // Strip the format's trailing terminator before re-parsing (see above).
  const reparsed = parseUnifiedDiff(assemblePatch([added, deleted]).replace(/\n$/, ''));
  assert.equal(reparsed.length, 2);
  assert.equal(reparsed[0].status, 'added');
  assert.equal(reparsed[1].status, 'deleted');
});

// ── patchSummary ─────────────────────────────────────────────────────

test('patchSummary sums files + churn', () => {
  assert.equal(patchSummary([modifiedFile(), modifiedFile()]), '2 files, +2 -2');
  assert.equal(patchSummary([modifiedFile()]), '1 file, +1 -1');
});
