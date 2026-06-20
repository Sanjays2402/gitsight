import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseRemote, remoteWebUrl, pullRequestWebUrl } from '../../src/git/hostDetect';

test('parseRemote: github SSH and HTTPS', () => {
  const ssh = parseRemote('git@github.com:Sanjays2402/gitsight.git');
  assert.ok(ssh);
  assert.equal(ssh!.host, 'github');
  assert.equal(ssh!.owner, 'Sanjays2402');
  assert.equal(ssh!.repo, 'gitsight');
  assert.equal(ssh!.webBase, 'https://github.com/Sanjays2402/gitsight');

  const https = parseRemote('https://github.com/Sanjays2402/gitsight');
  assert.ok(https);
  assert.equal(https!.webBase, 'https://github.com/Sanjays2402/gitsight');
});

test('parseRemote: gitlab nested groups', () => {
  const info = parseRemote('git@gitlab.com:group/sub/project.git');
  assert.ok(info);
  assert.equal(info!.host, 'gitlab');
  assert.equal(info!.owner, 'group/sub');
  assert.equal(info!.repo, 'project');
});

test('parseRemote: bitbucket', () => {
  const info = parseRemote('https://bitbucket.org/team/repo.git');
  assert.ok(info);
  assert.equal(info!.host, 'bitbucket');
  assert.equal(info!.webBase, 'https://bitbucket.org/team/repo');
});

test('parseRemote: azure devops new dev.azure.com', () => {
  const ssh = parseRemote('git@ssh.dev.azure.com:v3/myorg/myproject/myrepo');
  assert.ok(ssh);
  assert.equal(ssh!.host, 'azure-devops');
  assert.equal(ssh!.owner, 'myorg');
  assert.equal(ssh!.project, 'myproject');
  assert.equal(ssh!.repo, 'myrepo');
  assert.equal(ssh!.webBase, 'https://dev.azure.com/myorg/myproject/_git/myrepo');

  const https = parseRemote('https://dev.azure.com/myorg/myproject/_git/myrepo');
  assert.ok(https);
  assert.equal(https!.host, 'azure-devops');
  assert.equal(https!.owner, 'myorg');
});

test('parseRemote: azure devops legacy visualstudio.com', () => {
  const info = parseRemote('https://myorg.visualstudio.com/myproject/_git/myrepo');
  assert.ok(info);
  assert.equal(info!.host, 'azure-devops');
  assert.equal(info!.owner, 'myorg');
  assert.equal(info!.project, 'myproject');
  assert.equal(info!.repo, 'myrepo');
});

test('parseRemote: unknown host falls back to "unknown"', () => {
  const info = parseRemote('git@git.example.com:owner/repo.git');
  assert.ok(info);
  assert.equal(info!.host, 'unknown');
});

test('parseRemote: empty / unparseable returns undefined', () => {
  assert.equal(parseRemote(''), undefined);
  assert.equal(parseRemote('not a url'), undefined);
});

test('remoteWebUrl: github commit URL', () => {
  const url = remoteWebUrl('git@github.com:owner/repo.git', 'abc1234');
  assert.equal(url, 'https://github.com/owner/repo/commit/abc1234');
});

test('remoteWebUrl: azure devops commit URL', () => {
  const url = remoteWebUrl('https://dev.azure.com/org/proj/_git/repo', 'deadbeef');
  assert.equal(url, 'https://dev.azure.com/org/proj/_git/repo/commit/deadbeef');
});

test('remoteWebUrl: bitbucket uses /commits/', () => {
  const url = remoteWebUrl('git@bitbucket.org:team/repo.git', 'abc1234');
  assert.equal(url, 'https://bitbucket.org/team/repo/commits/abc1234');
});

test('remoteWebUrl: returns repo base when no sha', () => {
  const url = remoteWebUrl('git@github.com:owner/repo.git');
  assert.equal(url, 'https://github.com/owner/repo');
});

test('pullRequestWebUrl: per-host formatting', () => {
  const gh = parseRemote('git@github.com:o/r.git')!;
  assert.equal(pullRequestWebUrl(gh, 42), 'https://github.com/o/r/pull/42');

  const gl = parseRemote('git@gitlab.com:o/r.git')!;
  assert.equal(pullRequestWebUrl(gl, 42), 'https://gitlab.com/o/r/-/merge_requests/42');

  const bb = parseRemote('git@bitbucket.org:o/r.git')!;
  assert.equal(pullRequestWebUrl(bb, 42), 'https://bitbucket.org/o/r/pull-requests/42');

  const ado = parseRemote('https://dev.azure.com/org/proj/_git/repo')!;
  assert.equal(pullRequestWebUrl(ado, 42), 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42');
});
