import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  rankEntries,
  summariseEntries,
  glyphFor,
  describeEntryShort,
  describeEntryDetail,
  renderMarkdownReport,
  RepoAuditEntry,
} from '../../src/git/workspaceSecretAudit';
import { SecretAuditResult } from '../../src/git/secretAudit';

function mkAudit(missing: string[], referenced: string[] = missing, dyn = 0): SecretAuditResult {
  return {
    referenced,
    refs: missing.map((name, i) => ({ name, workflow: 'ci.yml', line: 5 + i })),
    missing,
    dynamicRefCount: dyn,
  } as SecretAuditResult;
}

function mkEntry(name: string, opts: Partial<RepoAuditEntry> = {}): RepoAuditEntry {
  return {
    cwd: `/repos/${name}`,
    name,
    applies: true,
    audit: opts.audit ?? mkAudit([]),
    ...opts,
  };
}

test('rankEntries: missing repos float to top (most missing first)', () => {
  const e1 = mkEntry('alpha', { audit: mkAudit(['A', 'B', 'C']) });
  const e2 = mkEntry('beta',  { audit: mkAudit(['X']) });
  const e3 = mkEntry('zeta',  { audit: mkAudit([]) });
  const e4 = mkEntry('skipped', { applies: false, skippedReason: 'no workflows', audit: undefined });
  const ranked = rankEntries([e3, e4, e2, e1]);
  assert.deepEqual(ranked.map(e => e.name), ['alpha', 'beta', 'zeta', 'skipped']);
});

test('rankEntries: alphabetical tiebreak inside each tier', () => {
  const a = mkEntry('a-app', { audit: mkAudit(['A']) });
  const b = mkEntry('b-app', { audit: mkAudit(['A']) });
  const c = mkEntry('c-app', { audit: mkAudit([]) });
  const d = mkEntry('d-app', { audit: mkAudit([]) });
  const ranked = rankEntries([d, b, a, c]);
  // Tier 0 (missing): a, b (same missing count → alphabetical)
  // Tier 1 (healthy): c, d
  assert.deepEqual(ranked.map(e => e.name), ['a-app', 'b-app', 'c-app', 'd-app']);
});

test('rankEntries: returns a new array, does not mutate input', () => {
  const a = mkEntry('a', { audit: mkAudit(['X']) });
  const b = mkEntry('b', { audit: mkAudit([]) });
  const input = [b, a];
  const ranked = rankEntries(input);
  assert.notEqual(ranked, input);
  assert.equal(input[0].name, 'b');
});

test('summariseEntries: counts repo states', () => {
  const e1 = mkEntry('a', { audit: mkAudit(['X']) });
  const e2 = mkEntry('b', { audit: mkAudit([]) });
  const e3 = mkEntry('c', { applies: false, audit: undefined, skippedReason: 'no workflows' });
  const out = summariseEntries([e1, e2, e3]);
  assert.match(out, /3 repos/);
  assert.match(out, /1 missing/);
  assert.match(out, /1 healthy/);
  assert.match(out, /1 skipped/);
});

test('summariseEntries: singular when 1 repo', () => {
  const out = summariseEntries([mkEntry('only', { audit: mkAudit([]) })]);
  assert.match(out, /^1 repo/);
});

test('summariseEntries: empty list', () => {
  assert.match(summariseEntries([]), /^0 repos/);
});

test('glyphFor: warning when missing, shield when healthy, circle-slash when skipped', () => {
  assert.equal(glyphFor(mkEntry('a', { audit: mkAudit(['X']) })), 'warning');
  assert.equal(glyphFor(mkEntry('b', { audit: mkAudit([]) })), 'shield');
  assert.equal(glyphFor(mkEntry('c', { applies: false, audit: undefined })), 'circle-slash');
});

test('describeEntryShort: matches the three states', () => {
  assert.match(describeEntryShort(mkEntry('a', { audit: mkAudit(['X', 'Y'], ['X', 'Y', 'Z']) })), /2 missing of 3/);
  assert.match(describeEntryShort(mkEntry('b', { audit: mkAudit([], ['Z']) })), /healthy.*1 secret referenced/);
  assert.equal(describeEntryShort(mkEntry('c', { applies: false, skippedReason: 'no .github' })), 'no .github');
});

test('describeEntryDetail: slug preferred, falls back to cwd', () => {
  const e = mkEntry('x', { audit: mkAudit([]), slug: 'foo/bar' });
  assert.equal(describeEntryDetail(e), 'foo/bar');
  const e2 = mkEntry('y', { audit: mkAudit([]), slug: undefined, cwd: '/abs/path' });
  assert.equal(describeEntryDetail(e2), '/abs/path');
  const e3 = mkEntry('z', { applies: false, audit: undefined, skippedReason: 'not github' });
  assert.equal(describeEntryDetail(e3), 'not github');
});

test('renderMarkdownReport: emits sections per repo', () => {
  const entries = [
    mkEntry('alpha', { slug: 'foo/alpha', audit: mkAudit(['NPM_TOKEN'], ['NPM_TOKEN', 'GITHUB_TOKEN']) }),
    mkEntry('beta',  { slug: 'foo/beta',  audit: mkAudit([], ['NPM_TOKEN']) }),
    mkEntry('gamma', { applies: false, audit: undefined, skippedReason: 'no workflows' }),
  ];
  const md = renderMarkdownReport(entries);
  assert.match(md, /# GitSight/);
  assert.match(md, /## alpha/);
  assert.match(md, /_foo\/alpha_/);
  assert.match(md, /\*\*1 missing\*\* of 2 referenced/);
  assert.match(md, /\| `NPM_TOKEN` \| `ci\.yml:5` \|/);
  assert.match(md, /## beta/);
  assert.match(md, /Healthy. 1 secret referenced/);
  assert.match(md, /## gamma/);
  assert.match(md, /> Skipped: no workflows/);
});

test('renderMarkdownReport: timestamp shown only when `now` supplied', () => {
  const md = renderMarkdownReport([], new Date('2026-06-22T16:00:00Z'));
  assert.match(md, /Generated 2026-06-22T16:00:00\.000Z/);
  const md2 = renderMarkdownReport([]);
  assert.doesNotMatch(md2, /Generated/);
});

test('renderMarkdownReport: dynamic ref count surfaced when > 0', () => {
  const audit = mkAudit(['DYN_KEY'], ['DYN_KEY'], 3);
  const entries = [mkEntry('a', { audit })];
  const md = renderMarkdownReport(entries);
  assert.match(md, /\+3 dynamic references/);
});

test('renderMarkdownReport: deterministic across runs without timestamp', () => {
  const entries = [mkEntry('a', { audit: mkAudit([]) })];
  const a = renderMarkdownReport(entries);
  const b = renderMarkdownReport(entries);
  assert.equal(a, b);
});

test('rankEntries: handles empty list', () => {
  assert.deepEqual(rankEntries([]), []);
});

test('rankEntries: multiple skipped repos retain alphabetical order', () => {
  const a = mkEntry('apple',  { applies: false, audit: undefined, skippedReason: 'x' });
  const b = mkEntry('banana', { applies: false, audit: undefined, skippedReason: 'y' });
  const ranked = rankEntries([b, a]);
  assert.deepEqual(ranked.map(e => e.name), ['apple', 'banana']);
});
