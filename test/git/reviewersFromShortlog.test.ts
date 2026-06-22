import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildFromShortlog,
  buildIdentityIndex,
  classifySelfReview,
  buildSelfReviewHint,
} from '../../src/git/reviewersFromShortlog';
import { rerankRoundRobin } from '../../src/git/defaultReviewers';
import { ShortlogEntry } from '../../src/git/filesIOwn';

const AUTHOR = { email: 'sanjay@example.com', name: 'Sanjay', handle: 'sanjays2402' };

test('buildFromShortlog: empty inputs return empty array', () => {
  assert.deepEqual(buildFromShortlog({ shortlog: [], changedPaths: [], author: AUTHOR }), []);
  assert.deepEqual(buildFromShortlog({ shortlog: [], changedPaths: ['a'], author: AUTHOR }), []);
  assert.deepEqual(buildFromShortlog({
    shortlog: [{ path: 'a', byAuthor: { 'alice@x': 3 } }],
    changedPaths: [],
    author: AUTHOR,
  }), []);
});

test('buildFromShortlog: ranks by changed-paths coverage, sorts by handle', () => {
  const shortlog: ShortlogEntry[] = [
    { path: 'src/a.ts', byAuthor: { 'alice@x': 4, 'bob@x': 1 } as Record<string, number> },
    { path: 'src/b.ts', byAuthor: { 'bob@x':   2, 'alice@x': 1 } as Record<string, number> },
    { path: 'src/c.ts', byAuthor: { 'alice@x': 1 } as Record<string, number> },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    author: AUTHOR,
  });
  const alice = out.find(r => r.handle === 'alice');
  const bob = out.find(r => r.handle === 'bob');
  assert.ok(alice);
  assert.ok(bob);
  // Alice covers all 3, Bob covers 2.
  assert.equal(alice!.ownedPaths.length, 3);
  assert.equal(bob!.ownedPaths.length, 2);
  // Alice should be first (higher coverage).
  assert.equal(out[0].handle, 'alice');
});

test('buildFromShortlog: drops author + extraExcluded', () => {
  const shortlog = [
    { path: 'a.ts', byAuthor: { 'sanjay@example.com': 5, 'alice@x': 2 } },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
    extraExcluded: ['alice'],
  });
  assert.equal(out.length, 0); // both author + alice dropped
});

test('buildFromShortlog: drops bot-like identities', () => {
  const shortlog = [
    { path: 'a.ts', byAuthor: {
      'dependabot@github.com': 10,
      'renovate@x': 5,
      'github-actions[bot]@noreply': 3,
      'alice@x': 1,
    } },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('buildFromShortlog: identityToHandle preserves real GitHub handles', () => {
  const shortlog = [
    { path: 'a.ts', byAuthor: { 'alice@example.com': 5 } },
  ];
  const index = buildIdentityIndex([
    { identity: 'alice@example.com', handle: 'aliceGitHub' },
  ]);
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
    identityToHandle: index,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alicegithub');
  assert.equal(out[0].displayHandle, '@alicegithub');
});

test('buildFromShortlog: perTierLimit caps each tier', () => {
  const byAuthor: Record<string, number> = {};
  for (let i = 0; i < 10; i++) byAuthor[`user${i}@x`] = i + 1;
  const shortlog: ShortlogEntry[] = [{ path: 'a.ts', byAuthor }];
  // All 10 users own the single changed path -> single tier of 10.
  // Default perTierLimit = 5 should cap to 5.
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
  });
  assert.equal(out.length, 5);
});

test('buildFromShortlog: perTierLimit=0 means no cap', () => {
  const byAuthor: Record<string, number> = {};
  for (let i = 0; i < 10; i++) byAuthor[`user${i}@x`] = 1;
  const shortlog: ShortlogEntry[] = [{ path: 'a.ts', byAuthor }];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
    perTierLimit: 0,
  });
  assert.equal(out.length, 10);
});

test('buildFromShortlog: round-robin re-rank composes correctly', () => {
  const shortlog = [
    { path: 'a.ts', byAuthor: { 'alice@x': 3, 'bob@x': 3, 'carol@x': 3 } },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
  });
  // All three cover the single file equally -> single tier sorted alphabetically.
  assert.deepEqual(out.map(r => r.handle), ['alice', 'bob', 'carol']);

  // Apply round-robin re-rank with carol being heavily loaded.
  const load = new Map([['carol', 10], ['alice', 5], ['bob', 0]]);
  const reranked = rerankRoundRobin({ suggestions: out, loadByHandle: load });
  assert.deepEqual(reranked.map(r => r.handle), ['bob', 'alice', 'carol']);
});

test('buildFromShortlog: literal-email author exclusion (does NOT match by local-part across domains)', () => {
  // Author email is sanjay@example.com. We only drop that exact email.
  // sanjay@personal.com is treated as a separate identity — local-part
  // matching across different domains is too aggressive (different orgs
  // can share names). Use the `extraExcluded` config for that case.
  const shortlog: ShortlogEntry[] = [
    { path: 'a.ts', byAuthor: { 'sanjay@example.com': 5, 'sanjay@personal.com': 3, 'alice@x': 1 } as Record<string, number> },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
  });
  // Author's literal email dropped; the other "sanjay" stays.
  const handles = out.map(r => r.handle).sort();
  assert.deepEqual(handles, ['alice', 'sanjay']);
});

