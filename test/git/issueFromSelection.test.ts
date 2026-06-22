import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  stripCommentLine,
  extractBodyFromSelection,
  suggestTitleFromBody,
  defaultLabelsForMarker,
  composeIssueDraft,
  classifySelection,
  buildGhIssueArgs,
} from '../../src/git/issueFromSelection';

// ── stripCommentLine ──────────────────────────────────────────────

test('stripCommentLine: // TODO: text', () => {
  const r = stripCommentLine('// TODO: write the docs');
  assert.equal(r.text, 'write the docs');
  assert.equal(r.marker, 'TODO');
});

test('stripCommentLine: # FIXME: text', () => {
  const r = stripCommentLine('# FIXME: race condition');
  assert.equal(r.text, 'race condition');
  assert.equal(r.marker, 'FIXME');
});

test('stripCommentLine: hash prefix with scope dropped', () => {
  const r = stripCommentLine('# FIXME(auth): expiry handling broken');
  assert.equal(r.text, 'expiry handling broken');
  assert.equal(r.marker, 'FIXME');
});

test('stripCommentLine: block comment open+close stripped', () => {
  const r = stripCommentLine('/* TODO: extract helper */');
  assert.equal(r.text, 'extract helper');
  assert.equal(r.marker, 'TODO');
});

test('stripCommentLine: HTML comment delimiters stripped', () => {
  const r = stripCommentLine('<!-- TODO: update changelog -->');
  assert.equal(r.text, 'update changelog');
  assert.equal(r.marker, 'TODO');
});

test('stripCommentLine: SQL-style -- comment', () => {
  const r = stripCommentLine('-- HACK: postgres specific');
  assert.equal(r.text, 'postgres specific');
  assert.equal(r.marker, 'HACK');
});

test('stripCommentLine: lisp/ini ; comment', () => {
  const r = stripCommentLine('; NOTE: keep ordering stable');
  assert.equal(r.text, 'keep ordering stable');
  assert.equal(r.marker, 'NOTE');
});

test('stripCommentLine: marker without colon still detected', () => {
  const r = stripCommentLine('// TODO write tests');
  assert.equal(r.marker, 'TODO');
  assert.equal(r.text, 'write tests');
});

test('stripCommentLine: TODOSAUR is not a marker (word-boundary)', () => {
  const r = stripCommentLine('// TODOSAUR REX wandered');
  assert.equal(r.marker, null);
  assert.equal(r.text, 'TODOSAUR REX wandered');
});

test('stripCommentLine: no comment delimiter returns trimmed text', () => {
  const r = stripCommentLine('  plain text  ');
  assert.equal(r.marker, null);
  assert.equal(r.text, 'plain text');
});

// ── extractBodyFromSelection ──────────────────────────────────────

test('extractBodyFromSelection: empty input', () => {
  const r = extractBodyFromSelection('');
  assert.equal(r.text, '');
  assert.equal(r.marker, null);
});

test('extractBodyFromSelection: single TODO line', () => {
  const r = extractBodyFromSelection('// TODO: ship me');
  assert.equal(r.text, 'ship me');
  assert.equal(r.marker, 'TODO');
});

test('extractBodyFromSelection: multi-line comment dump', () => {
  const sel = [
    '// FIXME: this is broken',
    '//',
    '// We need to:',
    '//   - thing one',
    '//   - thing two',
  ].join('\n');
  const r = extractBodyFromSelection(sel);
  assert.equal(r.marker, 'FIXME');
  assert.ok(r.text.includes('this is broken'));
  assert.ok(r.text.includes('thing one'));
});

test('extractBodyFromSelection: raw code selection returns verbatim', () => {
  const sel = 'function foo() {\n  return 42;\n}';
  const r = extractBodyFromSelection(sel);
  assert.equal(r.marker, null);
  assert.equal(r.text, sel);
});

test('extractBodyFromSelection: mixed code + one comment keeps verbatim', () => {
  const sel = [
    'function foo() {',
    '  // TODO: handle null',
    '  return bar();',
    '}',
  ].join('\n');
  const r = extractBodyFromSelection(sel);
  // 75% non-comment lines -> verbatim
  assert.equal(r.marker, 'TODO');
  assert.equal(r.text, sel);
});

test('extractBodyFromSelection: trims leading/trailing blank stripped lines', () => {
  const sel = '//\n// TODO: real text\n//\n';
  const r = extractBodyFromSelection(sel);
  assert.equal(r.text, 'real text');
});

