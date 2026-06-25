/**
 * Companion server tests (W4).
 *
 * Runs directly under `node --test` (no compile step) since the server is
 * .mjs importing the shared .ts builder via Node's native type stripping.
 * Covers the pure arg parser plus a real integration test: spin up a
 * throwaway git repo, build a snapshot from it, assert the shape.
 *
 *   node --test server/*.test.mjs
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, buildSnapshotForRepo } from './index.mjs';

const pexec = promisify(execFile);

// ── parseArgs ────────────────────────────────────────────────────────

test('parseArgs defaults to cwd, port 5274, max 500', () => {
  const o = parseArgs([]);
  assert.equal(o.port, 5274);
  assert.equal(o.max, 500);
  assert.equal(typeof o.repo, 'string');
});

test('parseArgs reads --repo/--port/--max and the -C alias', () => {
  const o = parseArgs(['--repo', '/x/y', '--port', '9001', '--max', '25']);
  assert.equal(o.repo, '/x/y');
  assert.equal(o.port, 9001);
  assert.equal(o.max, 25);

  const aliased = parseArgs(['-C', '/z']);
  assert.equal(aliased.repo, '/z');
});

test('parseArgs ignores a non-numeric port/max and keeps the default', () => {
  const o = parseArgs(['--port', 'abc', '--max', 'xyz']);
  assert.equal(o.port, 5274);
  assert.equal(o.max, 500);
});

// ── buildSnapshotForRepo (integration) ───────────────────────────────

test('buildSnapshotForRepo produces a renderable snapshot from a real repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-srv-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@gitsight.local']);
    await git(['config', 'user.name', 'GitSight Test']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init: root commit']);
    await git(['commit', '--allow-empty', '-q', '-m', 'feat: a feature, with punctuation (#1)']);
    await git(['tag', 'v0.1.0']);
    await git(['commit', '--allow-empty', '-q', '-m', 'fix: a fix']);

    const snap = await buildSnapshotForRepo(dir, 10);
    assert.equal(snap.head, 'main');
    assert.ok(snap.repo.startsWith('gitsight-srv-'), `repo basename was ${snap.repo}`);
    assert.equal(snap.commitCount, 3);
    // Newest first.
    assert.equal(snap.commits[0].subject, 'fix: a fix');
    assert.equal(snap.commits[2].subject, 'init: root commit');
    // Punctuation in the subject survived the NUL-field parse.
    assert.equal(snap.commits[1].subject, 'feat: a feature, with punctuation (#1)');
    // The tag ref decorates the middle commit.
    assert.ok(snap.commits[1].refs.some(r => r.includes('v0.1.0')));
    // Every commit carries a parents array (root has none).
    assert.ok(snap.commits.every(c => Array.isArray(c.parents)));
    assert.deepEqual(snap.commits[2].parents, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildSnapshotForRepo rejects a non-git directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-nogit-'));
  try {
    await assert.rejects(() => buildSnapshotForRepo(dir, 5));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
