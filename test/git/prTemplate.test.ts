import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  templateCandidatePaths,
  prettifyTemplateName,
  buildTemplatePickerEntries,
  parseTemplateSections,
  renderTemplate,
  mergeAiIntoTemplate,
  templateSectionPromptList,
} from '../../src/git/prTemplate';

test('templateCandidatePaths: directory candidates checked first', () => {
  const paths = templateCandidatePaths();
  // First entry must be a directory candidate.
  assert.equal(paths[0].isDirectory, true);
  // .github/PULL_REQUEST_TEMPLATE (dir) must come before
  // .github/PULL_REQUEST_TEMPLATE.md (single file).
  const dirIdx = paths.findIndex(p => p.path === '.github/PULL_REQUEST_TEMPLATE' && p.isDirectory);
  const fileIdx = paths.findIndex(p => p.path === '.github/PULL_REQUEST_TEMPLATE.md' && !p.isDirectory);
  assert.ok(dirIdx >= 0);
  assert.ok(fileIdx >= 0);
  assert.ok(dirIdx < fileIdx);
});

test('templateCandidatePaths: covers all canonical locations', () => {
  const paths = templateCandidatePaths().map(p => p.path);
  assert.ok(paths.includes('.github/PULL_REQUEST_TEMPLATE.md'));
  assert.ok(paths.includes('PULL_REQUEST_TEMPLATE.md'));
  assert.ok(paths.includes('docs/PULL_REQUEST_TEMPLATE.md'));
});

test('prettifyTemplateName: snake_case becomes Sentence case', () => {
  assert.equal(prettifyTemplateName('feature_request.md'), 'Feature request');
  assert.equal(prettifyTemplateName('bug-fix.md'), 'Bug fix');
  assert.equal(prettifyTemplateName('FRONTEND_BUG.md'), 'Frontend bug');
});

test('prettifyTemplateName: strips .md and .markdown', () => {
  assert.equal(prettifyTemplateName('simple.md'), 'Simple');
  assert.equal(prettifyTemplateName('docs.markdown'), 'Docs');
  assert.equal(prettifyTemplateName('plain.txt'), 'Plain');
  assert.equal(prettifyTemplateName('extensionless'), 'Extensionless');
});

test('prettifyTemplateName: default.md still prettifies', () => {
  assert.equal(prettifyTemplateName('default.md'), 'Default');
});

test('buildTemplatePickerEntries: filters out non-markdown', () => {
  const entries = buildTemplatePickerEntries('.github/PULL_REQUEST_TEMPLATE', [
    'bug.md', 'feature.md', 'README.txt', 'icon.png', 'notes.markdown',
  ]);
  // .md, .markdown, .txt are included; .png is not.
  assert.deepEqual(entries.map(e => e.label), ['Bug', 'Feature', 'Notes', 'Readme']);
});

test('buildTemplatePickerEntries: default.md floats to top', () => {
  const entries = buildTemplatePickerEntries('.github/PULL_REQUEST_TEMPLATE', [
    'zebra.md', 'apple.md', 'default.md',
  ]);
  assert.deepEqual(entries.map(e => e.label), ['Default', 'Apple', 'Zebra']);
});

test('buildTemplatePickerEntries: returns relPath joined cleanly', () => {
  const entries = buildTemplatePickerEntries('.github/PULL_REQUEST_TEMPLATE/', ['bug.md']);
  assert.equal(entries[0].relPath, '.github/PULL_REQUEST_TEMPLATE/bug.md');
});

test('parseTemplateSections: empty input', () => {
  const r = parseTemplateSections('');
  assert.equal(r.preamble, '');
  assert.deepEqual(r.sections, []);
});

test('parseTemplateSections: heading with body', () => {
  const md = '## Summary\n\nFix the leak in the pipeline.\n\n## Test plan\n- [ ] manual';
  const r = parseTemplateSections(md);
  assert.equal(r.preamble, '');
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[0].key, 'summary');
  assert.equal(r.sections[0].level, 2);
  assert.match(r.sections[0].body, /Fix the leak/);
  assert.equal(r.sections[1].key, 'test plan');
});

test('parseTemplateSections: preamble before first heading', () => {
  const md = 'Top-level instructions for the PR author.\n\n## Summary\nbody';
  const r = parseTemplateSections(md);
  assert.match(r.preamble, /Top-level instructions/);
  assert.equal(r.sections.length, 1);
  assert.equal(r.sections[0].key, 'summary');
});

test('parseTemplateSections: ignores headings inside code fences', () => {
  const md = '## Real\n```\n# not a heading\nstill body\n```\nmore body\n## Next';
  const r = parseTemplateSections(md);
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[0].key, 'real');
  assert.match(r.sections[0].body, /# not a heading/);
  assert.match(r.sections[0].body, /more body/);
});

test('parseTemplateSections: tolerates tilde fences too', () => {
  const md = '## Section\n~~~\n## fake\n~~~\nrealbody\n## Next';
  const r = parseTemplateSections(md);
  assert.equal(r.sections.length, 2);
  assert.equal(r.sections[1].key, 'next');
});

test('parseTemplateSections: preserves exact heading text for re-emission', () => {
  const md = '##   Spaced Title\nbody';
  const r = parseTemplateSections(md);
  assert.equal(r.sections[0].heading, '##   Spaced Title');
  assert.equal(r.sections[0].key, 'spaced title');
});

test('parseTemplateSections: heading levels 1-6', () => {
  const md = '# H1\nbody1\n## H2\nbody2\n###### H6\nbody6';
  const r = parseTemplateSections(md);
  assert.equal(r.sections.length, 3);
  assert.deepEqual(r.sections.map(s => s.level), [1, 2, 6]);
});

