import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyBranchRole,
  suggestProtectionRules,
  buildProtectionPutBody,
  buildSuggestionPreview,
  describeSuggestionVerdict,
  BranchRole,
  RuleSuggestion,
  EnvironmentSignals,
} from '../../src/git/branchProtectionSuggest';
import type { ProtectionDecision, ProtectionRule } from '../../src/git/forcePushGuard';

const noSignals: EnvironmentSignals = {
  hasCiWorkflows: false,
  hasCodeowners: false,
  hasSignedCommits: false,
};

const fullSignals: EnvironmentSignals = {
  hasCiWorkflows: true,
  workflowJobNames: ['ci', 'lint', 'test'],
  hasCodeowners: true,
  hasSignedCommits: true,
  recentCommitCount: 50,
};

function unprotected(): ProtectionDecision {
  return { kind: 'unprotected' };
}

function protectedWith(ids: Array<ProtectionRule['id']>): ProtectionDecision {
  return {
    kind: 'protected',
    allowsForcePush: !ids.includes('force-push' as any),
    rules: ids.map(id => ({ id, enabled: true, label: id })),
  };
}

// ── classifyBranchRole ────────────────────────────────────────────────
test('classifyBranchRole: matches the repo default branch by name', () => {
  assert.equal(classifyBranchRole({ branch: 'main', defaultBranch: 'main' }), 'default');
  assert.equal(classifyBranchRole({ branch: 'trunk', defaultBranch: 'trunk' }), 'default');
});

test('classifyBranchRole: main/master/trunk default even without metadata', () => {
  assert.equal(classifyBranchRole({ branch: 'main' }), 'default');
  assert.equal(classifyBranchRole({ branch: 'master' }), 'default');
  assert.equal(classifyBranchRole({ branch: 'TRUNK' }), 'default');
});

test('classifyBranchRole: release/* and v1.x shapes -> release', () => {
  assert.equal(classifyBranchRole({ branch: 'release/2026.q2' }), 'release');
  assert.equal(classifyBranchRole({ branch: 'release-1.0' }), 'release');
  assert.equal(classifyBranchRole({ branch: 'production' }), 'release');
  assert.equal(classifyBranchRole({ branch: 'stable' }), 'release');
  assert.equal(classifyBranchRole({ branch: 'v1.x' }), 'release');
  assert.equal(classifyBranchRole({ branch: '1.2.3' }), 'release');
});

test('classifyBranchRole: hotfix/fix/patch -> hotfix', () => {
  assert.equal(classifyBranchRole({ branch: 'hotfix/CVE-2026' }), 'hotfix');
  assert.equal(classifyBranchRole({ branch: 'fix/login-bug' }), 'hotfix');
  assert.equal(classifyBranchRole({ branch: 'patch/dep-bump' }), 'hotfix');
});

test('classifyBranchRole: develop/staging/qa -> long-lived', () => {
  assert.equal(classifyBranchRole({ branch: 'develop' }), 'long-lived');
  assert.equal(classifyBranchRole({ branch: 'staging' }), 'long-lived');
  assert.equal(classifyBranchRole({ branch: 'qa' }), 'long-lived');
  assert.equal(classifyBranchRole({ branch: 'preview' }), 'long-lived');
  assert.equal(classifyBranchRole({ branch: 'canary' }), 'long-lived');
});

test('classifyBranchRole: feature/feat/chore/refactor -> feature', () => {
  assert.equal(classifyBranchRole({ branch: 'feature/login' }), 'feature');
  assert.equal(classifyBranchRole({ branch: 'feat/oauth' }), 'feature');
  assert.equal(classifyBranchRole({ branch: 'chore/deps' }), 'feature');
});

test('classifyBranchRole: unknown shapes -> other', () => {
  assert.equal(classifyBranchRole({ branch: 'random' }), 'other');
  assert.equal(classifyBranchRole({ branch: 'topic/x' }), 'other');
});

test('classifyBranchRole: empty input -> other', () => {
  assert.equal(classifyBranchRole({ branch: '' }), 'other');
});

// ── suggestProtectionRules ────────────────────────────────────────────
test('suggestProtectionRules: default branch baseline includes review + force-push + deletion', () => {
  const out = suggestProtectionRules({
    branch: 'main', role: 'default', current: unprotected(), signals: noSignals,
  });
  const ids = out.map(s => s.id);
  assert.ok(ids.includes('required-reviews'));
  assert.ok(ids.includes('force-push'));
  assert.ok(ids.includes('deletions'));
});

test('suggestProtectionRules: release branch adds required-linear-history', () => {
  const out = suggestProtectionRules({
    branch: 'release/2026.q2', role: 'release', current: unprotected(), signals: noSignals,
  });
  const ids = out.map(s => s.id);
  assert.ok(ids.includes('required-linear-history'));
});

