import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  composeCommentBody,
  fenceLanguage,
  buildPermalinkPath,
  buildPermalinkUrl,
  classifyComposeShape,
} from '../../src/git/prCommentCompose';

test('composeCommentBody: prefix only -> just prose', () => {
  const out = composeCommentBody({ selectionText: '', userPrefix: 'Hello reviewers!' });
  assert.equal(out.trim(), 'Hello reviewers!');
});

test('composeCommentBody: selection-only emits a code fence', () => {
  const out = composeCommentBody({
    selectionText: 'const x = 1;\nconst y = 2;\n',
    language: 'typescript',
  });
  assert.match(out, /```typescript\nconst x = 1;\nconst y = 2;\n```/);
});

test('composeCommentBody: path + selection emits a quoted permalink line', () => {
  const out = composeCommentBody({
    selectionText: 'foo()',
    path: 'src/a.ts',
    startLine: 12,
    endLine: 18,
    branch: 'feat/widget',
    permalink: 'https://github.com/foo/bar/blob/feat/widget/src/a.ts#L12-L18',
    language: 'typescript',
  });
  assert.match(out, /> \[src\/a\.ts:12-18 @ feat\/widget\]\(https:\/\/github\.com\/.*\)/);
  assert.match(out, /```typescript\nfoo\(\)\n```/);
});

test('composeCommentBody: full layout has prose, permalink, and fence in order', () => {
  const out = composeCommentBody({
    userPrefix: 'Tiny nit: rename `x`.',
    selectionText: 'const x = 1;',
    path: 'src/a.ts',
    startLine: 10,
    endLine: 10,
    branch: 'main',
    permalink: 'https://github.com/foo/bar/blob/main/src/a.ts#L10',
    language: 'typescript',
  });
  const lines = out.split('\n');
  assert.equal(lines[0], 'Tiny nit: rename `x`.');
  // Then a blank line, then the permalink line.
  assert.equal(lines[1], '');
  assert.match(lines[2], /^> \[src\/a\.ts:10 @ main\]/);
  // Then blank line + fence open.
  assert.equal(lines[3], '');
  assert.equal(lines[4], '```typescript');
});

test('composeCommentBody: single-line selection uses :N (no range)', () => {
  const out = composeCommentBody({
    selectionText: 'one()',
    path: 'src/a.ts',
    startLine: 5,
    endLine: 5,
    branch: 'main',
  });
  assert.match(out, /> src\/a\.ts:5 @ main/);
  assert.doesNotMatch(out, /-5/);
});

test('composeCommentBody: no permalink URL still emits the label as plain text', () => {
  const out = composeCommentBody({
    selectionText: 'x',
    path: 'src/a.ts',
    startLine: 3,
    endLine: 4,
    branch: 'feat/x',
  });
  assert.match(out, /> src\/a\.ts:3-4 @ feat\/x/);
  // No markdown link bracket pair since no URL was provided.
  assert.doesNotMatch(out, /\]\(http/);
});

test('composeCommentBody: empty input -> single newline', () => {
  const out = composeCommentBody({ selectionText: '' });
  assert.equal(out, '\n');
});

test('composeCommentBody: normalises CRLF line endings', () => {
  const out = composeCommentBody({
    selectionText: 'a\r\nb\r\nc',
    language: 'plaintext',
  });
  // Fence is empty for plaintext.
  assert.match(out, /```\na\nb\nc\n```/);
  assert.doesNotMatch(out, /\r/);
});

test('composeCommentBody: trims trailing newlines inside selection so fence-close is tight', () => {
  const out = composeCommentBody({
    selectionText: 'x\n\n\n',
    language: 'typescript',
  });
  // The fence-close should sit right after `x`, with a single blank line above for fence spacing.
  assert.match(out, /```typescript\nx\n```/);
});

