import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDiff,
  summariseDiff,
  formatFileBlock,
  pickDiffFence,
  buildDiffPrompt,
  suggestDiffPrTitle,
  parseNumstatNul,
  DiffFileEntry,
} from '../../src/git/prFromDiff';

function file(relPath: string, added: number, removed: number, diff = '', binary = false): DiffFileEntry {
  return {
    relPath,
    language: relPath.endsWith('.ts') ? 'typescript' : 'plaintext',
    diffSnippet: diff,
    added,
    removed,
    binary,
  };
}

test('classifyDiff: empty -> empty', () => {
  assert.equal(classifyDiff({ files: [] }), 'empty');
});

test('classifyDiff: tiny single-file change -> too-small', () => {
  assert.equal(classifyDiff({ files: [file('a.ts', 1, 0)] }), 'too-small');
});

test('classifyDiff: multi-file even tiny -> ok', () => {
  assert.equal(classifyDiff({
    files: [file('a.ts', 1, 0), file('b.ts', 1, 0)],
  }), 'ok');
});

test('classifyDiff: 41 files -> too-large-files', () => {
  const files = Array.from({ length: 41 }, (_, i) => file(`f${i}.ts`, 1, 0));
  assert.equal(classifyDiff({ files }), 'too-large-files');
});

test('classifyDiff: >4000 lines -> too-large-lines', () => {
  const files = [file('a.ts', 2500, 2000)];
  assert.equal(classifyDiff({ files }), 'too-large-lines');
});

test('classifyDiff: >50% binary -> binary-heavy', () => {
  assert.equal(classifyDiff({
    files: [
      file('a.png', 0, 0, '', true),
      file('b.png', 0, 0, '', true),
      file('a.ts', 5, 3),
    ],
  }), 'binary-heavy');
});

test('classifyDiff: 50% binary exactly -> ok', () => {
  assert.equal(classifyDiff({
    files: [
      file('a.png', 0, 0, '', true),
      file('a.ts', 5, 3),
    ],
  }), 'ok');
});

test('classifyDiff: custom thresholds respected', () => {
  // With maxFiles=2, 3 files becomes too-large
  assert.equal(classifyDiff({
    files: [file('a.ts', 1, 0), file('b.ts', 1, 0), file('c.ts', 1, 0)],
    maxFiles: 2,
  }), 'too-large-files');
});

test('summariseDiff: empty -> no files message', () => {
  assert.equal(summariseDiff([]), 'No files changed.');
});

test('summariseDiff: lists top dirs by count', () => {
  const s = summariseDiff([
    file('src/api/foo.ts', 10, 2),
    file('src/api/bar.ts', 3, 1),
    file('src/web/baz.ts', 5, 5),
    file('test/api/quux.ts', 2, 0),
  ]);
  assert.match(s, /4 files changed/);
  assert.match(s, /\+20\/-8 lines/);
  assert.match(s, /across `src/);
});

test('summariseDiff: binary files reported separately', () => {
  const s = summariseDiff([
    file('a.ts', 5, 3),
    file('b.png', 0, 0, '', true),
    file('c.gif', 0, 0, '', true),
  ]);
  assert.match(s, /3 files changed/);
  assert.match(s, /\+5\/-3/);
  assert.match(s, /2 binary files ignored/);
});

test('summariseDiff: one binary suffix uses singular', () => {
  const s = summariseDiff([
    file('a.ts', 5, 3),
    file('b.png', 0, 0, '', true),
  ]);
  assert.match(s, /1 binary file ignored/);
});

test('formatFileBlock: small file kept verbatim', () => {
  const block = formatFileBlock({
    file: file('a.ts', 3, 1, '@@ -1,1 +1,3 @@\n-old\n+new1\n+new2\n+new3'),
  });
  assert.match(block, /### `a\.ts` \(\+3\/-1\)/);
  assert.match(block, /```diff/);
  assert.match(block, /\+new1/);
});

test('formatFileBlock: binary file emits no-diff note', () => {
  const block = formatFileBlock({ file: file('a.png', 0, 0, '', true) });
  assert.match(block, /_Binary file - diff omitted\._/);
});

test('formatFileBlock: empty snippet emits no-payload note', () => {
  const block = formatFileBlock({ file: file('a.ts', 1, 0, '') });
  assert.match(block, /_No diff payload available\._/);
});

test('formatFileBlock: long snippet head+tail truncated', () => {
  const long = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
  const block = formatFileBlock({ file: file('a.ts', 500, 0, long), maxLinesPerFile: 50 });
  assert.match(block, /\.\.\.450 lines omitted\.\.\./);
  // Head + tail preserved
  assert.match(block, /\+line0/);
  assert.match(block, /\+line499/);
});

test('pickDiffFence: always returns diff', () => {
  assert.equal(pickDiffFence('typescript'), 'diff');
  assert.equal(pickDiffFence('python'), 'diff');
  assert.equal(pickDiffFence(''), 'diff');
});

