import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyInsertOffer,
  describeInsertOffer,
  describeInsertOfferSkip,
  shouldRememberDismissal,
  dismissalCacheKey,
  InsertOfferOutcome,
} from '../../src/git/testImpactPrBodyInsertOffer';
import { TEST_IMPACT_OPEN_MARKER, TEST_IMPACT_CLOSE_MARKER } from '../../src/git/testImpactPrBody';

const baseArgs = {
  enabled: true,
  prBody: 'some body',
  changedFileCount: 5,
  minimumFileCount: 3,
  isDraft: false,
  alreadyDismissed: false,
};

// ── classifyInsertOffer ──────────────────────────────────────────────

test('classifyInsertOffer: happy path -> offer', () => {
  assert.equal(classifyInsertOffer(baseArgs), 'offer');
});

test('classifyInsertOffer: disabled -> skip-disabled', () => {
  assert.equal(classifyInsertOffer({ ...baseArgs, enabled: false }), 'skip-disabled');
});

test('classifyInsertOffer: undefined body -> skip-no-pr', () => {
  assert.equal(classifyInsertOffer({ ...baseArgs, prBody: undefined }), 'skip-no-pr');
});

test('classifyInsertOffer: body already has the block -> skip-already-present', () => {
  const body = `intro\n\n${TEST_IMPACT_OPEN_MARKER}\nrows\n${TEST_IMPACT_CLOSE_MARKER}\nepilogue`;
  assert.equal(classifyInsertOffer({ ...baseArgs, prBody: body }), 'skip-already-present');
});

test('classifyInsertOffer: dismissed -> skip-dismissed', () => {
  assert.equal(classifyInsertOffer({ ...baseArgs, alreadyDismissed: true }), 'skip-dismissed');
});

test('classifyInsertOffer: draft -> skip-draft', () => {
  assert.equal(classifyInsertOffer({ ...baseArgs, isDraft: true }), 'skip-draft');
});

test('classifyInsertOffer: small PR -> skip-too-small', () => {
  assert.equal(classifyInsertOffer({ ...baseArgs, changedFileCount: 2 }), 'skip-too-small');
});

test('classifyInsertOffer: threshold honoured exactly', () => {
  // 3 files vs threshold 3 -> offer (>= 3); 2 vs 3 -> too-small.
  assert.equal(classifyInsertOffer({ ...baseArgs, changedFileCount: 3, minimumFileCount: 3 }), 'offer');
  assert.equal(classifyInsertOffer({ ...baseArgs, changedFileCount: 2, minimumFileCount: 3 }), 'skip-too-small');
});

test('classifyInsertOffer: threshold of 0 still requires at least 1 file', () => {
  // We clamp the minimum to 1 to keep the gate sane.
  assert.equal(classifyInsertOffer({ ...baseArgs, changedFileCount: 0, minimumFileCount: 0 }), 'skip-too-small');
  assert.equal(classifyInsertOffer({ ...baseArgs, changedFileCount: 1, minimumFileCount: 0 }), 'offer');
});

test('classifyInsertOffer: enabled gate beats every other check', () => {
  assert.equal(
    classifyInsertOffer({
      enabled: false,
      prBody: undefined,
      changedFileCount: 0,
      minimumFileCount: 100,
      isDraft: true,
      alreadyDismissed: true,
    }),
    'skip-disabled',
  );
});

test('classifyInsertOffer: no-pr beats already-present + dismissed', () => {
  assert.equal(
    classifyInsertOffer({
      ...baseArgs,
      prBody: undefined,
      alreadyDismissed: true,
    }),
    'skip-no-pr',
  );
});

test('classifyInsertOffer: already-present beats dismissed + draft + too-small', () => {
  const body = `${TEST_IMPACT_OPEN_MARKER}\n${TEST_IMPACT_CLOSE_MARKER}`;
  assert.equal(
    classifyInsertOffer({
      ...baseArgs,
      prBody: body,
      alreadyDismissed: true,
      isDraft: true,
      changedFileCount: 0,
    }),
    'skip-already-present',
  );
});

test('classifyInsertOffer: dismissed beats draft + too-small', () => {
  assert.equal(
    classifyInsertOffer({
      ...baseArgs,
      alreadyDismissed: true,
      isDraft: true,
      changedFileCount: 0,
    }),
    'skip-dismissed',
  );
});

test('classifyInsertOffer: draft beats too-small', () => {
  // Defensive ordering test: a draft 1-file PR should report 'skip-draft'
  // not 'skip-too-small' so the user knows the gate is draft-related.
  assert.equal(
    classifyInsertOffer({ ...baseArgs, isDraft: true, changedFileCount: 1 }),
    'skip-draft',
  );
});

// ── describeInsertOffer ──────────────────────────────────────────────

test('describeInsertOffer: includes PR number + file count', () => {
  const s = describeInsertOffer({ prNumber: 42, fileCount: 7 });
  assert.match(s, /PR #42/);
  assert.match(s, /7 files/);
  assert.match(s, /test-impact summary/);
});

// ── describeInsertOfferSkip ──────────────────────────────────────────

test('describeInsertOfferSkip: each skip outcome has unique copy', () => {
  const outcomes: Array<Exclude<InsertOfferOutcome, 'offer'>> = [
    'skip-disabled', 'skip-no-pr', 'skip-already-present',
    'skip-dismissed', 'skip-draft', 'skip-too-small',
  ];
  const seen = new Set<string>();
  for (const o of outcomes) {
    const s = describeInsertOfferSkip(o);
    assert.ok(s, `${o} has copy`);
    assert.ok(!seen.has(s), `${o} copy is unique`);
    seen.add(s);
  }
});

// ── shouldRememberDismissal ──────────────────────────────────────────

test('shouldRememberDismissal: offer + actionable skips -> true', () => {
  assert.equal(shouldRememberDismissal('offer'), true);
  assert.equal(shouldRememberDismissal('skip-draft'), true);
  assert.equal(shouldRememberDismissal('skip-too-small'), true);
});

test('shouldRememberDismissal: structural skips -> false', () => {
  assert.equal(shouldRememberDismissal('skip-disabled'), false);
  assert.equal(shouldRememberDismissal('skip-no-pr'), false);
  assert.equal(shouldRememberDismissal('skip-already-present'), false);
  assert.equal(shouldRememberDismissal('skip-dismissed'), false);
});

// ── dismissalCacheKey ────────────────────────────────────────────────

test('dismissalCacheKey: normalises host + strips trailing slashes', () => {
  const a = dismissalCacheKey('https://GitHub.com/Owner/Repo/pull/42/');
  const b = dismissalCacheKey('https://github.com/owner/repo/pull/42');
  assert.equal(a, b);
});

test('dismissalCacheKey: empty input -> empty key', () => {
  assert.equal(dismissalCacheKey(''), '');
});

test('dismissalCacheKey: non-URL falls back to lowercase literal', () => {
  // For unusual inputs (e.g. a test fixture), we still produce a stable key.
  const key = dismissalCacheKey('FOO//bar');
  // Trailing slashes are stripped by the regex - "FOO//bar".replace(/\/+$/, '')
  // leaves the embedded // intact, and lowercase converts to "foo//bar".
  assert.equal(key, 'foo//bar');
});

test('dismissalCacheKey: different paths produce different keys', () => {
  const a = dismissalCacheKey('https://github.com/owner/repo/pull/42');
  const b = dismissalCacheKey('https://github.com/owner/repo/pull/43');
  assert.notEqual(a, b);
});