test('suggestProtectionRules: long-lived branches get status-check suggestion', () => {
  const out = suggestProtectionRules({
    branch: 'develop', role: 'long-lived', current: unprotected(), signals: fullSignals,
  });
  const ids = out.map(s => s.id);
  assert.ok(ids.includes('required-status-checks'));
});

test('suggestProtectionRules: hotfix gets review + status-check', () => {
  const out = suggestProtectionRules({
    branch: 'hotfix/CVE', role: 'hotfix', current: unprotected(), signals: fullSignals,
  });
  const ids = out.map(s => s.id);
  assert.ok(ids.includes('required-reviews'));
  assert.ok(ids.includes('required-status-checks'));
});

test('suggestProtectionRules: feature branches get NO suggestions (ephemeral)', () => {
  const out = suggestProtectionRules({
    branch: 'feature/login', role: 'feature', current: unprotected(), signals: fullSignals,
  });
  assert.equal(out.length, 0);
});

test('suggestProtectionRules: skips rules already enabled', () => {
  const out = suggestProtectionRules({
    branch: 'main', role: 'default',
    current: protectedWith(['required-reviews', 'force-push']),
    signals: noSignals,
  });
  const ids = out.map(s => s.id);
  assert.ok(!ids.includes('required-reviews'));
  assert.ok(!ids.includes('force-push'));
  // Still recommends deletions
  assert.ok(ids.includes('deletions'));
});

test('suggestProtectionRules: signed-commit rule only when history includes them', () => {
  const withoutSigs = suggestProtectionRules({
    branch: 'main', role: 'default', current: unprotected(), signals: noSignals,
  });
  assert.ok(!withoutSigs.map(s => s.id).includes('required-signatures'));
  const withSigs = suggestProtectionRules({
    branch: 'main', role: 'default', current: unprotected(), signals: fullSignals,
  });
  assert.ok(withSigs.map(s => s.id).includes('required-signatures'));
});

test('suggestProtectionRules: enforce-admins is aggressive tier, not recommended', () => {
  const out = suggestProtectionRules({
    branch: 'main', role: 'default', current: unprotected(), signals: noSignals,
  });
  const admin = out.find(s => s.id === 'enforce-admins');
  assert.ok(admin);
  assert.equal(admin!.strength, 'aggressive');
});

test('suggestProtectionRules: status-check strength tied to CI presence', () => {
  const noCi = suggestProtectionRules({
    branch: 'develop', role: 'long-lived', current: unprotected(), signals: noSignals,
  });
  const withCi = suggestProtectionRules({
    branch: 'develop', role: 'long-lived', current: unprotected(), signals: fullSignals,
  });
  const noCiRule = noCi.find(s => s.id === 'required-status-checks')!;
  const withCiRule = withCi.find(s => s.id === 'required-status-checks')!;
  assert.equal(noCiRule.strength, 'optional');
  assert.equal(withCiRule.strength, 'recommended');
});

test('suggestProtectionRules: sorted by weight desc then strength', () => {
  const out = suggestProtectionRules({
    branch: 'main', role: 'default', current: unprotected(), signals: fullSignals,
  });
  // weight 100 (review) comes before 90 (force-push) comes before 80 (deletions)
  const weights = out.map(s => s.weight);
  for (let i = 1; i < weights.length; i++) {
    assert.ok(weights[i] <= weights[i - 1], `weight should be non-increasing, got ${weights}`);
  }
});

// ── buildProtectionPutBody ────────────────────────────────────────────
test('buildProtectionPutBody: empty picks + empty current -> all null/false', () => {
  const body = buildProtectionPutBody({ picked: [], currentlyEnabled: new Set() });
  assert.equal(body.required_status_checks, null);
  assert.equal(body.required_pull_request_reviews, null);
  assert.equal(body.allow_force_pushes, true); // !force-push-blocked
  assert.equal(body.allow_deletions, true);    // !deletions-blocked
  assert.equal(body.required_linear_history, false);
  assert.equal(body.required_signatures, false);
});

test('buildProtectionPutBody: picked force-push disables force-pushes', () => {
  const body = buildProtectionPutBody({ picked: ['force-push'], currentlyEnabled: new Set() });
  assert.equal(body.allow_force_pushes, false);
});

test('buildProtectionPutBody: picked deletions disables deletions', () => {
  const body = buildProtectionPutBody({ picked: ['deletions'], currentlyEnabled: new Set() });
  assert.equal(body.allow_deletions, false);
});

test('buildProtectionPutBody: status-check rule expands to object with contexts', () => {
  const body = buildProtectionPutBody({
    picked: ['required-status-checks'],
    currentlyEnabled: new Set(),
    statusCheckContexts: ['ci', 'lint'],
  });
  assert.deepEqual(body.required_status_checks, { strict: true, contexts: ['ci', 'lint'] });
});

