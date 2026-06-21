import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseSelection,
  parseHistoryLog,
  formatHistoryMarkdown,
  formatLArg,
} from '../../src/git/selectionHistory';

test('normaliseSelection: 0-indexed → 1-indexed inclusive', () => {
  // Caret on line 5 (0-indexed 4), end same → both 5.
  assert.deepEqual(normaliseSelection(4, 4, 100), { start: 5, end: 5 });
  // Selection lines 10..20 (0-indexed) → 11..21 (1-indexed).
  assert.deepEqual(normaliseSelection(10, 20, 100), { start: 11, end: 21 });
});

test('normaliseSelection: clamps end to lineCount', () => {
  assert.deepEqual(normaliseSelection(0, 999, 42), { start: 1, end: 42 });
});

test('normaliseSelection: start >= 1', () => {
  // VS Code shouldn't pass negative lines but be defensive.
  assert.deepEqual(normaliseSelection(-3, 0, 10), { start: 1, end: 1 });
});

test('normaliseSelection: handles inverted ranges (end < start)', () => {
  // Defensive: end < start would crash git's -L. We collapse to start = end.
  // 5..3 0-indexed → start = 6, end = max(start, 3+1=4) = 6. Then clamp.
  assert.deepEqual(normaliseSelection(5, 3, 100), { start: 6, end: 6 });
});

test('normaliseSelection: zero-line file', () => {
  // Pathological: no clamping when lineCount = 0.
  assert.deepEqual(normaliseSelection(0, 0, 0), { start: 1, end: 1 });
});

test('parseHistoryLog: parses canonical lines', () => {
  const raw = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|2026-06-20T10:00:00-07:00|feat: extract helper',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|Bob|2026-06-19T14:30:00-07:00|fix(api): handle null',
  ].join('\n');
  const out = parseHistoryLog(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].author, 'Alice');
  assert.equal(out[0].subject, 'feat: extract helper');
});

test('parseHistoryLog: pipe-tolerant subject', () => {
  const raw = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|2026-06-20T10:00:00-07:00|refactor: x | y';
  assert.equal(parseHistoryLog(raw)[0].subject, 'refactor: x | y');
});

test('parseHistoryLog: empty / malformed', () => {
  assert.deepEqual(parseHistoryLog(''), []);
  assert.deepEqual(parseHistoryLog('only-three|fields|here'), []);
});

test('formatLArg: literal git syntax', () => {
  assert.equal(formatLArg({ start: 12, end: 30 }, 'src/foo.ts'), '-L12,30:src/foo.ts');
  // Single-line "range" collapses correctly.
  assert.equal(formatLArg({ start: 5, end: 5 }, 'README.md'), '-L5,5:README.md');
});

test('formatHistoryMarkdown: single-line header, with commits', () => {
  const md = formatHistoryMarkdown('src/foo.ts', { start: 12, end: 12 }, parseHistoryLog([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|2026-06-20T10:00:00-07:00|feat: extract helper',
  ].join('\n')));
  assert.match(md, /# History of src\/foo\.ts L12 \(1 commit\)/);
  assert.match(md, /aaaa1.*feat: extract helper/);
});

test('formatHistoryMarkdown: range header, plural, footer hint', () => {
  const md = formatHistoryMarkdown('src/foo.ts', { start: 12, end: 30 }, parseHistoryLog([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|Alice|2026-06-20T10:00:00-07:00|feat: extract helper',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbb2|Bob|2026-06-19T14:30:00-07:00|fix(api): handle null',
  ].join('\n')));
  assert.match(md, /# History of src\/foo\.ts L12-L30 \(2 commits\)/);
  assert.match(md, /Generated via .git log/);
});

test('formatHistoryMarkdown: empty history → friendly placeholder', () => {
  const md = formatHistoryMarkdown('src/foo.ts', { start: 1, end: 1 }, []);
  assert.match(md, /No history found/);
  assert.match(md, /untracked file/);
});

test('formatHistoryMarkdown: escapes markdown specials in subject/author', () => {
  const md = formatHistoryMarkdown('x.ts', { start: 1, end: 1 }, parseHistoryLog([
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|aaaa1|A_Person|2026-06-20T10:00:00-07:00|feat: **bold** _ish_',
  ].join('\n')));
  // Asterisks/underscores are backslash-escaped.
  assert.match(md, /\\\*\\\*bold\\\*\\\*/);
  assert.match(md, /A\\_Person/);
});
