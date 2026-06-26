import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseRemote,
  remoteWebUrl,
  pullRequestWebUrl,
  hostLabel,
  commitWebUrl,
} from '../../src/shared/remoteUrl';

// ── parseRemote (regression — extracted from hostDetect, W28) ─────────

test('parseRemote handles github SSH + HTTPS', () => {
  const ssh = parseRemote('git@github.com:Sanjays2402/gitsight.git');
  assert.equal(ssh?.host, 'github');
  assert.equal(ssh?.owner, 'Sanjays2402');
  assert.equal(ssh?.repo, 'gitsight');
  assert.equal(ssh?.webBase, 'https://github.com/Sanjays2402/gitsight');
  const https = parseRemote('https://github.com/Sanjays2402/gitsight');
  assert.equal(https?.host, 'github');
});

test('parseRemote handles gitlab nested groups + bitbucket + ado', () => {
  assert.equal(parseRemote('git@gitlab.com:group/sub/project.git')?.owner, 'group/sub');
  assert.equal(parseRemote('https://bitbucket.org/team/repo.git')?.host, 'bitbucket');
  const ado = parseRemote('https://dev.azure.com/myorg/myproject/_git/myrepo');
  assert.equal(ado?.host, 'azure-devops');
  assert.equal(ado?.project, 'myproject');
});

test('parseRemote returns undefined for empty/unparseable', () => {
  assert.equal(parseRemote(''), undefined);
  assert.equal(parseRemote('not a url'), undefined);
});

// ── remoteWebUrl ─────────────────────────────────────────────────────

test('remoteWebUrl builds per-host commit URLs', () => {
  assert.equal(remoteWebUrl('git@github.com:o/r.git', 'abc1234'), 'https://github.com/o/r/commit/abc1234');
  assert.equal(remoteWebUrl('git@bitbucket.org:t/r.git', 'abc1234'), 'https://bitbucket.org/t/r/commits/abc1234');
  assert.equal(remoteWebUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
});

test('pullRequestWebUrl formats per host', () => {
  const gl = parseRemote('git@gitlab.com:o/r.git')!;
  assert.equal(pullRequestWebUrl(gl, 7), 'https://gitlab.com/o/r/-/merge_requests/7');
});

// ── hostLabel (W28) ──────────────────────────────────────────────────

test('hostLabel maps each host to a human name, unknown -> remote', () => {
  assert.equal(hostLabel('github'), 'GitHub');
  assert.equal(hostLabel('azure-devops'), 'Azure DevOps');
  assert.equal(hostLabel('gitlab'), 'GitLab');
  assert.equal(hostLabel('bitbucket'), 'Bitbucket');
  assert.equal(hostLabel('unknown'), 'remote');
});

// ── commitWebUrl (W28 — the web convenience) ─────────────────────────

test('commitWebUrl returns url + host + label for a known remote', () => {
  const t = commitWebUrl('git@github.com:Sanjays2402/gitsight.git', 'deadbeef');
  assert.ok(t);
  assert.equal(t.url, 'https://github.com/Sanjays2402/gitsight/commit/deadbeef');
  assert.equal(t.host, 'github');
  assert.equal(t.label, 'GitHub');
});

test('commitWebUrl still resolves an unknown self-hosted remote', () => {
  const t = commitWebUrl('git@git.example.com:owner/repo.git', 'abc1234');
  assert.ok(t);
  assert.equal(t.url, 'https://git.example.com/owner/repo/commit/abc1234');
  assert.equal(t.host, 'unknown');
  assert.equal(t.label, 'remote');
});

test('commitWebUrl returns null when there is no remote or sha', () => {
  assert.equal(commitWebUrl(undefined, 'abc1234'), null);
  assert.equal(commitWebUrl('', 'abc1234'), null);
  assert.equal(commitWebUrl('git@github.com:o/r.git', ''), null);
  assert.equal(commitWebUrl('not a url', 'abc1234'), null);
});
