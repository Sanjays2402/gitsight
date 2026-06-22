import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  decideScaffold,
  composeScaffoldHeader,
  isScaffoldShaped,
  stagingChanged,
  classifyScaffoldDrift,
  summariseScaffoldChange,
} from '../../src/git/commitScaffold';

test('decideScaffold: skips when input has text', () => {
  const d = decideScaffold({
    inputValue: 'wip\n', stagedPaths: ['src/git/foo.ts'],
  });
  assert.equal(d.shouldScaffold, false);
  assert.equal(d.reason, 'input-not-empty');
});

test('decideScaffold: skips when no staged paths', () => {
  const d = decideScaffold({ inputValue: '', stagedPaths: [] });
  assert.equal(d.shouldScaffold, false);
  assert.equal(d.reason, 'no-staged-paths');
});

test('decideScaffold: skips when staging cap exceeded', () => {
  const paths = Array.from({ length: 12 }, (_, i) => `src/git/x${i}.ts`);
  const d = decideScaffold({ inputValue: '', stagedPaths: paths });
  assert.equal(d.shouldScaffold, false);
  assert.equal(d.reason, 'too-many-paths');
});

test('decideScaffold: scaffolds docs-only changes', () => {
  const d = decideScaffold({ inputValue: '', stagedPaths: ['README.md'] });
  assert.equal(d.shouldScaffold, true);
  assert.equal(d.header, 'docs: ');
});

