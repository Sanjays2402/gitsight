import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseGitHubRemote,
  buildCodespacesUrl,
  buildManageCodespacesUrl,
  describeCodespaceTarget,
} from '../../src/git/codespaces';

test('parseGitHubRemote: SSH SCP-style with .git suffix', () => {
  const r = parseGitHubRemote('git@github.com:Sanjays2402/gitsight.git');
  assert.deepEqual(r, { owner: 'Sanjays2402', name: 'gitsight' });
});

test('parseGitHubRemote: SSH SCP-style without .git', () => {
  const r = parseGitHubRemote('git@github.com:Sanjays2402/gitsight');
  assert.deepEqual(r, { owner: 'Sanjays2402', name: 'gitsight' });
});

test('parseGitHubRemote: HTTPS without .git', () => {
  const r = parseGitHubRemote('https://github.com/Sanjays2402/gitsight');
  assert.deepEqual(r, { owner: 'Sanjays2402', name: 'gitsight' });
});

test('parseGitHubRemote: HTTPS with .git suffix and trailing slash', () => {
  const r = parseGitHubRemote('https://github.com/Sanjays2402/gitsight.git/');
  assert.deepEqual(r, { owner: 'Sanjays2402', name: 'gitsight' });
});

test('parseGitHubRemote: HTTPS with token in URL is stripped', () => {
  const r = parseGitHubRemote('https://x-access-token:abc123@github.com/Sanjays2402/gitsight.git');
  assert.deepEqual(r, { owner: 'Sanjays2402', name: 'gitsight' });
});

test('parseGitHubRemote: ssh:// proto with port', () => {
  const r = parseGitHubRemote('ssh://git@github.com:22/Sanjays2402/gitsight.git');
  assert.deepEqual(r, { owner: 'Sanjays2402', name: 'gitsight' });
});

test('parseGitHubRemote: rejects non-GitHub hosts (Codespaces is github.com only)', () => {
  assert.equal(parseGitHubRemote('git@gitlab.com:owner/repo.git'), undefined);
  assert.equal(parseGitHubRemote('https://bitbucket.org/owner/repo'), undefined);
});

test('parseGitHubRemote: accepts www.github.com (used by some clients)', () => {
  assert.deepEqual(parseGitHubRemote('https://www.github.com/x/y.git'), { owner: 'x', name: 'y' });
});

test('parseGitHubRemote: empty / garbage returns undefined', () => {
  assert.equal(parseGitHubRemote(''), undefined);
  assert.equal(parseGitHubRemote('not a url'), undefined);
});

test('parseGitHubRemote: deep path is fine, last segment wins for name', () => {
  // Nested groups aren't a thing on github.com but URL form is permissive
  // — treat the last segment as the repo name.
  const r = parseGitHubRemote('https://github.com/org/sub/repo.git');
  assert.deepEqual(r, { owner: 'org', name: 'repo' });
});

test('buildCodespacesUrl: path form when only owner/name/ref', () => {
  const url = buildCodespacesUrl({ owner: 'Sanjays2402', name: 'gitsight', ref: 'main' });
  assert.equal(url, 'https://github.com/codespaces/new/Sanjays2402/gitsight?ref=main');
});

test('buildCodespacesUrl: path form, no ref => default branch', () => {
  const url = buildCodespacesUrl({ owner: 'Sanjays2402', name: 'gitsight' });
  assert.equal(url, 'https://github.com/codespaces/new/Sanjays2402/gitsight');
});

test('buildCodespacesUrl: feature/X ref keeps the slash raw (readable URL)', () => {
  const url = buildCodespacesUrl({ owner: 'a', name: 'b', ref: 'feature/x' });
  assert.equal(url, 'https://github.com/codespaces/new/a/b?ref=feature/x');
});

test('buildCodespacesUrl: switches to advanced query when devcontainer pinned', () => {
  const url = buildCodespacesUrl({
    owner: 'Sanjays2402',
    name: 'gitsight',
    ref: 'main',
    devcontainerPath: '.devcontainer/web/devcontainer.json',
  });
  assert.ok(url.startsWith('https://github.com/codespaces/new?'));
  assert.match(url, /repo=Sanjays2402%2Fgitsight/);
  assert.match(url, /ref=main/);
  assert.match(url, /devcontainer_path=\.devcontainer%2Fweb%2Fdevcontainer\.json/);
});

test('buildCodespacesUrl: machine + location pinned', () => {
  const url = buildCodespacesUrl({
    owner: 'a',
    name: 'b',
    ref: 'main',
    machine: 'premiumLinux',
    location: 'UsWest',
  });
  assert.match(url, /machine=premiumLinux/);
  assert.match(url, /location=UsWest/);
});

test('buildCodespacesUrl: special chars in owner/name are encoded in path form', () => {
  const url = buildCodespacesUrl({ owner: 'org name', name: 'repo+1', ref: 'main' });
  assert.match(url, /org%20name\/repo%2B1/);
});

test('buildManageCodespacesUrl: produces the search URL', () => {
  const url = buildManageCodespacesUrl({ owner: 'Sanjays2402', name: 'gitsight' });
  assert.match(url, /codespaces\?/);
  assert.match(url, /repo%3ASanjays2402%2Fgitsight/);
});

test('describeCodespaceTarget: lists ref + each pinned override', () => {
  const d = describeCodespaceTarget({
    owner: 'a', name: 'b', ref: 'feature/x',
    devcontainerPath: '.devcontainer/devcontainer.json',
    machine: 'basicLinux32gb',
  });
  assert.match(d, /ref feature\/x/);
  assert.match(d, /devcontainer/);
  assert.match(d, /machine basicLinux32gb/);
});

test('describeCodespaceTarget: no ref => "default branch"', () => {
  const d = describeCodespaceTarget({ owner: 'a', name: 'b' });
  assert.match(d, /default branch/);
});