test('buildProtectionPutBody: required-reviews expands to object with review-count', () => {
  const body = buildProtectionPutBody({
    picked: ['required-reviews'],
    currentlyEnabled: new Set(),
    requiredApprovingReviewCount: 2,
  });
  assert.ok(body.required_pull_request_reviews);
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(body.required_pull_request_reviews.dismiss_stale_reviews, true);
});

test('buildProtectionPutBody: required-reviews defaults to 1 when count not given', () => {
  const body = buildProtectionPutBody({ picked: ['required-reviews'], currentlyEnabled: new Set() });
  assert.equal(body.required_pull_request_reviews.required_approving_review_count, 1);
});

test('buildProtectionPutBody: preserves currently-enabled rules not in picked list', () => {
  // If admins were already on and the user didn't change anything, the
  // PUT body should still emit enforce_admins=true to AVOID downgrading.
  const body = buildProtectionPutBody({
    picked: ['required-reviews'],
    currentlyEnabled: new Set(['enforce-admins', 'required-linear-history']),
  });
  assert.equal(body.enforce_admins, true);
  assert.equal(body.required_linear_history, true);
});

test('buildProtectionPutBody: enforce_admins=null when not enabled (GitHub semantics)', () => {
  const body = buildProtectionPutBody({ picked: ['required-reviews'], currentlyEnabled: new Set() });
  assert.equal(body.enforce_admins, null);
});

test('buildProtectionPutBody: signed-commits + lock-branch boolean fields', () => {
  const body = buildProtectionPutBody({
    picked: ['required-signatures', 'lock-branch'],
    currentlyEnabled: new Set(),
  });
  assert.equal(body.required_signatures, true);
  assert.equal(body.lock_branch, true);
});

// ── buildSuggestionPreview ────────────────────────────────────────────
test('buildSuggestionPreview: empty suggestions -> "already covered" stub', () => {
  const md = buildSuggestionPreview({
    branch: 'main', role: 'default', suggestions: [], signals: noSignals,
  });
  assert.match(md, /already covers the recommended baseline/);
});

test('buildSuggestionPreview: groups suggestions by strength tier', () => {
  const suggestions: RuleSuggestion[] = [
    { id: 'required-reviews', label: 'Review', rationale: 'why', strength: 'recommended', weight: 100 },
    { id: 'required-signatures', label: 'Signed', rationale: 'why2', strength: 'optional', weight: 50 },
    { id: 'enforce-admins', label: 'Admins', rationale: 'why3', strength: 'aggressive', weight: 30 },
  ];
  const md = buildSuggestionPreview({
    branch: 'main', role: 'default', suggestions, signals: noSignals,
  });
  assert.match(md, /## Recommended/);
  assert.match(md, /## Optional/);
  assert.match(md, /## Aggressive/);
  // Order: Recommended block appears BEFORE Optional appears BEFORE Aggressive.
  const recIdx = md.indexOf('## Recommended');
  const optIdx = md.indexOf('## Optional');
  const aggIdx = md.indexOf('## Aggressive');
  assert.ok(recIdx < optIdx && optIdx < aggIdx);
});

test('buildSuggestionPreview: omits empty tiers', () => {
  const md = buildSuggestionPreview({
    branch: 'main', role: 'default',
    suggestions: [
      { id: 'required-reviews', label: 'Review', rationale: 'why', strength: 'recommended', weight: 100 },
    ],
    signals: noSignals,
  });
  assert.match(md, /## Recommended/);
  assert.ok(!md.includes('## Optional'));
  assert.ok(!md.includes('## Aggressive'));
});

test('buildSuggestionPreview: includes workflow contexts section when signals present', () => {
  const md = buildSuggestionPreview({
    branch: 'main', role: 'default',
    suggestions: [
      { id: 'required-status-checks', label: 'Status', rationale: 'why', strength: 'recommended', weight: 75 },
    ],
    signals: fullSignals,
  });
  assert.match(md, /## Workflow contexts/);
  assert.match(md, /`ci`/);
  assert.match(md, /`lint`/);
});

// ── describeSuggestionVerdict ─────────────────────────────────────────
test('describeSuggestionVerdict: empty suggestions -> "already covered"', () => {
  assert.equal(
    describeSuggestionVerdict({ branch: 'main', suggestions: [] }),
    'main - already covered',
  );
});

test('describeSuggestionVerdict: counts per strength', () => {
  const out = describeSuggestionVerdict({
    branch: 'release/x',
    suggestions: [
      { id: 'required-reviews', label: 'a', rationale: 'b', strength: 'recommended', weight: 1 },
      { id: 'force-push', label: 'a', rationale: 'b', strength: 'recommended', weight: 1 },
      { id: 'enforce-admins', label: 'a', rationale: 'b', strength: 'aggressive', weight: 1 },
    ],
  });
  assert.match(out, /2 recommended/);
  assert.match(out, /1 aggressive/);
  assert.ok(!out.includes('optional'));
});