// ── suggestTitleFromBody ──────────────────────────────────────────

test('suggestTitleFromBody: first non-empty line wins', () => {
  assert.equal(suggestTitleFromBody('first line\nsecond line', 'TODO'), 'first line');
});

test('suggestTitleFromBody: trailing punctuation trimmed', () => {
  assert.equal(suggestTitleFromBody('Wrap-up the rebase!', 'TODO'), 'Wrap-up the rebase');
});

test('suggestTitleFromBody: empty body with marker falls back to "MARKER: "', () => {
  assert.equal(suggestTitleFromBody('', 'FIXME'), 'FIXME: ');
});

test('suggestTitleFromBody: capped at 72 chars + ellipsis', () => {
  const long = 'a'.repeat(120);
  const t = suggestTitleFromBody(long, 'TODO');
  assert.ok(t.length <= 72);
  assert.ok(t.endsWith('\u2026'));
});

// ── defaultLabelsForMarker ────────────────────────────────────────

test('defaultLabelsForMarker: FIXME/BUG/XXX -> ["bug"]', () => {
  assert.deepEqual(defaultLabelsForMarker('FIXME'), ['bug']);
  assert.deepEqual(defaultLabelsForMarker('BUG'), ['bug']);
  assert.deepEqual(defaultLabelsForMarker('XXX'), ['bug']);
});

test('defaultLabelsForMarker: HACK -> tech-debt', () => {
  assert.deepEqual(defaultLabelsForMarker('HACK'), ['tech-debt']);
});

test('defaultLabelsForMarker: OPTIMIZE -> performance', () => {
  assert.deepEqual(defaultLabelsForMarker('OPTIMIZE'), ['performance']);
});

test('defaultLabelsForMarker: TODO/NOTE/REVIEW -> empty', () => {
  assert.deepEqual(defaultLabelsForMarker('TODO'), []);
  assert.deepEqual(defaultLabelsForMarker('NOTE'), []);
  assert.deepEqual(defaultLabelsForMarker('REVIEW'), []);
});

// ── classifySelection ─────────────────────────────────────────────

test('classifySelection: empty', () => {
  assert.equal(classifySelection(''), 'empty');
  assert.equal(classifySelection('   \n  '), 'empty');
});

test('classifySelection: marker-only', () => {
  assert.equal(classifySelection('// TODO'), 'marker-only');
});

test('classifySelection: full (marker + body)', () => {
  assert.equal(classifySelection('// TODO: write tests'), 'full');
});

test('classifySelection: selection-only (raw code, no marker)', () => {
  assert.equal(classifySelection('function foo() { return 1; }'), 'selection-only');
});

test('classifySelection: too-large (>400 lines)', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(classifySelection(big), 'too-large');
});

// ── composeIssueDraft ─────────────────────────────────────────────

test('composeIssueDraft: TODO with permalink', () => {
  const draft = composeIssueDraft({
    selection: '// TODO: extract this helper',
    relPath: 'src/foo.ts',
    startLine: 42,
    endLine: 42,
    remoteUrl: 'https://github.com/foo/bar',
    branch: 'main',
    languageId: 'typescript',
  });
  assert.equal(draft.marker, 'TODO');
  assert.equal(draft.title, 'extract this helper');
  assert.ok(draft.body.includes('extract this helper'));
  assert.ok(draft.body.includes('src/foo.ts:L42'));
  assert.ok(draft.body.includes('https://github.com/foo/bar/blob/main/src/foo.ts#L42'));
  assert.ok(draft.body.includes('```typescript'));
  assert.equal(draft.verdict, 'full');
});

test('composeIssueDraft: line range L<a>-L<b> for multi-line selection', () => {
  const draft = composeIssueDraft({
    selection: '// TODO: refactor\nfunction foo() {}',
    relPath: 'src/foo.ts',
    startLine: 10,
    endLine: 12,
    remoteUrl: 'https://github.com/foo/bar',
    branch: 'main',
    languageId: 'typescript',
  });
  assert.ok(draft.body.includes('src/foo.ts:L10-L12'));
});

test('composeIssueDraft: no remote URL -> body still includes path reference', () => {
  const draft = composeIssueDraft({
    selection: '// TODO: thing',
    relPath: 'src/foo.ts',
    startLine: 5,
    endLine: 5,
  });
  assert.ok(draft.body.includes('`src/foo.ts:L5`'));
});

