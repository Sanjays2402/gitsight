import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  composeReviewerRanking,
  describeSuggestionWithLoadScore,
  ReviewerSuggestion,
  LoadScoreEntry,
} from '../../src/git/defaultReviewers';

function sug(handle: string, ownedCount: number, kind: 'user' | 'team' = 'user'): ReviewerSuggestion {
  return {
    handle: handle.toLowerCase(),
    displayHandle: `@${handle.toLowerCase()}`,
    kind,
    ownedPaths: Array.from({ length: ownedCount }, (_, i) => `src/${handle}/${i}.ts`),
    coverage: ownedCount / 5,
  };
}

// ── composeReviewerRanking ────────────────────────────────────────────

test('composeReviewerRanking: empty input returns empty + coverage-only source', () => {
  const r = composeReviewerRanking({ suggestions: [] });
  assert.equal(r.source, 'coverage-only');
  assert.deepEqual(r.ranked, []);
});

test('composeReviewerRanking: no signals -> coverage-only, input order preserved within tier', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3), sug('carol', 2)];
  const r = composeReviewerRanking({ suggestions });
  assert.equal(r.source, 'coverage-only');
  assert.deepEqual(r.ranked.map(s => s.handle), ['alice', 'bob', 'carol']);
});

test('composeReviewerRanking: only loadByHandle present -> round-robin source, lower load wins within tier', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3), sug('carol', 3)];
  const loadByHandle = new Map([['alice', 5], ['bob', 1], ['carol', 3]]);
  const r = composeReviewerRanking({ suggestions, loadByHandle });
  assert.equal(r.source, 'round-robin');
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'carol', 'alice']);
});

test('composeReviewerRanking: only scoresByHandle present -> load-score source, lower score wins within tier', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3), sug('carol', 3)];
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 25 }],
    ['bob',   { handle: 'bob',   score: 5 }],
    ['carol', { handle: 'carol', score: 15 }],
  ]);
  const r = composeReviewerRanking({ suggestions, scoresByHandle });
  assert.equal(r.source, 'load-score');
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'carol', 'alice']);
});

test('composeReviewerRanking: scoresByHandle WINS over loadByHandle when both present', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3), sug('carol', 3)];
  // round-robin says alice first (lowest load), but score says bob first.
  const loadByHandle = new Map([['alice', 1], ['bob', 5], ['carol', 3]]);
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 99 }],
    ['bob',   { handle: 'bob',   score: 1 }],
    ['carol', { handle: 'carol', score: 50 }],
  ]);
  const r = composeReviewerRanking({ suggestions, loadByHandle, scoresByHandle });
  assert.equal(r.source, 'load-score');
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'carol', 'alice']);
});

test('composeReviewerRanking: empty scoresByHandle falls back to round-robin', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3)];
  const loadByHandle = new Map([['alice', 5], ['bob', 1]]);
  const scoresByHandle = new Map<string, LoadScoreEntry>();
  const r = composeReviewerRanking({ suggestions, loadByHandle, scoresByHandle });
  assert.equal(r.source, 'round-robin');
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'alice']);
});

test('composeReviewerRanking: scores not matching ANY handle falls back to round-robin', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3)];
  const loadByHandle = new Map([['alice', 5], ['bob', 1]]);
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['someone-else', { handle: 'someone-else', score: 1 }],
  ]);
  const r = composeReviewerRanking({ suggestions, loadByHandle, scoresByHandle });
  assert.equal(r.source, 'round-robin');
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'alice']);
});

test('composeReviewerRanking: partial score coverage uses score (unknown -> POSITIVE_INFINITY, sinks below all known)', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3), sug('carol', 3)];
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['bob', { handle: 'bob', score: 10 }],
  ]);
  const r = composeReviewerRanking({ suggestions, scoresByHandle });
  assert.equal(r.source, 'load-score');
  // bob has a score (10); alice and carol are unknown (+Inf) — they sort
  // alphabetically among themselves via the user/handle tiebreaker.
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'alice', 'carol']);
});

