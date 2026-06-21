import { test } from 'node:test';
import { strict as assert } from 'node:assert';
// gitsight-disable-conflict-marker (this test exercises marker detection
// and so contains literal marker strings).
import {
  findMarkers,
  groupBlocks,
  findConflicts,
  isWellFormed,
  nextBlockLine,
  previousBlockLine,
} from '../../src/git/conflictMarkers';

const SAMPLE = [
  'line one',
  '<<<<<<< HEAD',
  'ours version',
  '=======',
  'theirs version',
  '>>>>>>> feature/x',
  'tail',
].join('\n');

test('findMarkers: detects start, separator, end with refnames', () => {
  const m = findMarkers(SAMPLE);
  assert.equal(m.length, 3);
  assert.equal(m[0].kind, 'start');
  assert.equal(m[0].line, 1);
  assert.equal(m[0].refName, 'HEAD');
  assert.equal(m[1].kind, 'separator');
  assert.equal(m[1].line, 3);
  assert.equal(m[1].refName, '');
  assert.equal(m[2].kind, 'end');
  assert.equal(m[2].line, 5);
  assert.equal(m[2].refName, 'feature/x');
});

test('findMarkers: requires exactly seven of the glyph (rejects 8+ and 6 or fewer)', () => {
  const text = [
    '<<<<<<<< HEAD',  // 8 — not a marker
    '<<<<<< HEAD',    // 6 — not a marker
    '======',          // 6 — not a marker
    '========',        // 8 — not a marker
    '<<<<<<< HEAD',   // 7 — IS a marker
  ].join('\n');
  const m = findMarkers(text);
  assert.equal(m.length, 1);
  assert.equal(m[0].line, 4);
});

test('findMarkers: handles CRLF line endings', () => {
  const text = '<<<<<<< HEAD\r\n=======\r\n>>>>>>> b\r\n';
  const m = findMarkers(text);
  assert.deepEqual(m.map(x => x.kind), ['start', 'separator', 'end']);
  assert.equal(m[2].refName, 'b');
});

test('findMarkers: picks up diff3 base marker (|||||||)', () => {
  const text = ['<<<<<<< HEAD', 'a', '||||||| common-ancestor', 'base', '=======', 'b', '>>>>>>> x'].join('\n');
  const m = findMarkers(text);
  assert.equal(m.length, 4);
  assert.equal(m[1].kind, 'base');
  assert.equal(m[1].refName, 'common-ancestor');
});

test('groupBlocks: builds a single well-formed block', () => {
  const blocks = findConflicts(SAMPLE);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], {
    startLine: 1, separatorLine: 3, endLine: 5, baseLine: -1,
    oursRef: 'HEAD', theirsRef: 'feature/x',
  });
  assert.equal(isWellFormed(blocks[0]), true);
});

test('groupBlocks: malformed (missing >>>>>>>) is still surfaced with endLine=-1', () => {
  const text = ['<<<<<<< HEAD', 'a', '======='].join('\n');
  const blocks = findConflicts(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].endLine, -1);
  assert.equal(isWellFormed(blocks[0]), false);
});

test('groupBlocks: stray separator before any start is ignored', () => {
  const text = ['stray', '=======', '<<<<<<< HEAD', '=======', '>>>>>>> b'].join('\n');
  const blocks = findConflicts(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 2);
});

test('groupBlocks: two back-to-back blocks both captured', () => {
  const text = [
    '<<<<<<< HEAD',
    '=======',
    '>>>>>>> b',
    'mid',
    '<<<<<<< HEAD',
    '|||||||  base',
    '=======',
    '>>>>>>> c',
  ].join('\n');
  const blocks = findConflicts(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].theirsRef, 'b');
  assert.equal(blocks[1].theirsRef, 'c');
  assert.equal(blocks[1].baseLine, 5);
});

test('nextBlockLine / previousBlockLine: navigate with wrap', () => {
  const blocks = [
    { startLine: 5, separatorLine: 7, endLine: 9, baseLine: -1, oursRef: 'HEAD', theirsRef: 'a' },
    { startLine: 20, separatorLine: 22, endLine: 24, baseLine: -1, oursRef: 'HEAD', theirsRef: 'b' },
  ];
  assert.equal(nextBlockLine(0, blocks), 5);
  assert.equal(nextBlockLine(5, blocks), 20);     // already on first → goes to next
  assert.equal(nextBlockLine(25, blocks), 5);     // past last → wrap
  assert.equal(previousBlockLine(25, blocks), 20);
  assert.equal(previousBlockLine(10, blocks), 5);
  assert.equal(previousBlockLine(0, blocks), 20); // wrap backwards
});

test('nextBlockLine: returns undefined when there are no blocks', () => {
  assert.equal(nextBlockLine(0, []), undefined);
  assert.equal(previousBlockLine(0, []), undefined);
});

test('isWellFormed: separator must come after start, end after separator', () => {
  assert.equal(isWellFormed({ startLine: 0, separatorLine: 1, endLine: 2, baseLine: -1, oursRef: 'a', theirsRef: 'b' }), true);
  assert.equal(isWellFormed({ startLine: 5, separatorLine: 3, endLine: 7, baseLine: -1, oursRef: 'a', theirsRef: 'b' }), false);
  assert.equal(isWellFormed({ startLine: 0, separatorLine: 2, endLine: 1, baseLine: -1, oursRef: 'a', theirsRef: 'b' }), false);
});