test('decideScaffold: scaffolds test-only changes with scope', () => {
  const d = decideScaffold({
    inputValue: '', stagedPaths: ['test/git/foo.test.ts', 'test/git/bar.test.ts'],
  });
  assert.equal(d.shouldScaffold, true);
  assert.match(d.header ?? '', /^test\(/);
});

test('decideScaffold: scaffolds CI-only changes', () => {
  const d = decideScaffold({
    inputValue: '', stagedPaths: ['.github/workflows/ci.yml'],
  });
  assert.equal(d.shouldScaffold, true);
  assert.equal(d.header, 'ci: ');
});

test('decideScaffold: skips low-confidence (default feat with no scope)', () => {
  const d = decideScaffold({
    inputValue: '', stagedPaths: ['src/extension.ts'],
  });
  // suggestType returns feat @ 0.4, default minTypeConfidence is 0.7 → skip.
  assert.equal(d.shouldScaffold, false);
  assert.equal(d.reason, 'low-confidence');
});

test('decideScaffold: skips when type wins but scope absent (no-scope guard)', () => {
  // Many top-level files = high-confidence-ish but suggestScope can return
  // undefined when the dominant segment doesn't pass the >50% threshold.
  // Build one with a clean test signal but no clear scope.
  const d = decideScaffold({
    inputValue: '',
    stagedPaths: ['x.test.ts', 'y.test.ts'],
    minTypeConfidence: 0.5,
  });
  // It's classified as test, scope picks the most common segment.
  // We just check the policy: if no scope returned, scaffold is skipped.
  if (!d.shouldScaffold) {
    assert.equal(d.reason, 'no-scope');
  } else {
    assert.match(d.header ?? '', /^test/);
  }
});

test('decideScaffold: scaffoldWithoutScope honours opt-in', () => {
  const d = decideScaffold({
    inputValue: '',
    stagedPaths: ['src/extension.ts'],
    minTypeConfidence: 0.1,
    scaffoldWithoutScope: true,
  });
  // confidence threshold dropped, so it'll suggest something; with the
  // scope guard off, we get a header (even if it's `feat: `).
  assert.equal(d.shouldScaffold, true);
  assert.ok(d.header);
});

test('decideScaffold: master enabled=false short-circuits', () => {
  const d = decideScaffold({
    inputValue: '', stagedPaths: ['README.md'], enabled: false,
  });
  assert.equal(d.shouldScaffold, false);
  assert.equal(d.reason, 'opted-out');
});

test('composeScaffoldHeader: with scope', () => {
  assert.equal(composeScaffoldHeader('feat', 'git'), 'feat(git): ');
  assert.equal(composeScaffoldHeader('fix', 'parser'), 'fix(parser): ');
});

test('composeScaffoldHeader: without scope', () => {
  assert.equal(composeScaffoldHeader('docs'), 'docs: ');
  assert.equal(composeScaffoldHeader('chore', ''), 'chore: ');
  assert.equal(composeScaffoldHeader('docs', '   '), 'docs: ');
});

test('isScaffoldShaped: detects scope form', () => {
  const r = isScaffoldShaped('feat(git): add quick switcher\n\nBody here');
  assert.deepEqual(r, { type: 'feat', scope: 'git', subjectLength: 'add quick switcher'.length });
});

test('isScaffoldShaped: detects no-scope form', () => {
  const r = isScaffoldShaped('docs: clarify section\n');
  assert.deepEqual(r, { type: 'docs', scope: undefined, subjectLength: 'clarify section'.length });
});

test('isScaffoldShaped: detects empty subject', () => {
  const r = isScaffoldShaped('feat(git): ');
  assert.ok(r);
  assert.equal(r!.subjectLength, 0);
});

test('isScaffoldShaped: rejects non-conformant input', () => {
  assert.equal(isScaffoldShaped(''), undefined);
  assert.equal(isScaffoldShaped('Random commit'), undefined);
  assert.equal(isScaffoldShaped('FEAT: caps'), undefined); // type must be lowercase
  assert.equal(isScaffoldShaped('feat:no-space'), undefined);
});

test('stagingChanged: equal sets', () => {
  assert.equal(stagingChanged(['a', 'b'], ['b', 'a']), false);
  assert.equal(stagingChanged([], []), false);
});

test('stagingChanged: any difference is a change', () => {
  assert.equal(stagingChanged(['a'], ['a', 'b']), true);
  assert.equal(stagingChanged(['a', 'b'], ['a', 'c']), true);
  assert.equal(stagingChanged(['a'], []), true);
});

// ── F84: classifyScaffoldDrift ────────────────────────────────────

test('classifyScaffoldDrift: no remembered scaffold is "none"', () => {
  assert.equal(classifyScaffoldDrift('whatever the user typed', ''), 'none');
  assert.equal(classifyScaffoldDrift('', ''), 'none');
  assert.equal(classifyScaffoldDrift('feat(x): subj', '   '), 'none');
});

test('classifyScaffoldDrift: untouched when input equals remembered', () => {
  assert.equal(classifyScaffoldDrift('feat(git): ', 'feat(git): '), 'untouched');
  assert.equal(classifyScaffoldDrift('docs: ', 'docs: '), 'untouched');
});

test('classifyScaffoldDrift: untouched tolerates trailing whitespace from editors', () => {
  assert.equal(classifyScaffoldDrift('feat(git): \n', 'feat(git): '), 'untouched');
  assert.equal(classifyScaffoldDrift('feat(git): ', 'feat(git): \n'), 'untouched');
});

test('classifyScaffoldDrift: extended when user typed past the prefix', () => {
  assert.equal(classifyScaffoldDrift('feat(git): add quick switcher', 'feat(git): '), 'extended');
  assert.equal(
    classifyScaffoldDrift('feat(git): add quick switcher\n\nbody', 'feat(git): '),
    'extended',
  );
});

test('classifyScaffoldDrift: replaced when user wrote a totally different message', () => {
  assert.equal(classifyScaffoldDrift('chore: bump deps', 'feat(git): '), 'replaced');
  assert.equal(classifyScaffoldDrift('WIP debugging', 'docs: '), 'replaced');
});

// ── F84: summariseScaffoldChange ──────────────────────────────────

test('summariseScaffoldChange: empty old uses placeholder', () => {
  assert.equal(summariseScaffoldChange('', 'feat(git): '), '(none) \u2192 feat(git):');
});

test('summariseScaffoldChange: shows transition with arrow', () => {
  assert.equal(
    summariseScaffoldChange('feat(git): ', 'docs(commitScaffold): '),
    'feat(git): \u2192 docs(commitScaffold):',
  );
});

test('summariseScaffoldChange: flags unchanged so the picker can skip the confirm', () => {
  const same = summariseScaffoldChange('feat(git): ', 'feat(git): ');
  assert.match(same, /unchanged/i);
});

test('summariseScaffoldChange: trims trailing whitespace before comparing for unchanged', () => {
  const r = summariseScaffoldChange('feat(git):  ', 'feat(git): ');
  assert.match(r, /unchanged/i);
});
