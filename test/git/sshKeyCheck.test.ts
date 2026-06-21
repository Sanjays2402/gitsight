import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyAuthFailure,
  summariseFailure,
  suggestActions,
  actionPayload,
} from '../../src/git/sshKeyCheck';

test('classifyAuthFailure: permission denied (publickey) is SSH', () => {
  const f = classifyAuthFailure(
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    'git@github.com:Sanjays2402/gitsight.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'permission-denied');
  assert.equal(f!.transport, 'ssh');
  assert.equal(f!.host, 'github.com');
  assert.match(f!.evidence, /Permission denied/);
});

test('classifyAuthFailure: host key verification is its own bucket', () => {
  const f = classifyAuthFailure(
    'Host key verification failed.\nfatal: Could not read from remote repository.',
    'ssh://git@github.com:22/Sanjays2402/gitsight.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'host-key-verification');
  assert.equal(f!.transport, 'ssh');
});

test('classifyAuthFailure: repo-not-found-via-ssh (SSH auth ok but no access)', () => {
  const f = classifyAuthFailure(
    'ERROR: Repository not found.\nfatal: Could not read from remote repository.\n',
    'git@github.com:org/private-repo.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'repo-not-found-via-ssh');
  assert.equal(f!.host, 'github.com');
});

test('classifyAuthFailure: connection closed (sleep/wifi flap)', () => {
  const f = classifyAuthFailure(
    'kex_exchange_identification: Connection closed by remote host\nfatal: Could not read from remote repository.\n',
    'git@github.com:x/y.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'connection-closed');
});

test('classifyAuthFailure: HTTPS credential prompt is its own case', () => {
  const f = classifyAuthFailure(
    'fatal: could not read Username for \'https://github.com\': terminal prompts disabled\n',
    'https://github.com/x/y.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'https-credential-prompt');
  assert.equal(f!.transport, 'https');
});

test('classifyAuthFailure: HTTPS authentication failed', () => {
  const f = classifyAuthFailure(
    'remote: Invalid username or password.\nfatal: Authentication failed for \'https://github.com/x/y.git/\'\n',
    'https://github.com/x/y.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'permission-denied');
  assert.equal(f!.transport, 'https');
});

test('classifyAuthFailure: HTTP 403 from remote helper is HTTPS auth-denied', () => {
  const f = classifyAuthFailure(
    'remote: The requested URL returned error: 403\nfatal: unable to access \'https://...\'\n',
    'https://github.com/x/y.git',
  );
  assert.ok(f);
  assert.equal(f!.kind, 'permission-denied');
  assert.equal(f!.transport, 'https');
});

test('classifyAuthFailure: empty / network-only errors return undefined', () => {
  assert.equal(classifyAuthFailure('', 'git@github.com:x/y.git'), undefined);
  assert.equal(
    classifyAuthFailure('error: failed to push some refs to \'origin\'\n', 'git@github.com:x/y.git'),
    undefined,
  );
});

test('classifyAuthFailure: works without a URL (transport stays "ssh" via the pattern hint)', () => {
  const f = classifyAuthFailure('Permission denied (publickey).');
  assert.ok(f);
  assert.equal(f!.transport, 'ssh');
  assert.equal(f!.host, undefined);
});

test('summariseFailure: every kind has a non-empty summary', () => {
  for (const kind of [
    'permission-denied',
    'host-key-verification',
    'repo-not-found-via-ssh',
    'connection-closed',
    'https-credential-prompt',
    'unknown',
  ] as const) {
    const s = summariseFailure({ kind, evidence: '', transport: 'ssh' });
    assert.ok(s.length > 10, `summary for ${kind} too short`);
  }
});

test('summariseFailure: HTTPS permission-denied vs SSH differ', () => {
  const ssh = summariseFailure({ kind: 'permission-denied', evidence: '', transport: 'ssh' });
  const https = summariseFailure({ kind: 'permission-denied', evidence: '', transport: 'https' });
  assert.notEqual(ssh, https);
  assert.match(ssh, /SSH key/);
  assert.match(https, /token/);
});

test('suggestActions: SSH permission-denied includes keygen + ssh-config buttons', () => {
  const a = suggestActions({ kind: 'permission-denied', evidence: '', transport: 'ssh', host: 'github.com' });
  const ids = a.map(x => x.id);
  assert.ok(ids.includes('open-ssh-config'));
  assert.ok(ids.includes('copy-keygen'));
  assert.ok(ids.includes('copy-add-key'));
  assert.ok(ids.includes('open-gh-keys'));
});

test('suggestActions: HTTPS permission-denied recommends gh CLI', () => {
  const a = suggestActions({ kind: 'permission-denied', evidence: '', transport: 'https', host: 'github.com' });
  const ids = a.map(x => x.id);
  assert.ok(ids.includes('use-gh-cli'));
  assert.ok(ids.includes('open-pat-page'));
});

test('suggestActions: host-key-verification suggests ssh-keyscan with host', () => {
  const a = suggestActions({ kind: 'host-key-verification', evidence: '', transport: 'ssh', host: 'gitlab.acme.com' });
  const ks = a.find(x => x.id === 'copy-ssh-keyscan');
  assert.ok(ks);
  assert.match(ks!.label, /gitlab\.acme\.com/);
});

test('actionPayload: copy-keygen returns a copy payload', () => {
  const p = actionPayload('copy-keygen');
  assert.ok(p);
  assert.equal(p!.kind, 'copy');
  assert.match(p!.value, /ssh-keygen -t ed25519/);
});

test('actionPayload: open-gh-keys returns the GitHub settings URL', () => {
  const p = actionPayload('open-gh-keys', 'github.com');
  assert.ok(p);
  assert.equal(p!.kind, 'open');
  assert.equal(p!.value, 'https://github.com/settings/keys');
});

test('actionPayload: copy-ssh-keyscan honours host', () => {
  const p = actionPayload('copy-ssh-keyscan', 'gitlab.acme.com');
  assert.ok(p);
  assert.match(p!.value, /gitlab\.acme\.com/);
});

test('actionPayload: open-ssh-config returns undefined (view handles it)', () => {
  assert.equal(actionPayload('open-ssh-config'), undefined);
  assert.equal(actionPayload('open-known-hosts'), undefined);
});
