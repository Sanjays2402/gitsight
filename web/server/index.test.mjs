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
import { parseArgs, buildSnapshotForRepo, buildCommitDetailForRepo, buildFileDiffForRepo, scanReposUnder, resolveRequestRepo, isSafeRev, buildBlameForRepo, buildActivityForRepo, buildContributorsForRepo, resolveGitDir, createWatcherRegistry, createCompanionServer } from './index.mjs';

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

// ── buildBlameForRepo (W12, integration) ─────────────────────────────

test('buildBlameForRepo parses a real file blame into the heatmap model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-blame-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'ada@gitsight.local']);
    await git(['config', 'user.name', 'Ada']);
    await writeFile(join(dir, 'app.txt'), 'one\ntwo\n');
    await git(['add', 'app.txt']);
    await git(['commit', '-q', '-m', 'init']);
    await writeFile(join(dir, 'app.txt'), 'one\ntwo\nthree\n');
    await git(['add', 'app.txt']);
    await git(['commit', '-q', '-m', 'add third']);

    const blame = await buildBlameForRepo(dir, 'HEAD', 'app.txt');
    assert.equal(blame.path, 'app.txt');
    assert.equal(blame.totalLines, 3);
    assert.equal(blame.lines[0].code, 'one');
    assert.equal(blame.lines[2].code, 'three');
    assert.equal(blame.authors[0].author, 'Ada');
    assert.ok(blame.newest >= blame.oldest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildBlameForRepo rejects a flag-like path and a bad rev', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-blame2-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    await assert.rejects(() => buildBlameForRepo(dir, '--upload-pack=evil', 'x'), /invalid revision/);
    await assert.rejects(() => buildBlameForRepo(dir, 'HEAD', ''), /invalid path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildActivityForRepo (W13, integration) ──────────────────────────

test('buildActivityForRepo builds a calendar from real commits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-activity-'));
  try {
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    const day = (d) => ({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
    await git(['commit', '--allow-empty', '-q', '-m', 'c1'], day('2026-06-01T09:00:00'));
    await git(['commit', '--allow-empty', '-q', '-m', 'c2'], day('2026-06-01T18:00:00'));
    await git(['commit', '--allow-empty', '-q', '-m', 'c3'], day('2026-06-03T12:00:00'));

    const cal = await buildActivityForRepo(dir, 100);
    assert.equal(cal.total, 3);
    assert.equal(cal.activeDays, 2);
    assert.equal(cal.max, 2);
    assert.equal(cal.first, '2026-06-01');
    assert.equal(cal.last, '2026-06-03');
    // Every week column is a full 7 days.
    for (const week of cal.weeks) assert.equal(week.length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildContributorsForRepo (W14, integration) ──────────────────────

test('buildContributorsForRepo ranks authors by commit count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-contrib-'));
  try {
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    await git(['init', '-q', '-b', 'main']);
    const as = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
    await git(['config', 'user.email', 'fallback@b.c']);
    await git(['config', 'user.name', 'Fallback']);
    await git(['commit', '--allow-empty', '-q', '-m', 'c1'], as('Ada', 'ada@x.com'));
    await git(['commit', '--allow-empty', '-q', '-m', 'c2'], as('Ada', 'ada@x.com'));
    await git(['commit', '--allow-empty', '-q', '-m', 'c3'], as('Grace', 'grace@x.com'));

    const stats = await buildContributorsForRepo(dir, 100);
    assert.equal(stats.totalCommits, 3);
    assert.equal(stats.totalAuthors, 2);
    assert.equal(stats.contributors[0].name, 'Ada');
    assert.equal(stats.contributors[0].commits, 2);
    assert.equal(stats.contributors[1].name, 'Grace');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── resolveGitDir + live SSE stream (W17, integration) ───────────────

test('resolveGitDir returns the absolute .git path for a repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-gitdir-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    const gitDir = await resolveGitDir(dir);
    assert.ok(gitDir.endsWith('.git'), `git dir was ${gitDir}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('watcher registry shares one watcher per git dir and refcounts cleanup', () => {
  const registry = createWatcherRegistry();
  try {
    // A fake git dir that won't exist is fine — RepoWatcher.start swallows
    // the missing-path error; we're testing the refcount bookkeeping.
    const unsub1 = registry.subscribe('/tmp/gitsight-fake.git', () => {});
    assert.equal(registry.size(), 1);
    const unsub2 = registry.subscribe('/tmp/gitsight-fake.git', () => {});
    assert.equal(registry.size(), 1); // same dir -> still one watcher
    unsub1();
    assert.equal(registry.size(), 1); // one subscriber left
    unsub2();
    assert.equal(registry.size(), 0); // last out -> watcher torn down
  } finally {
    registry.closeAll();
  }
});

test('GET /api/events streams a hello then a refresh when HEAD moves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-sse-'));
  const server = createCompanionServer({ repo: dir, port: 0, max: 100, root: undefined });
  const controller = new AbortController();
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'sse@gitsight.local']);
    await git(['config', 'user.name', 'SSE Test']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // Open the SSE stream. A hard deadline aborts the fetch so a missed
    // event can never hang the suite.
    const deadline = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Read sequentially (one outstanding read at a time) until `needle`
    // appears in the accumulated buffer or the stream/abort ends it.
    const readUntil = async needle => {
      if (buf.includes(needle)) return true;
      while (true) {
        const { value, done } = await reader.read();
        if (done) return false;
        if (value) buf += decoder.decode(value, { stream: true });
        if (buf.includes(needle)) return true;
      }
    };

    // The greeting arrives immediately.
    assert.ok(await readUntil('event: hello'), `no hello in: ${buf}`);

    // A commit moves HEAD -> the watcher should push a refresh event.
    await git(['commit', '--allow-empty', '-q', '-m', 'second']);
    assert.ok(await readUntil('event: refresh'), `no refresh in: ${buf}`);
    assert.ok(/data: \{.*"head":"main"/.test(buf), `bad refresh payload: ${buf}`);

    clearTimeout(deadline);
    await reader.cancel().catch(() => {});
  } finally {
    controller.abort();
    server.watchers.closeAll();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

