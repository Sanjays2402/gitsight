import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifySelection,
  formatSelectionBlock,
  languageFenceTag,
  buildSelectionPrompt,
  suggestPrTitle,
  SelectionContext,
} from '../../src/git/prFromSelection';

function mkSel(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    relPath: 'src/foo.ts',
    language: 'typescript',
    startLine: 10,
    endLine: 25,
    selectionText: 'function foo() {\n  return 42;\n}',
    ...over,
  };
}

// ── classifySelection ───────────────────────────────────────────

test('classifySelection: empty selection is empty', () => {
  assert.equal(classifySelection(mkSel({ selectionText: '' })), 'empty');
  assert.equal(classifySelection(mkSel({ selectionText: '   \n  \n' })), 'empty');
});

test('classifySelection: single-line selection is too-small (default min=2)', () => {
  assert.equal(classifySelection(mkSel({ startLine: 5, endLine: 5 })), 'too-small');
});

test('classifySelection: minLines override allows single-line', () => {
  assert.equal(
    classifySelection(mkSel({ startLine: 5, endLine: 5 }), { minLines: 1 }),
    'ok',
  );
});

test('classifySelection: > maxLines is too-large', () => {
  assert.equal(
    classifySelection(mkSel({ startLine: 1, endLine: 1000 })),
    'too-large',
  );
});

test('classifySelection: reasonable selection is ok', () => {
  assert.equal(classifySelection(mkSel()), 'ok');
});

// ── languageFenceTag ────────────────────────────────────────────

test('languageFenceTag: typescriptreact → tsx', () => {
  assert.equal(languageFenceTag('typescriptreact'), 'tsx');
});

test('languageFenceTag: javascriptreact → jsx', () => {
  assert.equal(languageFenceTag('javascriptreact'), 'jsx');
});

test('languageFenceTag: plaintext → empty', () => {
  assert.equal(languageFenceTag('plaintext'), '');
});

test('languageFenceTag: passthroughs commonly accepted ids', () => {
  assert.equal(languageFenceTag('typescript'), 'typescript');
  assert.equal(languageFenceTag('python'), 'python');
  assert.equal(languageFenceTag('go'), 'go');
  assert.equal(languageFenceTag('rust'), 'rust');
});

test('languageFenceTag: strips non-alphanumerics + lowercases', () => {
  assert.equal(languageFenceTag('TypeScript'), 'typescript');
  assert.equal(languageFenceTag('weird/lang!?'), 'weirdlang');
});

test('languageFenceTag: empty input is empty', () => {
  assert.equal(languageFenceTag(''), '');
});

// ── formatSelectionBlock ────────────────────────────────────────

