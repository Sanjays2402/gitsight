import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractConflicts,
  applyResolution,
  classifyDifficulty,
  describeBlockForPicker,
} from '../../src/git/conflictCoach';

const SIMPLE_CONFLICT = [
  'line before',
  '<<<<<<< HEAD',
  'our line 1',
  'our line 2',
  '=======',
  'their line 1',
  '>>>>>>> feature/x',
  'line after',
].join('\n');

const DIFF3_CONFLICT = [
  '<<<<<<< HEAD',
  'ours',
  '||||||| merged common ancestor',
  'base',
  '=======',
  'theirs',
  '>>>>>>> feature/x',
].join('\n');

const TWO_CONFLICTS = [
  'pre',
  '<<<<<<< HEAD',
  'A1',
  '=======',
  'A2',
  '>>>>>>> feature',
  'mid',
  '<<<<<<< HEAD',
  'B1',
  '=======',
  'B2',
  '>>>>>>> feature',
  'post',
].join('\n');

// ── extractConflicts ──────────────────────────────────────────────

test('extractConflicts: empty body', () => {
  assert.deepEqual(extractConflicts(''), []);
});

test('extractConflicts: simple two-way diff', () => {
  const ex = extractConflicts(SIMPLE_CONFLICT);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].oursContent, 'our line 1\nour line 2');
  assert.equal(ex[0].theirsContent, 'their line 1');
  assert.equal(ex[0].baseContent, '');
  assert.equal(ex[0].hasBase, false);
  assert.equal(ex[0].wellFormed, true);
});

test('extractConflicts: diff3 with base block', () => {
  const ex = extractConflicts(DIFF3_CONFLICT);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].oursContent, 'ours');
  assert.equal(ex[0].baseContent, 'base');
  assert.equal(ex[0].theirsContent, 'theirs');
  assert.equal(ex[0].hasBase, true);
});

test('extractConflicts: two blocks in one file', () => {
  const ex = extractConflicts(TWO_CONFLICTS);
  assert.equal(ex.length, 2);
  assert.equal(ex[0].oursContent, 'A1');
  assert.equal(ex[1].oursContent, 'B1');
  assert.equal(ex[1].theirsContent, 'B2');
});

test('extractConflicts: ref names recorded on block', () => {
  const ex = extractConflicts(SIMPLE_CONFLICT);
  assert.equal(ex[0].block.oursRef, 'HEAD');
  assert.equal(ex[0].block.theirsRef, 'feature/x');
});

test('extractConflicts: malformed block (no end) flagged as not wellFormed', () => {
  const body = '<<<<<<< HEAD\nfoo\n=======\nbar\n';
  const ex = extractConflicts(body);
  // No `>>>>>>>` marker -> wellFormed = false
  assert.equal(ex.length, 1);
  assert.equal(ex[0].wellFormed, false);
});

// ── applyResolution ───────────────────────────────────────────────

test('applyResolution: take ours', () => {
  const r = applyResolution(SIMPLE_CONFLICT, 0, 'ours');
  assert.ok(r.includes('our line 1'));
  assert.ok(r.includes('our line 2'));
  assert.ok(!r.includes('<<<<<<<'));
  assert.ok(!r.includes('their line 1'));
});

test('applyResolution: take theirs', () => {
  const r = applyResolution(SIMPLE_CONFLICT, 0, 'theirs');
  assert.ok(r.includes('their line 1'));
  assert.ok(!r.includes('our line 1'));
});

test('applyResolution: both-ours-theirs', () => {
  const r = applyResolution(SIMPLE_CONFLICT, 0, 'both-ours-theirs');
  const oursPos = r.indexOf('our line 1');
  const theirsPos = r.indexOf('their line 1');
  assert.ok(oursPos > -1 && theirsPos > -1 && oursPos < theirsPos);
});

test('applyResolution: both-theirs-ours', () => {
  const r = applyResolution(SIMPLE_CONFLICT, 0, 'both-theirs-ours');
  const oursPos = r.indexOf('our line 1');
  const theirsPos = r.indexOf('their line 1');
  assert.ok(theirsPos > -1 && oursPos > -1 && theirsPos < oursPos);
});

test('applyResolution: surrounding lines preserved', () => {
  const r = applyResolution(SIMPLE_CONFLICT, 0, 'ours');
  assert.ok(r.startsWith('line before'));
  assert.ok(r.endsWith('line after'));
});

test('applyResolution: targets correct block when multiple', () => {
  const r = applyResolution(TWO_CONFLICTS, 1, 'ours');
  // Block 0 still conflicted, block 1 resolved to B1.
  assert.ok(r.includes('<<<<<<< HEAD'));
  assert.ok(r.includes('A1'));
  assert.ok(r.includes('A2'));
  assert.ok(r.includes('B1'));
  assert.ok(!r.includes('B2'));
});

