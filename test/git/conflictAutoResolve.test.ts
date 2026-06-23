import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildAutoResolvePlan,
  applyAutoResolvePlan,
  buildPlanMarkdown,
  countDifficulties,
  countRemaining,
  describeAutoResolveOutcome,
} from '../../src/git/conflictAutoResolve';
import { extractConflicts } from '../../src/git/conflictCoach';

// ── fixtures ──────────────────────────────────────────────────────

const TRIVIAL_IDENTICAL = [
  'pre',
  '<<<<<<< HEAD',
  'identical',
  '=======',
  'identical',
  '>>>>>>> feature/x',
  'post',
].join('\n');

const TRIVIAL_DIFF3_OURS_MATCHES_BASE = [
  '<<<<<<< HEAD',
  'common',
  '||||||| base',
  'common',
  '=======',
  'theirs added this',
  '>>>>>>> feature/x',
].join('\n');

const NON_TRIVIAL_TWO_SIDED = [
  '<<<<<<< HEAD',
  'we wrote this',
  'and this',
  'and a third',
  'and a fourth',
  'and a fifth',
  '=======',
  'they wrote something completely different',
  'with different lines',
  'and another',
  '>>>>>>> feature/x',
].join('\n');

const MIXED = [
  'pre',
  '<<<<<<< HEAD',
  'same',
  '=======',
  'same',
  '>>>>>>> feature/x',
  'mid1',
  '<<<<<<< HEAD',
  'completely different one',
  'completely different two',
  'completely different three',
  'completely different four',
  'completely different five',
  '=======',
  'utterly different one',
  'utterly different two',
  'utterly different three',
  'utterly different four',
  'utterly different five',
  '>>>>>>> feature/x',
  'mid2',
  '<<<<<<< HEAD',
  'whitespace  ',
  '=======',
  'whitespace',
  '>>>>>>> feature/x',
  'post',
].join('\n');

// ── buildAutoResolvePlan ──────────────────────────────────────────

test('buildAutoResolvePlan: empty body has no entries', () => {
  const p = buildAutoResolvePlan('');
  assert.equal(p.entries.length, 0);
  assert.equal(p.totalBlocks, 0);
});

test('buildAutoResolvePlan: trivial identical -> 1 entry taking ours', () => {
  const p = buildAutoResolvePlan(TRIVIAL_IDENTICAL);
  assert.equal(p.totalBlocks, 1);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].choice, 'ours');
  assert.equal(p.entries[0].blockIndex, 0);
  assert.ok(p.entries[0].reason.toLowerCase().includes('identical'));
});

test('buildAutoResolvePlan: diff3 ours-matches-base -> take theirs', () => {
  const p = buildAutoResolvePlan(TRIVIAL_DIFF3_OURS_MATCHES_BASE);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].choice, 'theirs');
});

test('buildAutoResolvePlan: non-trivial block has no entry', () => {
  const p = buildAutoResolvePlan(NON_TRIVIAL_TWO_SIDED);
  assert.equal(p.totalBlocks, 1);
  assert.equal(p.entries.length, 0);
  // The fixture has 5 vs 3 lines (maxLines=5, diff=2). F107 classifier
  // rule: maxLines<10 && diff<5 -> 'small'. Anything bigger jumps to
  // moderate. The assertion guards against accidentally re-tuning the
  // heuristic in a way that turns small files into trivial ones (which
  // would be a correctness bug -- "small" still needs human eyes).
  assert.equal(p.difficulties[0], 'small');
});

test('buildAutoResolvePlan: mixed file finds trivial blocks at index 0 and 2', () => {
  const p = buildAutoResolvePlan(MIXED);
  assert.equal(p.totalBlocks, 3);
  assert.deepEqual(p.entries.map(e => e.blockIndex).sort(), [0, 2]);
  // Block 1 is non-trivial.
  assert.notEqual(p.difficulties[1], 'trivial');
});

test('buildAutoResolvePlan: startLine is 1-based for the report', () => {
  const p = buildAutoResolvePlan(TRIVIAL_IDENTICAL);
  // The conflict marker is on the 2nd line ('<<<<<<<') -- 1-based = 2.
  assert.equal(p.entries[0].startLine, 2);
});

// ── applyAutoResolvePlan ──────────────────────────────────────────

test('applyAutoResolvePlan: identical block resolves to ours content', () => {
  const plan = buildAutoResolvePlan(TRIVIAL_IDENTICAL);
  const r = applyAutoResolvePlan(TRIVIAL_IDENTICAL, plan);
  assert.equal(r.resolvedCount, 1);
  assert.equal(r.skippedCount, 0);
  assert.ok(!r.body.includes('<<<<<<<'));
  assert.ok(!r.body.includes('>>>>>>>'));
  assert.ok(r.body.includes('identical'));
  // The pre and post anchors are preserved.
  assert.ok(r.body.startsWith('pre'));
  assert.ok(r.body.includes('post'));
});

test('applyAutoResolvePlan: diff3 ours-matches-base resolves to theirs', () => {
  const plan = buildAutoResolvePlan(TRIVIAL_DIFF3_OURS_MATCHES_BASE);
  const r = applyAutoResolvePlan(TRIVIAL_DIFF3_OURS_MATCHES_BASE, plan);
  assert.equal(r.resolvedCount, 1);
  assert.ok(r.body.includes('theirs added this'));
  assert.ok(!r.body.includes('common\n'));
  assert.ok(!r.body.includes('<<<<<<<'));
});