test('composeIssueDraft: selection-only verdict + path-based fallback title', () => {
  const draft = composeIssueDraft({
    selection: 'function broken() { throw new Error("nope") }',
    relPath: 'src/sad.ts',
    startLine: 1,
    endLine: 1,
  });
  assert.equal(draft.verdict, 'selection-only');
  assert.equal(draft.title, 'function broken() { throw new Error("nope") }');
});

test('composeIssueDraft: code fence escapes existing ``` in selection', () => {
  const draft = composeIssueDraft({
    selection: '```python\nprint("hi")\n```',
    relPath: 'foo.md',
    startLine: 1,
    endLine: 3,
    languageId: 'markdown',
  });
  // Outer fence MUST be > 3 backticks. The opening + closing fences
  // are the longest-backtick runs in the body.
  const backtickRuns = draft.body.match(/^`+/gm) ?? [];
  const maxLen = backtickRuns.reduce((m, s) => Math.max(m, s.length), 0);
  assert.ok(maxLen >= 4, `outer fence should be >=4 backticks, saw max=${maxLen}`);
});

test('composeIssueDraft: HACK gets tech-debt label', () => {
  const draft = composeIssueDraft({
    selection: '// HACK: temporary',
    relPath: 'src/a.ts',
    startLine: 1,
    endLine: 1,
  });
  assert.deepEqual(draft.suggestedLabels, ['tech-debt']);
});

test('composeIssueDraft: long body truncated with marker', () => {
  const selection = '// TODO: thing\n' + 'x'.repeat(10000);
  const draft = composeIssueDraft({
    selection,
    relPath: 'a.ts',
    startLine: 1,
    endLine: 200,
    maxBodyChars: 500,
  });
  assert.ok(draft.body.length <= 500);
  assert.ok(draft.body.includes('truncated'));
});

test('composeIssueDraft: language fence normalisation (tsx)', () => {
  const draft = composeIssueDraft({
    selection: 'const x = <Foo />;',
    relPath: 'a.tsx',
    startLine: 1,
    endLine: 1,
    languageId: 'typescriptreact',
  });
  assert.ok(draft.body.includes('```tsx'));
});

test('composeIssueDraft: language fence normalisation (plaintext drops tag)', () => {
  const draft = composeIssueDraft({
    selection: 'hello',
    relPath: 'a.txt',
    startLine: 1,
    endLine: 1,
    languageId: 'plaintext',
  });
  // First fence line should be just backticks with no language.
  const fenceLine = draft.body.split('\n').find(l => /^`{3,}$/.test(l));
  assert.ok(fenceLine, 'fence line should be unannotated');
});

test('composeIssueDraft: marker-only selection still produces draft', () => {
  const draft = composeIssueDraft({
    selection: '// TODO',
    relPath: 'a.ts',
    startLine: 1,
    endLine: 1,
  });
  assert.equal(draft.verdict, 'marker-only');
  assert.equal(draft.title, 'TODO: ');
});

// ── buildGhIssueArgs ──────────────────────────────────────────────

test('buildGhIssueArgs: basic with no labels', () => {
  const draft = {
    title: 'Foo bar',
    body: 'body',
    marker: 'TODO' as const,
    suggestedLabels: [],
    verdict: 'full' as const,
  };
  const args = buildGhIssueArgs(draft);
  assert.deepEqual(args, ['issue', 'create', '--title', 'Foo bar', '--body-file', '-']);
});

test('buildGhIssueArgs: includes suggested labels', () => {
  const draft = {
    title: 'Fix bug',
    body: 'body',
    marker: 'FIXME' as const,
    suggestedLabels: ['bug'],
    verdict: 'full' as const,
  };
  const args = buildGhIssueArgs(draft);
  assert.ok(args.includes('--label'));
  assert.ok(args.includes('bug'));
});

test('buildGhIssueArgs: extra labels merge + dedup', () => {
  const draft = {
    title: 'X',
    body: 'Y',
    marker: 'FIXME' as const,
    suggestedLabels: ['bug'],
    verdict: 'full' as const,
  };
  const args = buildGhIssueArgs(draft, ['bug', 'frontend']);
  const labels = args.filter((_, i) => i > 0 && args[i - 1] === '--label');
  assert.deepEqual(labels.sort(), ['bug', 'frontend']);
});
