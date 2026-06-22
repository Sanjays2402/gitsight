import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  lintPrBody,
  lintVerdict,
  summariseLint,
} from '../../src/git/prTemplateLint';

test('lintPrBody: empty body returns no findings', () => {
  assert.deepEqual(lintPrBody(''), []);
});

test('lintPrBody: TODO/TBD/FIXME placeholders flagged', () => {
  const f = lintPrBody('Summary\n\nTODO: write me');
  assert.equal(f.length, 1);
  assert.equal(f[0].category, 'verbatim-placeholder');
  assert.equal(f[0].severity, 'warning');
  assert.equal(f[0].line, 2);
});

test('lintPrBody: multiple placeholders on same line', () => {
  const f = lintPrBody('TODO and FIXME');
  assert.equal(f.length, 2);
  assert.equal(f[0].column, 0);
  assert.equal(f[1].column, 9);
});

test('lintPrBody: word-boundary safe — TODOSAUR is not flagged', () => {
  const f = lintPrBody('TODOSAUR REX');
  assert.equal(f.length, 0);
});

test('lintPrBody: "Describe your changes" placeholder', () => {
  const f = lintPrBody('## Summary\nDescribe your changes here.');
  assert.ok(f.some(x => x.category === 'verbatim-placeholder'));
});

test('lintPrBody: HTML comment instruction leftover', () => {
  const f = lintPrBody('## Summary\n<!-- delete this line -->\nReal content.');
  assert.ok(f.some(x => x.category === 'instruction-leftover'));
  const inst = f.find(x => x.category === 'instruction-leftover')!;
  assert.equal(inst.line, 1);
});

test('lintPrBody: multi-line HTML comment counted as one finding', () => {
  const f = lintPrBody('<!--\nmulti\nline\n-->\n');
  const insts = f.filter(x => x.category === 'instruction-leftover');
  assert.equal(insts.length, 1);
});

test('lintPrBody: <link> / <url> unfilled-link placeholder', () => {
  const f = lintPrBody('See <link> for details.');
  assert.ok(f.some(x => x.category === 'unfilled-link'));
});

test('lintPrBody: empty-checkbox opt-in only', () => {
  const body = '- [ ] not yet';
  const off = lintPrBody(body);
  assert.equal(off.filter(x => x.category === 'empty-checkbox').length, 0);
  const on = lintPrBody(body, { flagEmptyCheckboxes: true });
  assert.equal(on.filter(x => x.category === 'empty-checkbox').length, 1);
});

test('lintPrBody: empty-checkbox suppressed inside code fence', () => {
  const body = '```\n- [ ] inside fence\n```';
  const f = lintPrBody(body, { flagEmptyCheckboxes: true });
  assert.equal(f.filter(x => x.category === 'empty-checkbox').length, 0);
});

test('lintPrBody: empty section body flagged', () => {
  const body = '## Summary\n\n## Test plan\n';
  const f = lintPrBody(body);
  const empties = f.filter(x => x.category === 'empty-section');
  assert.equal(empties.length, 2);
});

test('lintPrBody: untouched-section requires templateBody', () => {
  const tmpl = '## Summary\n\nDescribe.\n\n## Tests\n\nList tests.';
  const body = '## Summary\n\nDescribe.\n\n## Tests\n\nList tests.';
  const f = lintPrBody(body, { templateBody: tmpl });
  // Both sections are untouched AND contain "Describe" placeholder
  const untouched = f.filter(x => x.category === 'untouched-section');
  assert.equal(untouched.length, 2);
});

test('lintPrBody: edited section does NOT trigger untouched check', () => {
  const tmpl = '## Summary\n\nDescribe.\n';
  const body = '## Summary\n\nMy real summary.\n';
  const f = lintPrBody(body, { templateBody: tmpl });
  const untouched = f.filter(x => x.category === 'untouched-section');
  assert.equal(untouched.length, 0);
});

test('lintPrBody: missing required section', () => {
  const body = '## Summary\n\nSome content.';
  const f = lintPrBody(body, { requiredSections: ['Summary', 'Test plan'] });
  const missing = f.filter(x => x.category === 'missing-section');
  assert.equal(missing.length, 1);
  assert.ok(missing[0].message.includes('Test plan'));
});

test('lintPrBody: required section present in any case matches', () => {
  const body = '## summary\n\nFoo';
  const f = lintPrBody(body, { requiredSections: ['Summary'] });
  assert.equal(f.filter(x => x.category === 'missing-section').length, 0);
});