test('composeReviewerRanking: HIGHER coverage tier always wins regardless of score', () => {
  const suggestions = [sug('alice', 1), sug('bob', 4), sug('carol', 4)];
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 0 }],   // fastest, BUT lower coverage
    ['bob',   { handle: 'bob',   score: 50 }],
    ['carol', { handle: 'carol', score: 30 }],
  ]);
  const r = composeReviewerRanking({ suggestions, scoresByHandle });
  // bob + carol share tier 4 (top), sorted by score: carol then bob.
  // alice is tier 1 — always below the top tier.
  assert.deepEqual(r.ranked.map(s => s.handle), ['carol', 'bob', 'alice']);
});

test('composeReviewerRanking: tie-broken by user-before-team then alpha', () => {
  const suggestions = [
    sug('core', 3, 'team'),
    sug('alice', 3, 'user'),
    sug('bob', 3, 'user'),
  ];
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['core',  { handle: 'core',  score: 10 }],
    ['alice', { handle: 'alice', score: 10 }],
    ['bob',   { handle: 'bob',   score: 10 }],
  ]);
  const r = composeReviewerRanking({ suggestions, scoresByHandle });
  // All same score -> users first, then alphabetical.
  assert.deepEqual(r.ranked.map(s => s.handle), ['alice', 'bob', 'core']);
});

test('composeReviewerRanking: handle case folded for score lookup', () => {
  const suggestions = [sug('Alice', 3), sug('BOB', 3)];
  // Stored lower-case scores; suggestion handles already get lowercased
  // by the sug() helper, but mixed-case scoresByHandle keys should still
  // resolve via the lowercase comparison inside rerankByScores.
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 100 }],
    ['bob',   { handle: 'bob',   score: 1 }],
  ]);
  const r = composeReviewerRanking({ suggestions, scoresByHandle });
  assert.deepEqual(r.ranked.map(s => s.handle), ['bob', 'alice']);
});

test('composeReviewerRanking: does NOT mutate input array', () => {
  const suggestions = [sug('alice', 3), sug('bob', 3)];
  const original = suggestions.slice();
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 99 }],
    ['bob',   { handle: 'bob',   score: 1 }],
  ]);
  composeReviewerRanking({ suggestions, scoresByHandle });
  assert.deepEqual(suggestions.map(s => s.handle), original.map(s => s.handle));
});

// ── describeSuggestionWithLoadScore ───────────────────────────────────

test('describeSuggestionWithLoadScore: known handle renders rounded score', () => {
  const s = sug('alice', 3);
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 12.456 }],
  ]);
  const out = describeSuggestionWithLoadScore(s, 5, scoresByHandle);
  assert.match(out, /load 12\.5$/);
  // Description should still include the coverage base "owns N/M".
  assert.match(out, /owns 3\/5/);
});

test('describeSuggestionWithLoadScore: unknown handle gets neutral no-signal marker', () => {
  const s = sug('alice', 2);
  const scoresByHandle = new Map<string, LoadScoreEntry>();
  const out = describeSuggestionWithLoadScore(s, 5, scoresByHandle);
  assert.match(out, /load \u2014 \(no signal\)$/);
  assert.match(out, /owns 2\/5/);
});

test('describeSuggestionWithLoadScore: negative score formats without leading +', () => {
  const s = sug('alice', 3);
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: -4.23 }],
  ]);
  const out = describeSuggestionWithLoadScore(s, 5, scoresByHandle);
  assert.match(out, /load -4\.2$/);
});

test('describeSuggestionWithLoadScore: integer score still shows one decimal place', () => {
  const s = sug('alice', 3);
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 5 }],
  ]);
  const out = describeSuggestionWithLoadScore(s, 5, scoresByHandle);
  assert.match(out, /load 5\.0$/);
});

test('describeSuggestionWithLoadScore: zero score shows as 0.0 (not omitted)', () => {
  const s = sug('alice', 3);
  const scoresByHandle = new Map<string, LoadScoreEntry>([
    ['alice', { handle: 'alice', score: 0 }],
  ]);
  const out = describeSuggestionWithLoadScore(s, 5, scoresByHandle);
  assert.match(out, /load 0\.0$/);
});
