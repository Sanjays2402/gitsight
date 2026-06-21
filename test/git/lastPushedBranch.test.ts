import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePushReflog,
  detectHost,
  branchTreeUrl,
  compareUrl,
  newPullRequestUrl,
} from '../../src/git/lastPushedBranch';

test('parsePushReflog: picks the most recent "update by push" on refs/heads/*', () => {
  const raw = [
    'HEAD@{2026-06-20T13:00:00-07:00} checkout: moving from main to feature/x',
    'refs/heads/feature/x@{2026-06-20T12:30:00-07:00} update by push',
    'refs/heads/main@{2026-06-19T18:00:00-07:00} update by push',
  ].join('\n');
  const out = parsePushReflog(raw);
  assert.ok(out);
  assert.equal(out!.branch, 'feature/x');
  assert.equal(out!.dateIso, '2026-06-20T12:30:00-07:00');
});

test('parsePushReflog: skips HEAD entries even if subject is "update by push"', () => {
  const raw = [
    'HEAD@{2026-06-20T13:00:00-07:00} update by push',
    'refs/heads/main@{2026-06-19T18:00:00-07:00} update by push',
  ].join('\n');
  const out = parsePushReflog(raw);
  assert.ok(out);
  assert.equal(out!.branch, 'main');
});

test('parsePushReflog: empty / no matches', () => {
  assert.equal(parsePushReflog(''), undefined);
  assert.equal(parsePushReflog('HEAD@{2026-06-20T13:00:00-07:00} checkout: moving'), undefined);
});

test('parsePushReflog: malformed lines silently ignored', () => {
  const raw = [
    'not-a-reflog-line',
    'refs/heads/main@{bad-date} update by push',           // still parses — we don't validate date format
    'refs/heads/feature/x@{2026-06-20T11:00:00-07:00} update by push',
  ].join('\n');
  const out = parsePushReflog(raw);
  assert.ok(out);
  // First valid-format line wins, regardless of timestamp shape; reflog is already newest-first.
  assert.equal(out!.branch, 'main');
});

test('detectHost: github / gitlab / bitbucket / azure-devops / unknown', () => {
  assert.equal(detectHost('https://github.com/foo/bar'), 'github');
  assert.equal(detectHost('https://gitlab.com/foo/bar'), 'gitlab');
  assert.equal(detectHost('https://gitlab.example.io/foo/bar'), 'gitlab');
  assert.equal(detectHost('https://bitbucket.org/foo/bar'), 'bitbucket');
  assert.equal(detectHost('https://dev.azure.com/org/proj/_git/repo'), 'azure-devops');
  assert.equal(detectHost('https://example.com/foo/bar'), 'unknown');
  assert.equal(detectHost(''), 'unknown');
});

test('branchTreeUrl: GitHub /tree/<branch>', () => {
  assert.equal(
    branchTreeUrl('https://github.com/foo/bar', 'feature/x'),
    'https://github.com/foo/bar/tree/feature/x',
  );
});

test('branchTreeUrl: encodes branch but preserves slashes', () => {
  const out = branchTreeUrl('https://github.com/foo/bar', 'release/v1+x');
  assert.equal(out, 'https://github.com/foo/bar/tree/release/v1+x');
});

test('branchTreeUrl: GitLab uses /-/tree/, Bitbucket /branch/, ADO ?version=GB', () => {
  assert.equal(branchTreeUrl('https://gitlab.com/g/r', 'main'), 'https://gitlab.com/g/r/-/tree/main');
  assert.equal(branchTreeUrl('https://bitbucket.org/g/r', 'main'), 'https://bitbucket.org/g/r/branch/main');
  assert.equal(branchTreeUrl('https://dev.azure.com/o/p/_git/r', 'main'), 'https://dev.azure.com/o/p/_git/r?version=GBmain');
});

test('branchTreeUrl: unknown host → undefined', () => {
  assert.equal(branchTreeUrl('https://example.com/foo/bar', 'main'), undefined);
});

test('compareUrl: per-host shape', () => {
  assert.equal(
    compareUrl('https://github.com/foo/bar', 'main', 'feature/x'),
    'https://github.com/foo/bar/compare/main...feature%2Fx',
  );
  assert.equal(
    compareUrl('https://gitlab.com/foo/bar', 'main', 'feature/x'),
    'https://gitlab.com/foo/bar/-/compare/main...feature%2Fx',
  );
  assert.equal(
    compareUrl('https://bitbucket.org/foo/bar', 'main', 'feature/x'),
    'https://bitbucket.org/foo/bar/branches/compare/feature%2Fx..main',
  );
});

test('newPullRequestUrl: per-host shape', () => {
  assert.equal(
    newPullRequestUrl('https://github.com/foo/bar', 'feature/x'),
    'https://github.com/foo/bar/pull/new/feature%2Fx',
  );
  assert.equal(
    newPullRequestUrl('https://gitlab.com/foo/bar', 'feature/x'),
    'https://gitlab.com/foo/bar/-/merge_requests/new?merge_request[source_branch]=feature%2Fx',
  );
  assert.equal(
    newPullRequestUrl('https://bitbucket.org/foo/bar', 'feature/x'),
    'https://bitbucket.org/foo/bar/pull-requests/new?source=feature%2Fx',
  );
});