test('lintPrBody: findings sorted by line then column', () => {
  const body = 'TODO line 0\n\nFIXME line 2';
  const f = lintPrBody(body);
  assert.equal(f[0].line, 0);
  assert.equal(f[1].line, 2);
});

test('lintPrBody: severities overridable per category', () => {
  const f = lintPrBody('TODO', { severities: { 'verbatim-placeholder': 'error' } });
  assert.equal(f[0].severity, 'error');
});

test('lintVerdict: returns highest severity', () => {
  assert.equal(lintVerdict([]), 'ok');
  assert.equal(lintVerdict([{ category: 'empty-section', severity: 'info', line: 0, column: 0, length: 1, message: '' }]), 'info');
  assert.equal(lintVerdict([
    { category: 'empty-section', severity: 'info', line: 0, column: 0, length: 1, message: '' },
    { category: 'verbatim-placeholder', severity: 'warning', line: 0, column: 0, length: 1, message: '' },
  ]), 'warning');
  assert.equal(lintVerdict([
    { category: 'verbatim-placeholder', severity: 'warning', line: 0, column: 0, length: 1, message: '' },
    { category: 'unfilled-link', severity: 'error', line: 0, column: 0, length: 1, message: '' },
  ]), 'error');
});

test('summariseLint: empty', () => {
  assert.equal(summariseLint([]), 'No issues found.');
});

test('summariseLint: mixed', () => {
  const s = summariseLint([
    { category: 'verbatim-placeholder', severity: 'warning', line: 0, column: 0, length: 1, message: '' },
    { category: 'verbatim-placeholder', severity: 'warning', line: 1, column: 0, length: 1, message: '' },
    { category: 'empty-section', severity: 'info', line: 2, column: 0, length: 1, message: '' },
  ]);
  assert.equal(s, '3 findings (2 warnings, 1 info).');
});

test('lintPrBody: column position correct mid-line', () => {
  const body = '## Summary\nThis has TODO mid-line.';
  const f = lintPrBody(body);
  const todo = f.find(x => x.category === 'verbatim-placeholder')!;
  assert.equal(todo.line, 1);
  assert.equal(todo.column, 9);
  assert.equal(todo.length, 4);
});

test('lintPrBody: HTML comment column captured correctly on the right line', () => {
  const body = 'line0\n  <!-- todo --> line1';
  const f = lintPrBody(body);
  const inst = f.find(x => x.category === 'instruction-leftover')!;
  assert.equal(inst.line, 1);
  assert.equal(inst.column, 2);
});

test('lintPrBody: <url> placeholder case-insensitive', () => {
  const f = lintPrBody('Visit <URL>.');
  assert.equal(f.filter(x => x.category === 'unfilled-link').length, 1);
});

test('lintPrBody: N/A placeholder flagged', () => {
  const f = lintPrBody('Risk: N/A');
  assert.ok(f.some(x => x.category === 'verbatim-placeholder'));
});

test('lintPrBody: empty section heading not double-flagged inside scan', () => {
  // An empty section should produce exactly one empty-section finding,
  // not also a missing-section.
  const f = lintPrBody('## Summary\n\n');
  const empties = f.filter(x => x.category === 'empty-section');
  assert.equal(empties.length, 1);
});

test('lintPrBody: clean PR body has no findings', () => {
  const body = '## Summary\n\nWe added a thing.\n\n## Tests\n\nUnit-tested via npm test.';
  const f = lintPrBody(body);
  assert.equal(f.length, 0);
});

test('lintPrBody: multiple categories from one body composable', () => {
  const body = '## Summary\nTODO write me.\n\n<!-- delete me -->\n\n- [ ] not done';
  const f = lintPrBody(body, { flagEmptyCheckboxes: true });
  const cats = new Set(f.map(x => x.category));
  assert.ok(cats.has('verbatim-placeholder'));
  assert.ok(cats.has('instruction-leftover'));
  assert.ok(cats.has('empty-checkbox'));
});

test('lintPrBody: severity floor for missing-section is info by default', () => {
  const f = lintPrBody('foo', { requiredSections: ['Summary'] });
  assert.equal(f[0].severity, 'info');
});

test('lintPrBody: long body with many findings preserves order', () => {
  const body = Array.from({ length: 10 }, (_, i) => `Line ${i} has TODO`).join('\n');
  const f = lintPrBody(body);
  assert.equal(f.length, 10);
  for (let i = 0; i < 10; i++) assert.equal(f[i].line, i);
});

test('lintPrBody: Lorem ipsum placeholder flagged', () => {
  const f = lintPrBody('Lorem ipsum dolor sit amet.');
  assert.ok(f.some(x => x.category === 'verbatim-placeholder'));
});