test('applyAutoResolvePlan: mixed file resolves only trivial blocks', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const r = applyAutoResolvePlan(MIXED, plan);
  assert.equal(r.resolvedCount, 2);
  // The non-trivial middle block should STILL have conflict markers.
  assert.ok(r.body.includes('<<<<<<<'));
  assert.ok(r.body.includes('>>>>>>>'));
  assert.ok(r.body.includes('completely different one'));
  // The identical block should have been resolved -> body still includes
  // "same" but no longer wrapped in markers near it.
  assert.ok(r.body.includes('same'));
});

test('applyAutoResolvePlan: file with no entries returns body unchanged', () => {
  const plan = buildAutoResolvePlan(NON_TRIVIAL_TWO_SIDED);
  const r = applyAutoResolvePlan(NON_TRIVIAL_TWO_SIDED, plan);
  assert.equal(r.body, NON_TRIVIAL_TWO_SIDED);
  assert.equal(r.resolvedCount, 0);
});

test('applyAutoResolvePlan: order independence -- resolving the last block first does NOT corrupt earlier blocks', () => {
  // The MIXED body has trivial blocks at index 0 and 2. The internal
  // strategy sorts descending so block 2 is resolved BEFORE block 0.
  // If the order were wrong, the resolution of block 0 would shift the
  // line numbers and we'd see double-resolution / missed-markers.
  const plan = buildAutoResolvePlan(MIXED);
  const r = applyAutoResolvePlan(MIXED, plan);
  // After resolving the two trivial blocks, exactly 1 conflict should
  // remain (the non-trivial middle one).
  const remaining = extractConflicts(r.body);
  assert.equal(remaining.length, 1);
  // ALL outcomes should be 'resolved' (none skipped).
  assert.ok(r.outcomes.every(o => o.status === 'resolved'));
});

test('applyAutoResolvePlan: outcomes are reported in block-index order (not internal apply order)', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const r = applyAutoResolvePlan(MIXED, plan);
  const indices = r.outcomes.map(o => o.entry.blockIndex);
  const sorted = [...indices].sort((a, b) => a - b);
  assert.deepEqual(indices, sorted);
});

// ── buildPlanMarkdown ─────────────────────────────────────────────

test('buildPlanMarkdown: empty plan reports nothing to auto-resolve', () => {
  const plan = buildAutoResolvePlan(NON_TRIVIAL_TWO_SIDED);
  const md = buildPlanMarkdown('src/foo.ts', plan);
  assert.ok(md.toLowerCase().includes('no trivial'));
  assert.ok(md.includes('1 block'));
});

test('buildPlanMarkdown: lists each entry with line + choice + reason', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const md = buildPlanMarkdown('src/foo.ts', plan);
  assert.ok(md.includes('src/foo.ts'));
  assert.ok(md.includes('| Line |'));
  assert.ok(md.includes('take ours'));
  // 2 trivial entries means 2 data rows after the table header.
  const dataRows = md.split('\n').filter(l => /^\| \d+ \|/.test(l));
  assert.equal(dataRows.length, plan.entries.length);
});

test('buildPlanMarkdown: mentions remaining-non-trivial when applicable', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const md = buildPlanMarkdown('src/foo.ts', plan);
  assert.ok(md.toLowerCase().includes('remain'));
});

// ── countDifficulties ─────────────────────────────────────────────

test('countDifficulties: tallies all 4 buckets', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const c = countDifficulties(plan);
  // 2 trivial (block 0 + block 2), 1 moderate or large (block 1).
  assert.equal(c.trivial, 2);
  assert.equal(c.trivial + c.small + c.moderate + c.large, plan.totalBlocks);
});

// ── countRemaining ────────────────────────────────────────────────

test('countRemaining: after applying plan, returns non-trivial count', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const r = applyAutoResolvePlan(MIXED, plan);
  assert.equal(countRemaining(r.body), 1);
});

test('countRemaining: file with no conflicts returns 0', () => {
  assert.equal(countRemaining('clean file body\nno markers'), 0);
});

// ── describeAutoResolveOutcome ────────────────────────────────────

test('describeAutoResolveOutcome: zero resolved reports no-trivial', () => {
  const plan = buildAutoResolvePlan(NON_TRIVIAL_TWO_SIDED);
  const r = applyAutoResolvePlan(NON_TRIVIAL_TWO_SIDED, plan);
  const msg = describeAutoResolveOutcome('src/foo.ts', r, 1);
  assert.ok(msg.toLowerCase().includes('no trivial'));
});

test('describeAutoResolveOutcome: all-clear suffix when nothing remains', () => {
  const plan = buildAutoResolvePlan(TRIVIAL_IDENTICAL);
  const r = applyAutoResolvePlan(TRIVIAL_IDENTICAL, plan);
  const msg = describeAutoResolveOutcome('src/foo.ts', r, 0);
  assert.ok(msg.toLowerCase().includes('clear') || msg.toLowerCase().includes('all'));
});

test('describeAutoResolveOutcome: mentions remaining count when > 0', () => {
  const plan = buildAutoResolvePlan(MIXED);
  const r = applyAutoResolvePlan(MIXED, plan);
  const remaining = countRemaining(r.body);
  const msg = describeAutoResolveOutcome('src/foo.ts', r, remaining);
  assert.ok(msg.includes(`${remaining} remaining`));
});

test('describeAutoResolveOutcome: singular vs plural conflict noun', () => {
  const plan = buildAutoResolvePlan(TRIVIAL_IDENTICAL);
  const r = applyAutoResolvePlan(TRIVIAL_IDENTICAL, plan);
  const msg = describeAutoResolveOutcome('src/foo.ts', r, 0);
  assert.ok(msg.includes('1 trivial conflict on'));
});
