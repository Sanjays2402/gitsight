/**
 * Commit-detail tests (W6).
 *
 * Pure presentation helpers under node --test. detailFormat.ts imports
 * the shared CommitDetail type via a relative .ts path (Node strips the
 * type at load time).
 *
 *   node --test src/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  statusGlyph,
  statusLabel,
  churnParts,
  splitPath,
  diffstatSummary,
  insertionRatio,
} from './detailFormat.ts';

test('statusGlyph maps every status to a single letter', () => {
  assert.equal(statusGlyph('added'), 'A');
  assert.equal(statusGlyph('modified'), 'M');
  assert.equal(statusGlyph('deleted'), 'D');
  assert.equal(statusGlyph('renamed'), 'R');
  assert.equal(statusGlyph('copied'), 'C');
  assert.equal(statusGlyph('typechange'), 'T');
  assert.equal(statusGlyph('unmerged'), 'U');
  assert.equal(statusGlyph('unknown'), '?');
});

test('statusLabel spells out the terse statuses', () => {
  assert.equal(statusLabel('typechange'), 'type change');
  assert.equal(statusLabel('added'), 'added');
});

test('churnParts renders +/- and recognises binary + mode-only changes', () => {
  assert.equal(churnParts({ binary: true, insertions: -1, deletions: -1, status: 'added', path: 'x' }).text, 'binary');
  assert.equal(churnParts({ binary: false, insertions: 3, deletions: 1, status: 'modified', path: 'x' }).text, '+3 -1');
  assert.equal(churnParts({ binary: false, insertions: 5, deletions: 0, status: 'added', path: 'x' }).text, '+5');
  assert.equal(churnParts({ binary: false, insertions: 0, deletions: 2, status: 'deleted', path: 'x' }).text, '-2');
  // Mode-only / empty change.
  assert.equal(churnParts({ binary: false, insertions: 0, deletions: 0, status: 'modified', path: 'x' }).text, '0');
});

test('churnParts exposes numeric parts for the renderer', () => {
  const p = churnParts({ binary: false, insertions: 4, deletions: 2, status: 'modified', path: 'x' });
  assert.equal(p.insertions, 4);
  assert.equal(p.deletions, 2);
  assert.equal(p.binary, false);
});

test('splitPath separates directory from basename', () => {
  assert.deepEqual(splitPath('src/shared/commitDetail.ts'), { dir: 'src/shared/', name: 'commitDetail.ts' });
  assert.deepEqual(splitPath('README.md'), { dir: '', name: 'README.md' });
  assert.deepEqual(splitPath('a/b/'), { dir: 'a/b/', name: '' });
});

test('diffstatSummary pluralises files and omits zero churn', () => {
  assert.equal(diffstatSummary(1, 0, 0), '1 file');
  assert.equal(diffstatSummary(3, 12, 0), '3 files  +12');
  assert.equal(diffstatSummary(5, 12, 3), '5 files  +12  -3');
  assert.equal(diffstatSummary(2, 0, 4), '2 files  -4');
});

test('insertionRatio is the +/(+ + -) fraction, neutral for binary/empty', () => {
  assert.equal(insertionRatio({ binary: false, insertions: 3, deletions: 1, status: 'modified', path: 'x' }), 0.75);
  assert.equal(insertionRatio({ binary: false, insertions: 0, deletions: 4, status: 'deleted', path: 'x' }), 0);
  assert.equal(insertionRatio({ binary: true, insertions: -1, deletions: -1, status: 'added', path: 'x' }), 0.5);
  assert.equal(insertionRatio({ binary: false, insertions: 0, deletions: 0, status: 'modified', path: 'x' }), 0.5);
});