test('applyResolution: out-of-range index throws', () => {
  assert.throws(() => applyResolution(SIMPLE_CONFLICT, 5, 'ours'), RangeError);
});

test('applyResolution: malformed block returns body verbatim', () => {
  const body = '<<<<<<< HEAD\nfoo\n=======\nbar\n';
  const r = applyResolution(body, 0, 'ours');
  assert.equal(r, body);
});

test('applyResolution: diff3-style preserves correctness', () => {
  const r = applyResolution(DIFF3_CONFLICT, 0, 'theirs');
  assert.ok(r.includes('theirs'));
  assert.ok(!r.includes('ours'));
  assert.ok(!r.includes('||||||| '));
});

test('applyResolution: empty ours + both-ours-theirs yields theirs only', () => {
  const body = '<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> X';
  const r = applyResolution(body, 0, 'both-ours-theirs');
  assert.equal(r.trim(), 'theirs');
});

// ── classifyDifficulty ────────────────────────────────────────────

test('classifyDifficulty: identical sides -> trivial, take ours', () => {
  const ex = extractConflicts('<<<<<<< HEAD\nfoo\n=======\nfoo\n>>>>>>> X')[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'trivial');
  assert.equal(d.suggestion, 'ours');
});

test('classifyDifficulty: ours empty + base empty (diff3) -> take theirs', () => {
  const ex = extractConflicts('<<<<<<< HEAD\n||||||| base\n=======\nfoo\n>>>>>>> X')[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'trivial');
  assert.equal(d.suggestion, 'theirs');
});

test('classifyDifficulty: theirs empty + base empty -> take ours', () => {
  const ex = extractConflicts('<<<<<<< HEAD\nfoo\n||||||| base\n=======\n>>>>>>> X')[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'trivial');
  assert.equal(d.suggestion, 'ours');
});

test('classifyDifficulty: ours matches base (diff3) -> take theirs', () => {
  const body = [
    '<<<<<<< HEAD',
    'unchanged',
    '||||||| base',
    'unchanged',
    '=======',
    'updated',
    '>>>>>>> X',
  ].join('\n');
  const ex = extractConflicts(body)[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'trivial');
  assert.equal(d.suggestion, 'theirs');
});

test('classifyDifficulty: theirs matches base -> take ours', () => {
  const body = [
    '<<<<<<< HEAD',
    'updated',
    '||||||| base',
    'original',
    '=======',
    'original',
    '>>>>>>> X',
  ].join('\n');
  const ex = extractConflicts(body)[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'trivial');
  assert.equal(d.suggestion, 'ours');
});

test('classifyDifficulty: small blocks -> small (no suggestion)', () => {
  const body = '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> X';
  const ex = extractConflicts(body)[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'small');
  assert.equal(d.suggestion, undefined);
});

test('classifyDifficulty: moderate when 10-50 lines per side', () => {
  const ours = Array.from({ length: 25 }, (_, i) => `o${i}`).join('\n');
  const theirs = Array.from({ length: 25 }, (_, i) => `t${i}`).join('\n');
  const body = `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> X`;
  const ex = extractConflicts(body)[0];
  assert.equal(classifyDifficulty(ex).level, 'moderate');
});

test('classifyDifficulty: large when 50+ lines per side', () => {
  const ours = Array.from({ length: 60 }, (_, i) => `o${i}`).join('\n');
  const theirs = Array.from({ length: 60 }, (_, i) => `t${i}`).join('\n');
  const body = `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> X`;
  const ex = extractConflicts(body)[0];
  assert.equal(classifyDifficulty(ex).level, 'large');
});

test('classifyDifficulty: malformed -> large + reason', () => {
  const ex = extractConflicts('<<<<<<< HEAD\nfoo\n=======\nbar\n')[0];
  const d = classifyDifficulty(ex);
  assert.equal(d.level, 'large');
  assert.ok(d.reasons.some(r => /malformed/i.test(r)));
});

// ── describeBlockForPicker ────────────────────────────────────────

test('describeBlockForPicker: includes index, path, line counts, level', () => {
  const ex = extractConflicts(SIMPLE_CONFLICT)[0];
  const label = describeBlockForPicker(ex, 0, 2, 'src/foo.ts');
  assert.ok(label.includes('Conflict 1/2'));
  assert.ok(label.includes('src/foo.ts'));
  assert.ok(label.includes('2/1 lines'));
});

test('describeBlockForPicker: trivial level surfaces suggestion', () => {
  const body = '<<<<<<< HEAD\nfoo\n=======\nfoo\n>>>>>>> X';
  const ex = extractConflicts(body)[0];
  const label = describeBlockForPicker(ex, 0, 1, 'a.ts');
  assert.ok(label.includes('trivial'));
  assert.ok(label.includes('take ours'));
});
