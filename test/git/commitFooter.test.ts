import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  FOOTER_DEFINITIONS,
  validateFooterValue,
  renderFooterLine,
  extractExistingFooters,
  appendFooters,
  normaliseIssueRef,
} from '../../src/git/commitFooter';

test('FOOTER_DEFINITIONS includes the seven canonical trailers in order', () => {
  const kinds = FOOTER_DEFINITIONS.map(d => d.kind);
  assert.deepEqual(kinds, [
    'co-authored-by', 'reviewed-by', 'signed-off-by',
    'closes', 'fixes', 'refs', 'breaking-change',
  ]);
});

test('validateFooterValue accepts well-formed name+email entries', () => {
  for (const kind of ['co-authored-by', 'reviewed-by', 'signed-off-by'] as const) {
    assert.equal(validateFooterValue(kind, 'Alice <a@example.com>'), undefined);
    assert.equal(validateFooterValue(kind, 'Alice Doe <alice.doe@example.co.uk>'), undefined);
    assert.equal(validateFooterValue(kind, 'Long Name With Spaces <x@y.z>'), undefined);
  }
});

test('validateFooterValue rejects malformed name+email entries', () => {
  for (const bad of ['Alice <not-an-email>', 'no-name@example.com', '<a@b.c>', 'Alice', '', '   ', 'Alice <a@b.c> trailing']) {
    assert.ok(validateFooterValue('co-authored-by', bad), `expected reject: ${JSON.stringify(bad)}`);
  }
});

test('validateFooterValue accepts well-formed issue refs', () => {
  for (const ref of ['#123', '#1', 'foo/bar#42', 'foo-bar/baz_qux#1', '#1, #2', '#1, foo/bar#42']) {
    assert.equal(validateFooterValue('closes', ref), undefined, `expected accept: ${ref}`);
  }
});

test('validateFooterValue rejects malformed issue refs', () => {
  for (const bad of ['123', 'foo#', '#abc', '#1,', '#1 #2 #3', '  ', 'closes #1']) {
    assert.ok(validateFooterValue('fixes', bad), `expected reject: ${JSON.stringify(bad)}`);
  }
});

test('validateFooterValue accepts any non-empty free text for breaking changes', () => {
  assert.equal(validateFooterValue('breaking-change', 'API renamed from foo() to bar()'), undefined);
  assert.equal(validateFooterValue('breaking-change', 'x'), undefined);
});

test('validateFooterValue rejects empty free text', () => {
  assert.ok(validateFooterValue('breaking-change', ''));
  assert.ok(validateFooterValue('breaking-change', '   '));
});

test('renderFooterLine renders the canonical trailer form', () => {
  assert.equal(renderFooterLine({ kind: 'co-authored-by', value: 'Alice <a@b.c>' }), 'Co-authored-by: Alice <a@b.c>');
  assert.equal(renderFooterLine({ kind: 'breaking-change', value: 'foo gone' }), 'BREAKING CHANGE: foo gone');
  assert.equal(renderFooterLine({ kind: 'closes', value: '#42' }), 'Closes: #42');
  assert.equal(renderFooterLine({ kind: 'refs', value: '#1, #2' }), 'Refs: #1, #2');
});

test('extractExistingFooters finds trailers regardless of case', () => {
  const msg = [
    'feat: thing',
    '',
    'co-authored-by: Alice <a@b.c>',
    'REVIEWED-BY: Bob <b@b.c>',
    'closes: #42',
  ].join('\n');
  const out = extractExistingFooters(msg);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'co-authored-by');
  assert.equal(out[1].kind, 'reviewed-by');
  assert.equal(out[2].kind, 'closes');
  assert.equal(out[2].value, '#42');
});

test('extractExistingFooters returns [] for empty / trailerless messages', () => {
  assert.deepEqual(extractExistingFooters(''), []);
  assert.deepEqual(extractExistingFooters('feat: just a subject'), []);
  assert.deepEqual(extractExistingFooters('feat: x\n\nbody with no trailers\n'), []);
});

test('appendFooters inserts a blank-line separator between body and trailers', () => {
  const msg = 'feat: thing\n\nbody copy here';
  const out = appendFooters(msg, [{ kind: 'closes', value: '#42' }]);
  assert.equal(out, 'feat: thing\n\nbody copy here\n\nCloses: #42\n');
});

test('appendFooters appends to an existing trailer block without extra blank line', () => {
  const msg = 'feat: thing\n\nbody\n\nCo-authored-by: Alice <a@b.c>\n';
  const out = appendFooters(msg, [{ kind: 'reviewed-by', value: 'Bob <b@b.c>' }]);
  assert.equal(out, 'feat: thing\n\nbody\n\nCo-authored-by: Alice <a@b.c>\nReviewed-by: Bob <b@b.c>\n');
});

test('appendFooters dedupes name-email trailers case-insensitively on value', () => {
  const msg = 'feat: x\n\nCo-authored-by: Alice <a@b.c>';
  const out = appendFooters(msg, [
    { kind: 'co-authored-by', value: 'Alice <A@B.C>' },
    { kind: 'co-authored-by', value: 'Bob <b@b.c>' },
  ]);
  assert.match(out, /Bob <b@b.c>/);
  // Should NOT have a second Co-authored-by for Alice.
  const aliceCount = (out.match(/Alice/gi) ?? []).length;
  assert.equal(aliceCount, 1, `expected exactly one Alice entry, got ${aliceCount}`);
});

test('appendFooters keeps two distinct BREAKING CHANGE entries (case-sensitive on free text)', () => {
  const msg = 'feat!: x\n\nBREAKING CHANGE: foo gone';
  const out = appendFooters(msg, [
    { kind: 'breaking-change', value: 'foo gone' }, // duplicate, should drop
    { kind: 'breaking-change', value: 'bar gone' }, // new, should ship
  ]);
  assert.match(out, /BREAKING CHANGE: bar gone/);
  const fooCount = (out.match(/BREAKING CHANGE: foo gone/g) ?? []).length;
  assert.equal(fooCount, 1);
});

test('appendFooters handles an empty message gracefully', () => {
  const out = appendFooters('', [{ kind: 'closes', value: '#42' }]);
  assert.equal(out, 'Closes: #42\n');
});

test('appendFooters returns the original message when given no entries', () => {
  assert.equal(appendFooters('feat: x', []), 'feat: x');
});

test('normaliseIssueRef adds the leading # to bare numbers', () => {
  assert.equal(normaliseIssueRef('123'), '#123');
  assert.equal(normaliseIssueRef('  123  '), '#123');
});

test('normaliseIssueRef preserves cross-repo refs', () => {
  assert.equal(normaliseIssueRef('foo/bar#42'), 'foo/bar#42');
  assert.equal(normaliseIssueRef('foo-bar/baz_qux#1, #2'), 'foo-bar/baz_qux#1, #2');
});

test('normaliseIssueRef returns undefined for nonsense input', () => {
  assert.equal(normaliseIssueRef(''), undefined);
  assert.equal(normaliseIssueRef('   '), undefined);
  assert.equal(normaliseIssueRef('not-a-ref'), undefined);
  assert.equal(normaliseIssueRef('#abc'), undefined);
  assert.equal(normaliseIssueRef('#1, garbage'), undefined);
});

test('normaliseIssueRef collapses whitespace into the canonical comma form', () => {
  assert.equal(normaliseIssueRef('  #1   #2  '), '#1, #2');
  assert.equal(normaliseIssueRef('#1,,, #2,#3'), '#1, #2, #3');
});