test('formatSelectionBlock: emits file:lines header + fenced block', () => {
  const out = formatSelectionBlock(mkSel());
  assert.match(out, /^### src\/foo\.ts:10-25\n```typescript\n/);
  assert.match(out, /\n```$/);
});

test('formatSelectionBlock: trims trailing whitespace on each line', () => {
  const out = formatSelectionBlock(mkSel({
    selectionText: 'a   \nb\t\nc',
  }));
  // The middle of the block (after the opening fence, before the closing fence)
  // should have no trailing spaces or tabs on any line.
  for (const line of out.split('\n')) {
    if (line.startsWith('```') || line.startsWith('###')) continue;
    assert.equal(line, line.replace(/[ \t]+$/, ''));
  }
});

test('formatSelectionBlock: preserves leading whitespace (indentation)', () => {
  const out = formatSelectionBlock(mkSel({
    selectionText: '  if (x) {\n    return y;\n  }',
  }));
  assert.match(out, /^ {2}if \(x\) \{$/m);
  assert.match(out, /^ {4}return y;$/m);
});

// ── buildSelectionPrompt ────────────────────────────────────────

test('buildSelectionPrompt: includes branch + base + file + lines', () => {
  const out = buildSelectionPrompt({
    selection: mkSel(),
    repo: { branch: 'feat/picker', base: 'origin/main' },
  });
  assert.match(out, /Source branch: feat\/picker/);
  assert.match(out, /Target branch: origin\/main/);
  assert.match(out, /File: src\/foo\.ts/);
  assert.match(out, /Lines: 10-25/);
});

test('buildSelectionPrompt: omits recentSubject when undefined', () => {
  const out = buildSelectionPrompt({
    selection: mkSel(),
    repo: { branch: 'a', base: 'b' },
  });
  assert.doesNotMatch(out, /Most recent commit/);
});

test('buildSelectionPrompt: includes recentSubject when provided', () => {
  const out = buildSelectionPrompt({
    selection: mkSel(),
    repo: { branch: 'a', base: 'b' },
    recentSubject: 'feat(foo): add picker',
  });
  assert.match(out, /Most recent commit touching this area: feat\(foo\): add picker/);
});

test('buildSelectionPrompt: contextBefore / contextAfter wrapped in fenced blocks', () => {
  const out = buildSelectionPrompt({
    selection: mkSel({
      contextBefore: 'import foo from "./foo";',
      contextAfter: 'export default Component;',
    }),
    repo: { branch: 'a', base: 'b' },
  });
  assert.match(out, /## Context before the selection/);
  assert.match(out, /import foo from "\.\/foo";/);
  assert.match(out, /## Context after the selection/);
  assert.match(out, /export default Component;/);
});

test('buildSelectionPrompt: long context truncated to maxContextLines', () => {
  const longContext = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const out = buildSelectionPrompt({
    selection: mkSel({ contextBefore: longContext }),
    repo: { branch: 'a', base: 'b' },
    maxContextLines: 40,
  });
  assert.match(out, /\.\.\.\d+ lines omitted\.\.\./);
});

test('buildSelectionPrompt: always ends with the scoped-PR instruction', () => {
  const out = buildSelectionPrompt({
    selection: mkSel(),
    repo: { branch: 'a', base: 'b' },
  });
  assert.match(out, /tightly-scoped PR description for ONLY the selected change/);
});

// ── suggestPrTitle ──────────────────────────────────────────────

test('suggestPrTitle: prefers a non-empty recentSubject when present', () => {
  const t = suggestPrTitle({
    selection: mkSel(),
    recentSubject: 'fix(parser): handle empty token',
  });
  assert.equal(t, 'fix(parser): handle empty token');
});

test('suggestPrTitle: truncates long recentSubject with ellipsis', () => {
  const long = 'feat(very-long-scope): ' + 'x'.repeat(120);
  const t = suggestPrTitle({ selection: mkSel(), recentSubject: long });
  assert.ok(t.length <= 80);
  assert.match(t, /\u2026$/);
});

test('suggestPrTitle: falls back to verb+file:lines when no recent commit', () => {
  const t = suggestPrTitle({ selection: mkSel({ relPath: 'src/git/parser.ts' }) });
  // "Update in parser.ts:10-25" — exact verb depends on heuristic, but the
  // format is verb + " in " + basename + ":" + lines.
  assert.match(t, /^[A-Z]\w+ in parser\.ts:10-25$/);
});

test('suggestPrTitle: heuristic picks Fix for fix/bug/crash text', () => {
  const t = suggestPrTitle({
    selection: mkSel({ selectionText: '// fix the crash in parser\nreturn null;' }),
  });
  assert.match(t, /^Fix in/);
});

test('suggestPrTitle: heuristic picks Add for export/function/class', () => {
  const t = suggestPrTitle({
    selection: mkSel({ selectionText: 'export function foo() { return 1; }' }),
  });
  assert.match(t, /^Add in/);
});

test('suggestPrTitle: heuristic picks Refactor for refactor/rename/extract', () => {
  const t = suggestPrTitle({
    selection: mkSel({ selectionText: '// refactor parser to use streaming' }),
  });
  assert.match(t, /^Refactor in/);
});

test('suggestPrTitle: heuristic picks Remove for remove/delete/drop', () => {
  const t = suggestPrTitle({
    selection: mkSel({ selectionText: '// remove legacy fallback path' }),
  });
  assert.match(t, /^Remove in/);
});

test('suggestPrTitle: default verb is Update', () => {
  const t = suggestPrTitle({
    selection: mkSel({ selectionText: 'const x = 1;\nconst y = 2;' }),
  });
  assert.match(t, /^Update in/);
});