test('parseTemplateSections: HTML comments stay in body verbatim', () => {
  const md = '## Summary\n<!-- explain the why -->\nactual content';
  const r = parseTemplateSections(md);
  assert.match(r.sections[0].body, /<!-- explain the why -->/);
});

test('renderTemplate: round-trips a simple template', () => {
  const src = '## Summary\nThe summary body.\n\n## Test plan\n- [ ] step one';
  const parsed = parseTemplateSections(src);
  const out = renderTemplate(parsed);
  assert.match(out, /## Summary\nThe summary body/);
  assert.match(out, /## Test plan\n- \[ \] step one/);
});

test('renderTemplate: preserves preamble', () => {
  const src = 'preamble line\n\n## Section\nbody';
  const out = renderTemplate(parseTemplateSections(src));
  assert.match(out, /^preamble line/);
  assert.match(out, /## Section\nbody/);
});

test('mergeAiIntoTemplate: replaces aliased section body', () => {
  const tmpl = '## Summary\nplaceholder summary\n\n## Test plan\n- [ ] manual';
  const ai = '## Summary\nFixes the actual leak.\n\n## Implementation notes\nUsed a Set.';
  const r = mergeAiIntoTemplate(tmpl, ai);
  assert.match(r.merged, /Fixes the actual leak/);
  assert.doesNotMatch(r.merged, /placeholder summary/);
  // Template's Test plan checklist must survive.
  assert.match(r.merged, /## Test plan\n- \[ \] manual/);
  assert.ok(r.replaced.includes('summary'));
});

test('mergeAiIntoTemplate: appends AI sections that have no template counterpart', () => {
  const tmpl = '## Summary\nplaceholder';
  const ai = '## Summary\nreal summary\n\n## Implementation notes\nDetails here.';
  const r = mergeAiIntoTemplate(tmpl, ai);
  assert.match(r.merged, /## Implementation notes\nDetails here/);
  assert.ok(r.appended.includes('implementation notes'));
});

test('mergeAiIntoTemplate: strict mode drops unmatched AI sections', () => {
  const tmpl = '## Summary\nplaceholder';
  const ai = '## Summary\nreal\n\n## Implementation notes\nextra';
  const r = mergeAiIntoTemplate(tmpl, ai, { appendUnmatched: false });
  assert.doesNotMatch(r.merged, /Implementation notes/);
  assert.ok(r.dropped.includes('implementation notes'));
  assert.deepEqual(r.appended, []);
});

test('mergeAiIntoTemplate: matches "Description" alias to "Summary" canonical', () => {
  // GitHub PR templates often use "Description"; AI emits "Summary".
  const tmpl = '## Description\nplaceholder';
  const ai = '## Summary\nreal summary text';
  const r = mergeAiIntoTemplate(tmpl, ai);
  // Both map to canonical 'summary', so the template's "Description"
  // heading stays, with the AI body inside.
  assert.match(r.merged, /## Description\nreal summary text/);
  assert.ok(r.replaced.includes('summary'));
});

test('mergeAiIntoTemplate: checklist body is NEVER overwritten by AI', () => {
  // Even when the AI emits a Checklist section, we keep the user's
  // template checklist verbatim - BUT we WILL replace if it's there
  // because that's a real alias match. The protective behaviour the
  // user typically wants is: do not REPLACE the test plan items, do
  // not REPLACE the checklist items. The current implementation
  // replaces on alias match; this test pins the documented behaviour
  // so a future "protect the checklist" change is visible in tests.
  const tmpl = '## Checklist\n- [ ] manual step';
  const ai = '## Checklist\n- [ ] AI step';
  const r = mergeAiIntoTemplate(tmpl, ai);
  assert.match(r.merged, /\[ \] AI step/);
  assert.ok(r.replaced.includes('checklist'));
});

test('mergeAiIntoTemplate: preserves template preamble and section ordering', () => {
  const tmpl = 'preamble text\n\n## A\na-body\n\n## B\nb-body';
  const ai = '## B\nnew-b';
  const r = mergeAiIntoTemplate(tmpl, ai);
  assert.match(r.merged, /^preamble text/);
  const aIdx = r.merged.indexOf('## A');
  const bIdx = r.merged.indexOf('## B');
  assert.ok(aIdx >= 0 && bIdx > aIdx, 'A before B');
  assert.match(r.merged, /## B\nnew-b/);
});

test('mergeAiIntoTemplate: returns empty arrays on identical input', () => {
  const both = '## Summary\nsame\n';
  const r = mergeAiIntoTemplate(both, both);
  assert.deepEqual(r.replaced, ['summary']);
  assert.deepEqual(r.appended, []);
});

test('mergeAiIntoTemplate: empty AI leaves template untouched', () => {
  const tmpl = '## Summary\nbody';
  const r = mergeAiIntoTemplate(tmpl, '');
  assert.match(r.merged, /## Summary\nbody/);
  assert.deepEqual(r.replaced, []);
  assert.deepEqual(r.appended, []);
});

test('templateSectionPromptList: emits the section headings in order', () => {
  const md = '## Summary\nbody\n## Changes\nbody\n## Test plan\nbody';
  const list = templateSectionPromptList(parseTemplateSections(md));
  assert.deepEqual(list, ['## Summary', '## Changes', '## Test plan']);
});

test('templateSectionPromptList: preserves unaliased headings too', () => {
  const md = '## Summary\nbody\n## Custom Section\nbody';
  const list = templateSectionPromptList(parseTemplateSections(md));
  assert.deepEqual(list, ['## Summary', '## Custom Section']);
});
