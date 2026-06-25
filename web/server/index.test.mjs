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
import { parseArgs, buildSnapshotForRepo, buildCommitDetailForRepo, buildFileDiffForRepo, scanReposUnder, resolveRequestRepo, isSafeRev } from './index.mjs';

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

test('parseArgs reads --root and resolves it to an absolute path', () => {
  const o = parseArgs(['--root', '/Projects']);
  assert.equal(o.root, '/Projects');
  const none = parseArgs([]);
  assert.equal(none.root, undefined);
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

// ── isSafeRev ────────────────────────────────────────────────────────

test('isSafeRev accepts shas and ref names, rejects flags + whitespace', () => {
  assert.equal(isSafeRev('a1b2c3d'), true);
  assert.equal(isSafeRev('HEAD'), true);
  assert.equal(isSafeRev('HEAD~3'), true);
  assert.equal(isSafeRev('feature/foo-bar'), true);
  assert.equal(isSafeRev('v1.2.0'), true);
  assert.equal(isSafeRev('-rf'), false);
  assert.equal(isSafeRev('--output=x'), false);
  assert.equal(isSafeRev('a b'), false);
  assert.equal(isSafeRev('a;rm'), false);
  assert.equal(isSafeRev(''), false);
  assert.equal(isSafeRev('x'.repeat(201)), false);
});

// ── buildCommitDetailForRepo (integration) ───────────────────────────

test('buildCommitDetailForRepo reports adds, mods, deletes, renames + churn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-detail-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@gitsight.local']);
    await git(['config', 'user.name', 'GitSight Test']);
    await pexec('bash', ['-c', 'printf "a\\nb\\nc\\n" > keep.txt; printf "old\\n" > rename-me.txt; printf "gone\\n" > del.txt'], { cwd: dir });
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'base: seed']);

    await pexec('bash', ['-c', 'printf "a\\nB\\nc\\nd\\n" > keep.txt; printf "new\\nline2\\n" > added.txt'], { cwd: dir });
    await git(['mv', 'rename-me.txt', 'renamed.txt']);
    await git(['rm', '-q', 'del.txt']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'feat: mixed change\n\nBody line one.\nBody line two.']);

    const detail = await buildCommitDetailForRepo(dir, 'HEAD');
    assert.equal(detail.subject, 'feat: mixed change');
    assert.equal(detail.body, 'Body line one.\nBody line two.');
    assert.equal(detail.filesChanged, 4);

    const byPath = Object.fromEntries(detail.files.map(f => [f.path, f]));
    assert.equal(byPath['added.txt'].status, 'added');
    assert.equal(byPath['del.txt'].status, 'deleted');
    assert.equal(byPath['keep.txt'].status, 'modified');
    assert.equal(byPath['renamed.txt'].status, 'renamed');
    assert.equal(byPath['renamed.txt'].oldPath, 'rename-me.txt');
    // keep.txt: one line changed (B) + one added (d) = +2 -1.
    assert.equal(byPath['keep.txt'].insertions, 2);
    assert.equal(byPath['keep.txt'].deletions, 1);
    assert.ok(detail.insertions > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildCommitDetailForRepo rejects an unsafe revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-detbad-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 't@x']);
    await git(['config', 'user.name', 'T']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    await assert.rejects(() => buildCommitDetailForRepo(dir, '--output=/tmp/x'), /invalid revision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildFileDiffForRepo (integration) ───────────────────────────────

test('buildFileDiffForRepo returns a parsed single-file diff with line numbers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-fdiff-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@gitsight.local']);
    await git(['config', 'user.name', 'GitSight Test']);
    await pexec('bash', ['-c', 'printf "a\\nb\\nc\\n" > keep.txt'], { cwd: dir });
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'base']);
    await pexec('bash', ['-c', 'printf "a\\nB\\nc\\nd\\n" > keep.txt'], { cwd: dir });
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'edit keep']);

    const { file } = await buildFileDiffForRepo(dir, 'HEAD', 'keep.txt');
    assert.ok(file);
    assert.equal(file.path, 'keep.txt');
    assert.equal(file.status, 'modified');
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 1);
    assert.equal(file.hunks.length, 1);
    const kinds = file.hunks[0].lines.map(l => l.kind);
    assert.ok(kinds.includes('add'));
    assert.ok(kinds.includes('del'));
    assert.ok(kinds.includes('context'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildFileDiffForRepo flags a binary file and rejects bad input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-fbin-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@gitsight.local']);
    await git(['config', 'user.name', 'GitSight Test']);
    await pexec('bash', ['-c', 'printf "\\x00\\x01\\x02bin\\x00" > blob.bin'], { cwd: dir });
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'add binary']);

    const { file } = await buildFileDiffForRepo(dir, 'HEAD', 'blob.bin');
    assert.ok(file);
    assert.equal(file.binary, true);

    await assert.rejects(() => buildFileDiffForRepo(dir, 'HEAD', ''), /invalid path/);
    await assert.rejects(() => buildFileDiffForRepo(dir, '--bad', 'blob.bin'), /invalid revision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── scanReposUnder (integration) ─────────────────────────────────────

test('scanReposUnder finds git repos one level under the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitsight-root-'));
  try {
    const git = (cwd, args) => pexec('git', args, { cwd });
    // Two repos + one plain dir under the root.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'repo-a'));
    await mkdir(join(root, 'repo-b'));
    await mkdir(join(root, 'not-a-repo'));
    await git(join(root, 'repo-a'), ['init', '-q', '-b', 'main']);
    await git(join(root, 'repo-b'), ['init', '-q', '-b', 'main']);

    const found = await scanReposUnder(root);
    const names = found.map(p => p.split('/').pop()).sort();
    assert.ok(names.includes('repo-a'));
    assert.ok(names.includes('repo-b'));
    assert.ok(!names.includes('not-a-repo'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanReposUnder returns [] for a missing root or no root', async () => {
  assert.deepEqual(await scanReposUnder(undefined), []);
  assert.deepEqual(await scanReposUnder('/no/such/path/here-xyz'), []);
});

// ── resolveRequestRepo (security gate) ───────────────────────────────

test('resolveRequestRepo permits the default repo and repos under root', () => {
  const opts = { repo: '/srv/main', root: '/Projects' };
  const sp = (q) => new URLSearchParams(q);
  assert.equal(resolveRequestRepo(sp(''), opts), '/srv/main');
  assert.equal(resolveRequestRepo(sp('repo=/srv/main'), opts), '/srv/main');
  assert.equal(resolveRequestRepo(sp('repo=/Projects/x'), opts), '/Projects/x');
});

test('resolveRequestRepo throws on a disallowed override', () => {
  const opts = { repo: '/srv/main', root: '/Projects' };
  const sp = (q) => new URLSearchParams(q);
  assert.throws(() => resolveRequestRepo(sp('repo=/etc/passwd'), opts), /not allowed/);
  // No root → only the default is reachable.
  assert.throws(() => resolveRequestRepo(sp('repo=/anywhere'), { repo: '/srv/main' }), /not allowed/);
});
