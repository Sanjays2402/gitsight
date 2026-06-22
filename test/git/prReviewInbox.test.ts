import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parsePrReviewList,
  classifyReviewState,
  sortByUrgency,
  glyphForState,
  describePrLabel,
  describePrDetail,
} from '../../src/git/prReviewInbox';

const sample = JSON.stringify([
  {
    number: 42,
    title: 'Add foo support',
    url: 'https://github.com/foo/bar/pull/42',
    headRefName: 'foo-support',
    baseRefName: 'main',
    author: { login: 'alice' },
    repository: { name: 'bar', owner: { login: 'foo' } },
    updatedAt: '2026-06-20T10:00:00Z',
    isDraft: false,
    additions: 100, deletions: 5, changedFiles: 4,
    reviewDecision: 'REVIEW_REQUIRED',
  },
  {
    number: 43,
    title: 'Fix flaky test',
    url: 'https://github.com/foo/bar/pull/43',
    headRefName: 'fix-flake',
    baseRefName: 'main',
    author: { login: 'bob' },
    repository: { name: 'bar', owner: { login: 'foo' } },
    updatedAt: '2026-06-21T12:00:00Z',
    isDraft: false,
    additions: 12, deletions: 8, changedFiles: 2,
    reviewDecision: 'CHANGES_REQUESTED',
  },
  {
    number: 44,
    title: 'WIP draft idea',
    url: 'https://github.com/foo/bar/pull/44',
    headRefName: 'wip',
    baseRefName: 'main',
    author: { login: 'eve' },
    repository: { name: 'bar', owner: { login: 'foo' } },
    updatedAt: '2026-06-15T00:00:00Z',
    isDraft: true,
    additions: 200, deletions: 0, changedFiles: 8,
    reviewDecision: '',
  },
  {
    number: 45,
    title: 'Already approved, can be merged',
    url: 'https://github.com/other/repo/pull/45',
    headRefName: 'shipme',
    baseRefName: 'main',
    author: { login: 'carol' },
    repository: { name: 'repo', owner: { login: 'other' } },
    updatedAt: '2026-06-21T13:00:00Z',
    isDraft: false,
    additions: 3, deletions: 1, changedFiles: 1,
    reviewDecision: 'APPROVED',
  },
]);

test('parsePrReviewList returns one entry per JSON record with defaults', () => {
  const out = parsePrReviewList(sample);
  assert.equal(out.length, 4);
  const byN = (n: number) => out.find(e => e.number === n)!;
  assert.equal(byN(42).reviewState, 'review-required');
  assert.equal(byN(42).repoSlug, 'foo/bar');
  assert.equal(byN(42).authorLogin, 'alice');
  assert.equal(byN(43).reviewState, 'changes-requested');
  assert.equal(byN(44).isDraft, true);
  assert.equal(byN(44).reviewState, 'unknown');
  assert.equal(byN(45).reviewState, 'approved');
});

test('parsePrReviewList drops entries without a usable number', () => {
  const raw = JSON.stringify([{ title: 'no number' }, { number: 0, title: 'zero' }, { number: 'NaN', title: 'nan' }, { number: 7, title: 'real' }]);
  const out = parsePrReviewList(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 7);
});

test('parsePrReviewList returns [] for empty / invalid input', () => {
  assert.deepEqual(parsePrReviewList(''), []);
  assert.deepEqual(parsePrReviewList('   '), []);
  assert.deepEqual(parsePrReviewList('not-json'), []);
  assert.deepEqual(parsePrReviewList(JSON.stringify({ not: 'array' })), []);
});

test('parsePrReviewList tolerates string `repository` field shape', () => {
  const raw = JSON.stringify([{ number: 1, title: 't', repository: 'owner/name' }]);
  const out = parsePrReviewList(raw);
  assert.equal(out[0].repoSlug, 'owner/name');
});

test('parsePrReviewList falls back to author.name when author.login is missing', () => {
  const raw = JSON.stringify([{ number: 1, title: 't', author: { name: 'Alice Doe' } }]);
  const out = parsePrReviewList(raw);
  assert.equal(out[0].authorLogin, 'Alice Doe');
});

test('classifyReviewState maps known gh values to the enum', () => {
  assert.equal(classifyReviewState('REVIEW_REQUIRED'), 'review-required');
  assert.equal(classifyReviewState('CHANGES_REQUESTED'), 'changes-requested');
  assert.equal(classifyReviewState('APPROVED'), 'approved');
  assert.equal(classifyReviewState('COMMENTED'), 'commented');
});

test('classifyReviewState is case-insensitive and trims whitespace', () => {
  assert.equal(classifyReviewState('  approved  '), 'approved');
  assert.equal(classifyReviewState('Review_Required'), 'review-required');
});

test('classifyReviewState falls back to unknown for empty / unrecognised', () => {
  assert.equal(classifyReviewState(''), 'unknown');
  assert.equal(classifyReviewState('   '), 'unknown');
  assert.equal(classifyReviewState('something-new'), 'unknown');
});

test('sortByUrgency puts review-required first, drafts last', () => {
  const out = sortByUrgency(parsePrReviewList(sample));
  assert.equal(out[0].number, 42, 'review-required should lead');
  assert.equal(out[1].number, 43, 'changes-requested next');
  assert.equal(out[2].number, 45, 'approved before draft');
  assert.equal(out[3].number, 44, 'draft last');
});

test('sortByUrgency sorts within a state by updatedAt descending', () => {
  const raw = JSON.stringify([
    { number: 1, title: 'a', updatedAt: '2026-06-01T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' },
    { number: 2, title: 'b', updatedAt: '2026-06-10T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' },
    { number: 3, title: 'c', updatedAt: '2026-06-05T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' },
  ]);
  const out = sortByUrgency(parsePrReviewList(raw));
  assert.deepEqual(out.map(e => e.number), [2, 3, 1]);
});

test('glyphForState returns a codicon name for every state', () => {
  const states: any[] = ['review-required', 'changes-requested', 'approved', 'commented', 'unknown'];
  for (const s of states) {
    const g = glyphForState(s);
    assert.ok(g && typeof g === 'string' && g.length > 0, `expected glyph for ${s}`);
  }
});

test('describePrLabel is stable across the common shapes', () => {
  const entries = parsePrReviewList(sample);
  const e = entries.find(x => x.number === 42)!;
  assert.equal(describePrLabel(e, '3d ago'), 'foo/bar#42  \u00b7  Add foo support (alice)  \u00b7  3d ago');
  const draft = entries.find(x => x.number === 44)!;
  assert.match(describePrLabel(draft, '6d ago'), /draft/);
});

test('describePrLabel omits author and date when missing', () => {
  const raw = JSON.stringify([{ number: 1, title: 'no meta' }]);
  const e = parsePrReviewList(raw)[0];
  assert.equal(describePrLabel(e, ''), '#1  \u00b7  no meta');
});

test('describePrDetail produces "+N -M in K file(s)" + ref arrow', () => {
  const e = parsePrReviewList(sample).find(x => x.number === 42)!;
  assert.equal(describePrDetail(e), '+100 -5 in 4 files  \u00b7  main \u2190 foo-support');
});

test('describePrDetail uses singular "file" for changedFiles=1', () => {
  const raw = JSON.stringify([{ number: 1, title: 't', additions: 1, deletions: 0, changedFiles: 1 }]);
  const e = parsePrReviewList(raw)[0];
  assert.equal(describePrDetail(e), '+1 -0 in 1 file');
});
