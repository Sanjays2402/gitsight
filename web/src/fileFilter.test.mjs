/**
 * Path-substring file-filter tests (W50).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizeFileQuery,
  fileMatchesQuery,
  filterFileChanges,
} from './fileFilter.ts';

const files = [
  { path: 'src/app/main.ts' },
  { path: 'src/app/graph.ts' },
  { path: 'README.md' },
  { path: 'src/views/blame.ts', oldPath: 'src/old/blame.ts' },
];

// ── normalizeFileQuery ───────────────────────────────────────────────

test('normalizeFileQuery trims + lowercases', () => {
  assert.equal(normalizeFileQuery('  SRC/App '), 'src/app');
  assert.equal(normalizeFileQuery(''), '');
  assert.equal(normalizeFileQuery('   '), '');
});

// ── fileMatchesQuery ─────────────────────────────────────────────────

test('fileMatchesQuery matches a case-insensitive path substring', () => {
  assert.equal(fileMatchesQuery({ path: 'src/app/main.ts' }, 'MAIN'), true);
  assert.equal(fileMatchesQuery({ path: 'src/app/main.ts' }, 'app/'), true);
  assert.equal(fileMatchesQuery({ path: 'src/app/main.ts' }, 'nope'), false);
});

test('fileMatchesQuery matches the old path of a rename', () => {
  const f = { path: 'src/views/blame.ts', oldPath: 'src/old/blame.ts' };
  // Matches via the new path...
  assert.equal(fileMatchesQuery(f, 'views'), true);
  // ...and via the old path (so searching either side keeps a rename).
  assert.equal(fileMatchesQuery(f, 'old/'), true);
});

test('fileMatchesQuery returns true for an empty/whitespace query', () => {
  assert.equal(fileMatchesQuery({ path: 'anything' }, ''), true);
  assert.equal(fileMatchesQuery({ path: 'anything' }, '   '), true);
});

// ── filterFileChanges ────────────────────────────────────────────────

test('filterFileChanges narrows to matching paths, preserving order', () => {
  const out = filterFileChanges(files, 'src/app');
  assert.deepEqual(out.map(f => f.path), ['src/app/main.ts', 'src/app/graph.ts']);
});

test('filterFileChanges returns a copy of the full list for an empty query', () => {
  const out = filterFileChanges(files, '');
  assert.equal(out.length, files.length);
  assert.notEqual(out, files); // new array, not the same reference
  assert.deepEqual(out, files);
});

test('filterFileChanges returns the same objects (identity preserved)', () => {
  const out = filterFileChanges(files, 'readme');
  assert.equal(out.length, 1);
  assert.equal(out[0], files[2]); // same object reference
});

test('filterFileChanges returns empty when nothing matches', () => {
  assert.deepEqual(filterFileChanges(files, 'zzz'), []);
});
