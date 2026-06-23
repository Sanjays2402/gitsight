import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyBranchRole,
  shouldAutoOfferProtection,
  describeAutoOfferRationale,
  AutoOfferVerdict,
  BranchRole,
} from '../../src/git/branchProtectionSuggest';

// ── shouldAutoOfferProtection ─────────────────────────────────────────

test('shouldAutoOfferProtection: default branch -> offer', () => {
  assert.equal(shouldAutoOfferProtection('default'), 'offer');
});

test('shouldAutoOfferProtection: release branch -> offer', () => {
  assert.equal(shouldAutoOfferProtection('release'), 'offer');
});

test('shouldAutoOfferProtection: hotfix branch -> offer', () => {
  assert.equal(shouldAutoOfferProtection('hotfix'), 'offer');
});

test('shouldAutoOfferProtection: long-lived branch -> offer', () => {
  assert.equal(shouldAutoOfferProtection('long-lived'), 'offer');
});

test('shouldAutoOfferProtection: feature branch -> skip (personal branches)', () => {
  assert.equal(shouldAutoOfferProtection('feature'), 'skip');
});

test('shouldAutoOfferProtection: other branch -> skip (unsure)', () => {
  assert.equal(shouldAutoOfferProtection('other'), 'skip');
});

test('shouldAutoOfferProtection: exhaustive coverage of BranchRole union', () => {
  // Every BranchRole value must map to a verdict; this test will fail
  // to compile if a new role is added without updating the classifier.
  const roles: BranchRole[] = ['default', 'release', 'hotfix', 'long-lived', 'feature', 'other'];
  for (const role of roles) {
    const verdict: AutoOfferVerdict = shouldAutoOfferProtection(role);
    assert.ok(['offer', 'skip'].includes(verdict), `unhandled role: ${role}`);
  }
});

// ── classifyBranchRole + shouldAutoOfferProtection composition ────────

test('composition: release/2026.q2 -> release -> offer', () => {
  const role = classifyBranchRole({ branch: 'release/2026.q2' });
  assert.equal(role, 'release');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: hotfix/cve-12345 -> hotfix -> offer', () => {
  const role = classifyBranchRole({ branch: 'hotfix/cve-12345' });
  assert.equal(role, 'hotfix');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: develop -> long-lived -> offer', () => {
  const role = classifyBranchRole({ branch: 'develop' });
  assert.equal(role, 'long-lived');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: staging -> long-lived -> offer', () => {
  const role = classifyBranchRole({ branch: 'staging' });
  assert.equal(role, 'long-lived');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: feature/add-logout -> feature -> skip', () => {
  const role = classifyBranchRole({ branch: 'feature/add-logout' });
  assert.equal(role, 'feature');
  assert.equal(shouldAutoOfferProtection(role), 'skip');
});

test('composition: feat/add-logout -> feature -> skip', () => {
  const role = classifyBranchRole({ branch: 'feat/add-logout' });
  assert.equal(role, 'feature');
  assert.equal(shouldAutoOfferProtection(role), 'skip');
});

test('composition: random topic name -> other -> skip', () => {
  const role = classifyBranchRole({ branch: 'sanjay-experiment-do-not-merge' });
  assert.equal(role, 'other');
  assert.equal(shouldAutoOfferProtection(role), 'skip');
});

test('composition: main -> default -> offer', () => {
  const role = classifyBranchRole({ branch: 'main' });
  assert.equal(role, 'default');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: master -> default -> offer', () => {
  const role = classifyBranchRole({ branch: 'master' });
  assert.equal(role, 'default');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: custom default via defaultBranch arg -> default -> offer', () => {
  const role = classifyBranchRole({ branch: 'production', defaultBranch: 'production' });
  assert.equal(role, 'default');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: empty branch name -> other -> skip', () => {
  const role = classifyBranchRole({ branch: '' });
  assert.equal(role, 'other');
  assert.equal(shouldAutoOfferProtection(role), 'skip');
});

test('composition: v1.2.3 -> release -> offer', () => {
  const role = classifyBranchRole({ branch: 'v1.2.3' });
  assert.equal(role, 'release');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

test('composition: 1.x -> release -> offer', () => {
  const role = classifyBranchRole({ branch: '1.x' });
  assert.equal(role, 'release');
  assert.equal(shouldAutoOfferProtection(role), 'offer');
});

// ── describeAutoOfferRationale ────────────────────────────────────────

test('describeAutoOfferRationale: default mentions main/master/trunk', () => {
  assert.match(describeAutoOfferRationale('default'), /main|master|trunk/i);
});

test('describeAutoOfferRationale: release/hotfix mention branch kind', () => {
  assert.match(describeAutoOfferRationale('release'), /release/i);
  assert.match(describeAutoOfferRationale('hotfix'), /hotfix/i);
});

test('describeAutoOfferRationale: long-lived enumerates typical names', () => {
  const text = describeAutoOfferRationale('long-lived');
  assert.match(text, /develop|staging|qa/i);
});

test('describeAutoOfferRationale: feature copy still useful (even though we skip)', () => {
  const text = describeAutoOfferRationale('feature');
  assert.match(text, /feature/i);
});

test('describeAutoOfferRationale: every role yields a non-empty string', () => {
  const roles: BranchRole[] = ['default', 'release', 'hotfix', 'long-lived', 'feature', 'other'];
  for (const role of roles) {
    const text = describeAutoOfferRationale(role);
    assert.ok(text && text.length > 5, `empty rationale for ${role}`);
  }
});
