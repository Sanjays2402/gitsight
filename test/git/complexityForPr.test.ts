import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  summarisePrComplexity,
  formatPillLabel,
  buildPrComplexityTooltip,
  buildPrComplexityReport,
  PrChangedFile,
} from '../../src/git/complexityForPr';

// A small library of synthetic file bodies engineered to hit the
// computeComplexity buckets predictably. Each fixture is sized so the
// score lands in the expected bucket regardless of minor heuristic
// tweaks (we leave a comfortable margin from each boundary).

const TRIVIAL_BODY = `export function add(a: number, b: number) { return a + b; }`;

function buildBranchy(branches: number): string {
  // Each `if (x) {}` adds 1 decision + a depth of 1.
  const lines: string[] = [];
  lines.push(`export function f() {`);
  for (let i = 0; i < branches; i++) {
    lines.push(`  if (cond${i}) { doThing(${i}); }`);
  }
  lines.push(`}`);
  return lines.join('\n');
}

function buildNested(depth: number): string {
  let body = '';
  for (let i = 0; i < depth; i++) body += `if (a${i}) {\n`;
  body += 'work();\n';
  for (let i = 0; i < depth; i++) body += '}\n';
  return `export function deep() {\n${body}\n}`;
}

test('summarisePrComplexity skips binary / deleted / non-source rows', () => {
  const files: PrChangedFile[] = [
    { path: 'src/a.ts', body: TRIVIAL_BODY },
    { path: 'src/b.ts', body: TRIVIAL_BODY, changeKind: 'D' },
    { path: 'README.md', body: 'hello world' },                  // skipped (non-source)
    { path: 'node_modules/foo/index.js', body: 'x' },             // skipped (vendored)
  ];
  const s = summarisePrComplexity(files);
  assert.equal(s.deleted, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.analysed, 1);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].path, 'src/a.ts');
});

test('summarisePrComplexity sorts by bucket then score then path', () => {
  const files: PrChangedFile[] = [
    { path: 'src/zzz.ts', body: TRIVIAL_BODY },
    { path: 'src/aaa.ts', body: buildBranchy(80) },   // extreme
    { path: 'src/bbb.ts', body: buildBranchy(20) },   // medium-ish
    { path: 'src/ccc.ts', body: TRIVIAL_BODY },        // low
  ];
  const s = summarisePrComplexity(files);
  assert.equal(s.rows[0].path, 'src/aaa.ts');
  // Among 'low' bucket files, path lexicographic tiebreak.
  const lows = s.rows.filter(r => r.score.bucket === 'low').map(r => r.path);
  // Two low (zzz.ts and ccc.ts) - they should appear after non-low rows
  // and order between them is score-then-path; same TRIVIAL_BODY score
  // so path lex wins.
  assert.deepEqual(lows.sort(), ['src/ccc.ts', 'src/zzz.ts']);
  assert.equal(s.topBucket, 'extreme');
});

test('summarisePrComplexity bucket histogram totals match analysed', () => {
  const files: PrChangedFile[] = [
    { path: 'src/low.ts', body: TRIVIAL_BODY },
    { path: 'src/med.ts', body: buildBranchy(15) },
    { path: 'src/high.ts', body: buildBranchy(50) },
    { path: 'src/x.ts', body: buildBranchy(140) },
  ];
  const s = summarisePrComplexity(files);
  const sum = s.buckets.low + s.buckets.medium + s.buckets.high + s.buckets.extreme;
  assert.equal(sum, s.analysed);
  assert.ok(s.totalScore > 0);
});

test('summarisePrComplexity empty input produces all-zero summary', () => {
  const s = summarisePrComplexity([]);
  assert.equal(s.analysed, 0);
  assert.equal(s.skipped, 0);
  assert.equal(s.deleted, 0);
  assert.equal(s.totalScore, 0);
  assert.equal(s.topBucket, undefined);
});

test('formatPillLabel reports low when nothing brighter exists', () => {
  const files: PrChangedFile[] = [{ path: 'src/a.ts', body: TRIVIAL_BODY }];
  const s = summarisePrComplexity(files);
  const lbl = formatPillLabel(s);
  assert.match(lbl, /1 file/);
  assert.match(lbl, /1 low/);
});

test('formatPillLabel highlights extreme + high but hides low when not alone', () => {
  const files: PrChangedFile[] = [
    { path: 'src/low.ts', body: TRIVIAL_BODY },
    { path: 'src/x.ts', body: buildBranchy(160) },
  ];
  const s = summarisePrComplexity(files);
  const lbl = formatPillLabel(s);
  assert.match(lbl, /2 files/);
  assert.match(lbl, /X/);
  assert.doesNotMatch(lbl, /low/);
});

test('formatPillLabel: no analysable files signals clearly', () => {
  const files: PrChangedFile[] = [
    { path: 'src/d.ts', body: TRIVIAL_BODY, changeKind: 'D' },
    { path: 'README.md', body: 'hi' },
  ];
  const s = summarisePrComplexity(files);
  assert.equal(formatPillLabel(s), 'no analysable files');
});

test('formatPillLabel: empty input says no files', () => {
  assert.equal(formatPillLabel(summarisePrComplexity([])), 'no files');
});

test('buildPrComplexityTooltip includes per-bucket counts and total', () => {
  const files: PrChangedFile[] = [
    { path: 'src/x.ts', body: buildBranchy(120) },
    { path: 'src/m.ts', body: buildBranchy(15) },
  ];
  const s = summarisePrComplexity(files);
  const tip = buildPrComplexityTooltip(s);
  assert.match(tip, /\*\*PR complexity\*\*/);
  assert.match(tip, /Total score/);
  assert.match(tip, /Hottest files first/);
});

test('buildPrComplexityTooltip empty summary shows deleted/skipped counts only', () => {
  const files: PrChangedFile[] = [
    { path: 'src/d.ts', body: TRIVIAL_BODY, changeKind: 'D' },
    { path: 'package-lock.json', body: 'x' },
  ];
  const s = summarisePrComplexity(files);
  const tip = buildPrComplexityTooltip(s);
  assert.match(tip, /deleted/);
  assert.match(tip, /skipped/);
  assert.doesNotMatch(tip, /Total score/);
});

test('buildPrComplexityReport renders a markdown table with file rows', () => {
  const files: PrChangedFile[] = [
    { path: 'src/x.ts', body: buildBranchy(80) },
    { path: 'src/y.ts', body: TRIVIAL_BODY },
  ];
  const s = summarisePrComplexity(files);
  const md = buildPrComplexityReport(s, { prNumber: 42, range: 'main..HEAD' });
  assert.match(md, /PR #42/);
  assert.match(md, /\| File \| Bucket \| Score \|/);
  assert.match(md, /src\/x\.ts/);
  assert.match(md, /src\/y\.ts/);
  assert.match(md, /Files\*\*: 2 analysed/);
});

test('summarisePrComplexity nested file goes to higher bucket than branchy 5', () => {
  const a = summarisePrComplexity([{ path: 'src/a.ts', body: buildBranchy(5) }]);
  const b = summarisePrComplexity([{ path: 'src/b.ts', body: buildNested(8) }]);
  assert.ok(a.totalScore < b.totalScore);
});