test('fenceLanguage: known shorthands', () => {
  assert.equal(fenceLanguage('typescriptreact'), 'tsx');
  assert.equal(fenceLanguage('javascriptreact'), 'jsx');
  assert.equal(fenceLanguage('shellscript'), 'bash');
  assert.equal(fenceLanguage('plaintext'), '');
  assert.equal(fenceLanguage('objective-c'), 'objc');
  assert.equal(fenceLanguage('objective-cpp'), 'objcpp');
});

test('fenceLanguage: unknown id strips to alphanumeric', () => {
  assert.equal(fenceLanguage('csv (custom)'), 'csvcustom');
  assert.equal(fenceLanguage('TypeScript'), 'typescript');
  assert.equal(fenceLanguage(''), '');
  assert.equal(fenceLanguage(undefined), '');
});

test('buildPermalinkPath: github.com', () => {
  const p = buildPermalinkPath('https://github.com/foo/bar', 'main', 'src/a.ts', 12, 18);
  assert.equal(p, '/blob/main/src/a.ts#L12-L18');
});

test('buildPermalinkPath: github single-line uses #L<N>', () => {
  const p = buildPermalinkPath('https://github.com/foo/bar', 'main', 'src/a.ts', 5, 5);
  assert.equal(p, '/blob/main/src/a.ts#L5');
});

test('buildPermalinkPath: gitlab uses /-/blob/', () => {
  const p = buildPermalinkPath('https://gitlab.com/foo/bar', 'main', 'src/a.ts', 1, 2);
  assert.equal(p, '/-/blob/main/src/a.ts#L1-L2');
});

test('buildPermalinkPath: bitbucket uses /src/', () => {
  const p = buildPermalinkPath('https://bitbucket.org/foo/bar', 'main', 'src/a.ts', 1, 1);
  assert.equal(p, '/src/main/src/a.ts#L1');
});

test('buildPermalinkPath: azure devops uses ?path query', () => {
  const p = buildPermalinkPath('https://dev.azure.com/foo/bar', 'main', 'src/a.ts', 3, 8);
  assert.match(p, /\?path=%2Fsrc%2Fa\.ts/);
  assert.match(p, /version=GBmain/);
  assert.match(p, /&line=3&lineEnd=8/);
});

test('buildPermalinkUrl: drops trailing slash on host base', () => {
  const url = buildPermalinkUrl('https://github.com/foo/bar/', 'main', 'src/a.ts', 5, 5);
  assert.equal(url, 'https://github.com/foo/bar/blob/main/src/a.ts#L5');
});

test('buildPermalinkUrl: encodes branch with slashes', () => {
  const url = buildPermalinkUrl('https://github.com/foo/bar', 'feat/widget', 'src/a.ts');
  assert.match(url, /\/blob\/feat%2Fwidget\/src\/a\.ts$/);
});

test('classifyComposeShape: empty when nothing given', () => {
  assert.equal(classifyComposeShape({ selectionText: '' }), 'empty');
});

test('classifyComposeShape: prefix-only when prose without selection', () => {
  assert.equal(classifyComposeShape({ selectionText: '', userPrefix: 'hi' }), 'prefix-only');
});

test('classifyComposeShape: selection-only when code without prose', () => {
  assert.equal(classifyComposeShape({ selectionText: 'x' }), 'selection-only');
});

test('classifyComposeShape: full when both', () => {
  assert.equal(classifyComposeShape({ selectionText: 'x', userPrefix: 'note' }), 'full');
});

test('classifyComposeShape: too-large for >200 line selections', () => {
  const big = Array.from({ length: 250 }, (_, i) => `line${i}`).join('\n');
  assert.equal(classifyComposeShape({ selectionText: big, userPrefix: 'note' }), 'too-large');
});

test('classifyComposeShape: exactly 200 lines is full, not too-large', () => {
  const at = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
  assert.equal(classifyComposeShape({ selectionText: at, userPrefix: 'p' }), 'full');
});

test('classifyComposeShape: whitespace-only prefix counts as no prefix', () => {
  assert.equal(classifyComposeShape({ selectionText: '', userPrefix: '   \n' }), 'empty');
});