test('buildFromShortlog: extraExcluded as local-part drops both author + variant', () => {
  const shortlog: ShortlogEntry[] = [
    { path: 'a.ts', byAuthor: { 'sanjay@example.com': 5, 'sanjay@personal.com': 3, 'alice@x': 1 } as Record<string, number> },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
    extraExcluded: ['sanjay'], // explicit local-part exclude
  });
  // Now both sanjay identities are dropped via the explicit local-part match.
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('buildFromShortlog: ignores authors who only touched unchanged files', () => {
  const shortlog: ShortlogEntry[] = [
    { path: 'a.ts',          byAuthor: { 'alice@x': 5 } as Record<string, number> },
    { path: 'untouched.ts',  byAuthor: { 'bob@x':   100 } as Record<string, number> },
  ];
  const out = buildFromShortlog({
    shortlog,
    changedPaths: ['a.ts'],
    author: AUTHOR,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].handle, 'alice');
});

test('buildIdentityIndex: builds lower-cased map, skips bad rows', () => {
  const m = buildIdentityIndex([
    { identity: 'Alice@Example.Com', handle: '@AliceGH' },
    { identity: '', handle: 'bad' } as any,
    { identity: 'no-handle@x', handle: '' } as any,
    { identity: 'bob@x', handle: 'bobgh' },
  ]);
  assert.equal(m.get('alice@example.com'), '@alicegh');
  assert.equal(m.get('bob@x'), 'bobgh');
  assert.equal(m.size, 2);
});

// ─────────── F96: self-review verdict ───────────

test('classifySelfReview: returns ok when suggestions are non-empty', () => {
  const verdict = classifySelfReview({
    suggestions: [{ handle: 'x', displayHandle: '@x', kind: 'user', ownedPaths: ['a'], coverage: 1 }],
    shortlog: [],
    changedPaths: ['a'],
    author: AUTHOR,
  });
  assert.equal(verdict, 'ok');
});

test('classifySelfReview: self-dominant when only author shows in shortlog', () => {
  const shortlog: ShortlogEntry[] = [
    { path: 'src/foo.ts', byAuthor: { 'sanjay@example.com': 10 } },
  ];
  const verdict = classifySelfReview({
    suggestions: [],
    shortlog,
    changedPaths: ['src/foo.ts'],
    author: AUTHOR,
  });
  assert.equal(verdict, 'self-dominant');
});

test('classifySelfReview: bot-only when every non-author is a bot', () => {
  const shortlog: ShortlogEntry[] = [
    {
      path: 'src/foo.ts',
      byAuthor: {
        'sanjay@example.com': 5,
        'dependabot[bot]@users.noreply.github.com': 3,
        '49699333+github-actions[bot]@users.noreply.github.com': 2,
      },
    },
  ];
  const verdict = classifySelfReview({
    suggestions: [],
    shortlog,
    changedPaths: ['src/foo.ts'],
    author: AUTHOR,
  });
  assert.equal(verdict, 'bot-only');
});

test('classifySelfReview: self-dominant when other humans exist but suggestion list is empty (extraExcluded)', () => {
  // Simulates the case where buildFromShortlog filtered everyone out via
  // extraExcluded — the classifier sees non-bot identities AND falls
  // through to the safe self-dominant branch.
  const shortlog: ShortlogEntry[] = [
    {
      path: 'src/foo.ts',
      byAuthor: { 'sanjay@example.com': 5, 'alice@example.com': 3 },
    },
  ];
  const verdict = classifySelfReview({
    suggestions: [],
    shortlog,
    changedPaths: ['src/foo.ts'],
    author: AUTHOR,
  });
  assert.equal(verdict, 'self-dominant');
});

test('classifySelfReview: no-history when changed paths have no shortlog entries', () => {
  const verdict = classifySelfReview({
    suggestions: [],
    shortlog: [{ path: 'unrelated.ts', byAuthor: { 'alice@example.com': 1 } }],
    changedPaths: ['new-file.ts'],
    author: AUTHOR,
  });
  assert.equal(verdict, 'no-history');
});

test('classifySelfReview: no-history when changedPaths is empty', () => {
  const verdict = classifySelfReview({
    suggestions: [],
    shortlog: [],
    changedPaths: [],
    author: AUTHOR,
  });
  assert.equal(verdict, 'no-history');
});

test('classifySelfReview: matches author by local-part too', () => {
  // Some shortlogs have only the local-part (without the @domain).
  const shortlog: ShortlogEntry[] = [
    { path: 'src/foo.ts', byAuthor: { sanjay: 10 } },
  ];
  const verdict = classifySelfReview({
    suggestions: [],
    shortlog,
    changedPaths: ['src/foo.ts'],
    author: AUTHOR,
  });
  assert.equal(verdict, 'self-dominant');
});

test('buildSelfReviewHint: emits Files-I-Own command for self-dominant + bot-only', () => {
  const sd = buildSelfReviewHint('self-dominant', 4);
  assert.match(sd.summary, /4 files/);
  assert.equal(sd.suggestedCommand, 'gitsight.filesIOwn');
  const bo = buildSelfReviewHint('bot-only', 1);
  assert.match(bo.summary, /1 file/);
  assert.equal(bo.suggestedCommand, 'gitsight.filesIOwn');
});

test('buildSelfReviewHint: no-history mentions new files', () => {
  const h = buildSelfReviewHint('no-history', 2);
  assert.match(h.summary, /new/);
  assert.equal(h.suggestedCommand, undefined);
});

test('buildSelfReviewHint: degraded mentions shallow-clone hint', () => {
  const h = buildSelfReviewHint('degraded', 3);
  assert.match(h.detail, /shallow/i);
  assert.match(h.detail, /unshallow/);
  assert.equal(h.suggestedCommand, undefined);
});

test('buildSelfReviewHint: ok verdict returns empty strings', () => {
  const h = buildSelfReviewHint('ok', 0);
  assert.equal(h.summary, '');
  assert.equal(h.detail, '');
});