test('buildDiffPrompt: includes header + summary + each file block', () => {
  const prompt = buildDiffPrompt({
    files: [
      file('src/api/foo.ts', 10, 2, '@@ -1,1 +1,1 @@\n-foo\n+bar'),
      file('src/api/bar.ts', 5, 5, '@@ -1,1 +1,1 @@\n-baz\n+qux'),
    ],
    repo: { branch: 'feature/x', base: 'main', recentSubject: 'feat: x' },
  });
  assert.match(prompt, /Source branch: feature\/x/);
  assert.match(prompt, /Target branch: main/);
  assert.match(prompt, /Most recent commit subject: feat: x/);
  assert.match(prompt, /## Summary/);
  assert.match(prompt, /2 files changed/);
  assert.match(prompt, /### `src\/api\/foo\.ts`/);
  assert.match(prompt, /### `src\/api\/bar\.ts`/);
  assert.match(prompt, /Write a Pull Request description/);
});

test('buildDiffPrompt: caps included files + lists omitted', () => {
  const files = Array.from({ length: 15 }, (_, i) => file(`src/f${i}.ts`, i + 1, 1, '@@\n+x'));
  const prompt = buildDiffPrompt({
    files,
    repo: { branch: 'feature/x', base: 'main' },
    maxFiles: 5,
  });
  assert.match(prompt, /10 additional files not shown/);
  // High-churn files included first (sorted by churn desc) - look for f14, f13...
  assert.match(prompt, /### `src\/f14\.ts`/);
  // f0 should be omitted (lowest churn)
  assert.match(prompt, /- `src\/f0\.ts` \(\+1\/-1\)/);
});

test('buildDiffPrompt: omitted binaries surface as (binary)', () => {
  const files = [
    file('src/big.png', 0, 0, '', true),
    file('src/a.ts', 5, 3, '@@\n+x'),
    file('src/b.ts', 4, 2, '@@\n+y'),
  ];
  const prompt = buildDiffPrompt({
    files,
    repo: { branch: 'x', base: 'main' },
    maxFiles: 2,
  });
  assert.match(prompt, /- `src\/big\.png` \(binary\)/);
});

test('buildDiffPrompt: recentSubject omitted when absent', () => {
  const prompt = buildDiffPrompt({
    files: [file('a.ts', 3, 0, '@@\n+x'), file('b.ts', 2, 0, '@@\n+y')],
    repo: { branch: 'feature/x', base: 'main' },
  });
  assert.doesNotMatch(prompt, /Most recent commit subject/);
});

test('suggestDiffPrTitle: recent subject returned (truncated to 80)', () => {
  assert.equal(suggestDiffPrTitle({ files: [], recentSubject: 'feat: add login flow' }), 'feat: add login flow');
});

test('suggestDiffPrTitle: long subject truncated with ellipsis', () => {
  const long = 'x'.repeat(100);
  const out = suggestDiffPrTitle({ files: [], recentSubject: long });
  assert.equal(out.length, 78); // 77 + ellipsis (1 char)
  assert.match(out, /\u2026$/);
});

test('suggestDiffPrTitle: empty files -> fallback "Update"', () => {
  assert.equal(suggestDiffPrTitle({ files: [] }), 'Update');
});

test('suggestDiffPrTitle: single top-dir builds Update <dir>', () => {
  const out = suggestDiffPrTitle({
    files: [file('src/api/a.ts', 1, 0), file('src/api/b.ts', 2, 0)],
  });
  assert.match(out, /Update src \(2 files\)/);
});

test('suggestDiffPrTitle: multi-dir uses fallback message', () => {
  const out = suggestDiffPrTitle({
    files: [file('src/api/a.ts', 1, 0), file('test/api/a.ts', 2, 0), file('docs/x.md', 1, 0)],
  });
  assert.match(out, /Multi-area changes across 3 files/);
});

test('parseNumstatNul: simple two-file output', () => {
  const NUL = '\u0000';
  const raw = '10\t2\tsrc/a.ts' + NUL + '5\t5\tsrc/b.ts' + NUL;
  const out = parseNumstatNul(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { relPath: 'src/a.ts', added: 10, removed: 2, binary: false });
  assert.deepEqual(out[1], { relPath: 'src/b.ts', added: 5, removed: 5, binary: false });
});

test('parseNumstatNul: binary marker -> binary=true, zero counts', () => {
  const NUL = '\u0000';
  const raw = '-\t-\tsrc/foo.png' + NUL;
  const out = parseNumstatNul(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].binary, true);
  assert.equal(out[0].added, 0);
  assert.equal(out[0].removed, 0);
});

test('parseNumstatNul: empty / malformed fields ignored', () => {
  const NUL = '\u0000';
  assert.deepEqual(parseNumstatNul(''), []);
  assert.deepEqual(parseNumstatNul(NUL + NUL + NUL), []);
  // Malformed (no tab separators) ignored
  const out = parseNumstatNul('garbage' + NUL);
  assert.equal(out.length, 0);
});

test('parseNumstatNul: path with spaces preserved', () => {
  const NUL = '\u0000';
  const raw = '3\t1\tsrc/has space.ts' + NUL;
  const out = parseNumstatNul(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].relPath, 'src/has space.ts');
});
