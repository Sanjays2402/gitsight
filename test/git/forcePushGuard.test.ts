import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classifyProtection,
  describeDecision,
  parseGitHubRepo,
} from '../../src/git/forcePushGuard';

test('classifyProtection treats `Branch not protected` stderr as unprotected', () => {
  const d = classifyProtection('', 'gh: Branch not protected (HTTP 404)\n', 1);
  assert.equal(d.kind, 'unprotected');
});

test('classifyProtection treats a 404 with `protection` context as unprotected', () => {
  const d = classifyProtection('', 'HTTP 404: Not Found (branches/main/protection)\n', 1);
  assert.equal(d.kind, 'unprotected');
});

test('classifyProtection returns unknown for arbitrary gh failures', () => {
  const d = classifyProtection('', 'gh: missing required scope\nrun `gh auth refresh`', 1);
  assert.equal(d.kind, 'unknown');
  if (d.kind === 'unknown') assert.match(d.reason, /missing required scope|gh auth refresh/);
});

test('classifyProtection surfaces "not authenticated" specifically', () => {
  const d = classifyProtection('', 'gh: not authenticated. Run `gh auth login`.', 1);
  assert.equal(d.kind, 'unknown');
  if (d.kind === 'unknown') assert.match(d.reason, /not authenticated/);
});

test('classifyProtection returns protected + force-disallowed for the default GitHub blob', () => {
  const body = JSON.stringify({
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_pull_request_reviews: { dismissal_restrictions: {} },
    required_status_checks: { contexts: ['ci/lint'] },
  });
  const d = classifyProtection(body, '', 0);
  assert.equal(d.kind, 'protected');
  if (d.kind === 'protected') {
    assert.equal(d.allowsForcePush, false);
    const ids = d.rules.map(r => r.id);
    assert.ok(ids.includes('enforce-admins'), 'enforce-admins should be flagged');
    assert.ok(ids.includes('force-push'), 'force-push should always be in the rules list');
    assert.ok(ids.includes('required-reviews'), 'required-reviews should be flagged');
    assert.ok(ids.includes('required-status-checks'), 'required-status-checks should be flagged');
    const fp = d.rules.find(r => r.id === 'force-push');
    assert.equal(fp!.label, 'Force-push disallowed');
  }
});

test('classifyProtection returns protected + force-allowed when allow_force_pushes is true', () => {
  const body = JSON.stringify({
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: false },
  });
  const d = classifyProtection(body, '', 0);
  assert.equal(d.kind, 'protected');
  if (d.kind === 'protected') {
    assert.equal(d.allowsForcePush, true);
    const fp = d.rules.find(r => r.id === 'force-push');
    assert.equal(fp!.label, 'Force-push allowed');
  }
});

test('classifyProtection returns unknown for non-JSON success bodies', () => {
  const d = classifyProtection('garbage{not-json', '', 0);
  assert.equal(d.kind, 'unknown');
});

test('classifyProtection treats empty body + exit 0 as unprotected', () => {
  const d = classifyProtection('', '', 0);
  assert.equal(d.kind, 'unprotected');
});

test('classifyProtection includes lock-branch + required-signatures + linear-history when set', () => {
  const body = JSON.stringify({
    allow_force_pushes: { enabled: false },
    lock_branch: { enabled: true },
    required_signatures: { enabled: true },
    required_linear_history: { enabled: true },
  });
  const d = classifyProtection(body, '', 0);
  assert.equal(d.kind, 'protected');
  if (d.kind === 'protected') {
    const ids = d.rules.map(r => r.id);
    assert.ok(ids.includes('lock-branch'));
    assert.ok(ids.includes('required-signatures'));
    assert.ok(ids.includes('required-linear-history'));
  }
});

test('describeDecision is stable for each decision kind', () => {
  assert.equal(
    describeDecision({ kind: 'unprotected' }, 'main'),
    'Branch `main` is not protected.',
  );
  assert.equal(
    describeDecision({ kind: 'protected', allowsForcePush: true, rules: [] }, 'main'),
    'Branch `main` is protected but allows force-push.',
  );
  assert.equal(
    describeDecision({ kind: 'protected', allowsForcePush: false, rules: [] }, 'main'),
    'Branch `main` is protected and does NOT allow force-push.',
  );
  assert.equal(
    describeDecision({ kind: 'unknown', reason: 'gh not installed' }, 'main'),
    'Could not check protection for `main`: gh not installed.',
  );
});

test('parseGitHubRepo handles SSH, HTTPS, and ssh:// URLs', () => {
  assert.deepEqual(parseGitHubRepo('git@github.com:Sanjays2402/gitsight.git'), { owner: 'Sanjays2402', repo: 'gitsight' });
  assert.deepEqual(parseGitHubRepo('git@github.com:foo/bar'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubRepo('https://github.com/foo/bar.git'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubRepo('https://github.com/foo/bar'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubRepo('https://github.com/foo/bar/'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubRepo('https://user@github.com/foo/bar.git'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubRepo('ssh://git@github.com/foo/bar.git'), { owner: 'foo', repo: 'bar' });
  assert.deepEqual(parseGitHubRepo('ssh://git@github.com:22/foo/bar.git'), { owner: 'foo', repo: 'bar' });
});

test('parseGitHubRepo returns undefined for non-GitHub remotes', () => {
  assert.equal(parseGitHubRepo(''), undefined);
  assert.equal(parseGitHubRepo('git@gitlab.com:foo/bar.git'), undefined);
  assert.equal(parseGitHubRepo('https://bitbucket.org/foo/bar.git'), undefined);
  assert.equal(parseGitHubRepo('ssh://git@dev.azure.com:22/org/proj/_git/repo'), undefined);
});

test('describe + rules helper renders rule labels stably', () => {
  const d = classifyProtection(JSON.stringify({
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
  }), '', 0);
  assert.equal(d.kind, 'protected');
  if (d.kind === 'protected') {
    const labels = d.rules.map(r => r.label);
    assert.ok(labels.includes('Admin enforcement enabled'));
    assert.ok(labels.includes('Force-push disallowed'));
  }
});
