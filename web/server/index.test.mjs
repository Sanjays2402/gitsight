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
import { parseArgs, buildSnapshotForRepo, buildCommitDetailForRepo, buildFileDiffForRepo, scanReposUnder, resolveRequestRepo, isSafeRev, buildBlameForRepo, buildActivityForRepo, buildDayCommitsForRepo, buildContributorsForRepo, buildAuthorDetailForRepo, resolveGitDir, createWatcherRegistry, createCompanionServer, buildCompareForRepo, buildStashesForRepo, buildStashFileDiffForRepo, runStashActionForRepo, runStashCreateForRepo, readJsonBody } from './index.mjs';

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

test('buildFileDiffForRepo ignoreWhitespace drops a whitespace-only change (W31)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-fws-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@gitsight.local']);
    await git(['config', 'user.name', 'GitSight Test']);
    await pexec('bash', ['-c', 'printf "alpha\\nbeta\\n" > ws.txt'], { cwd: dir });
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'base']);
    // Reindent only: add trailing spaces + leading indent, no content change.
    await pexec('bash', ['-c', 'printf "alpha  \\n  beta\\n" > ws.txt'], { cwd: dir });
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'reindent']);

    // Default: the whitespace edit shows as a hunk.
    const normal = await buildFileDiffForRepo(dir, 'HEAD', 'ws.txt');
    assert.ok(normal.file);
    assert.ok(normal.file.hunks.length >= 1);

    // -w: the whitespace-only change yields an empty diff (no stanza to
    // parse), so the file resolves to null — the UI renders "no diff".
    const ignored = await buildFileDiffForRepo(dir, 'HEAD', 'ws.txt', { ignoreWhitespace: true });
    assert.equal(ignored.file, null);
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

test('buildBlameForRepo --ignore-rev reattributes a reformat to the real author (W44)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-blameignore-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    const who = (name, email) => ({
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    });
    await git(['init', '-q', '-b', 'main']);
    // Ada writes the real content.
    await writeFile(join(dir, 'app.txt'), 'hello world\n');
    await git(['add', 'app.txt']);
    await git(['commit', '-q', '-m', 'feat: greeting'], who('Ada', 'ada@x.com'));
    // Robot reformats the whole line (trailing whitespace) — pure noise.
    await writeFile(join(dir, 'app.txt'), 'hello world   \n');
    await git(['add', 'app.txt']);
    await git(['commit', '-q', '-m', 'style: reformat'], who('Robot', 'bot@x.com'));
    const noiseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();

    // Without ignoring, the line is attributed to the reformat commit (Robot).
    const plain = await buildBlameForRepo(dir, 'HEAD', 'app.txt');
    assert.equal(plain.lines[0].author, 'Robot');
    assert.deepEqual(plain.ignoredRevs, []);

    // Ignoring the noise commit reattributes the line back to Ada.
    const ignored = await buildBlameForRepo(dir, 'HEAD', 'app.txt', [noiseSha]);
    assert.equal(ignored.lines[0].author, 'Ada');
    assert.deepEqual(ignored.ignoredRevs, [noiseSha.toLowerCase()]);

    // A junk ignore value is dropped, not smuggled into the argv.
    const junk = await buildBlameForRepo(dir, 'HEAD', 'app.txt', ['--all', 'main']);
    assert.deepEqual(junk.ignoredRevs, []);
    assert.equal(junk.lines[0].author, 'Robot');
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
    assert.equal(cal.metric, 'commits');
    // Every week column is a full 7 days.
    for (const week of cal.weeks) assert.equal(week.length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildActivityForRepo with metric=churn counts lines changed per day (W39)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-churn-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    const day = (d) => ({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
    // Day 1: add a 3-line file (3 insertions).
    await writeFile(join(dir, 'f.txt'), 'a\nb\nc\n');
    await git(['add', 'f.txt']);
    await git(['commit', '-q', '-m', 'add'], day('2026-06-01T09:00:00'));
    // Day 2: rewrite it to 5 lines (the diff is +5/-3 = 8 churn).
    await writeFile(join(dir, 'f.txt'), 'x\ny\nz\nw\nv\n');
    await git(['add', 'f.txt']);
    await git(['commit', '-q', '-m', 'edit'], day('2026-06-02T09:00:00'));

    const cal = await buildActivityForRepo(dir, 100, 'churn');
    assert.equal(cal.metric, 'churn');
    // Two active days, churn 3 then 8; busiest day = 8.
    assert.equal(cal.activeDays, 2);
    assert.equal(cal.total, 11);
    assert.equal(cal.max, 8);
    for (const week of cal.weeks) assert.equal(week.length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildActivityForRepo scopes to one calendar year and reports the year list (W43)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-actyear-'));
  try {
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    const day = (d) => ({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
    await git(['commit', '--allow-empty', '-q', '-m', 'old1'], day('2024-03-02T09:00:00'));
    await git(['commit', '--allow-empty', '-q', '-m', 'old2'], day('2024-03-03T09:00:00'));
    await git(['commit', '--allow-empty', '-q', '-m', 'new1'], day('2026-06-01T09:00:00'));

    // Unscoped: all three commits, both years reported newest-first.
    const all = await buildActivityForRepo(dir, 100, 'commits', null);
    assert.equal(all.total, 3);
    assert.equal(all.year, null);
    assert.deepEqual(all.years, [2026, 2024]);

    // Scoped to 2024: only the two old commits, year echoed, full list kept.
    const y2024 = await buildActivityForRepo(dir, 100, 'commits', 2024);
    assert.equal(y2024.total, 2);
    assert.equal(y2024.year, 2024);
    assert.equal(y2024.first, '2024-03-02');
    assert.equal(y2024.last, '2024-03-03');
    assert.deepEqual(y2024.years, [2026, 2024]);

    // Scoped to a year with no commits: empty calendar, list still intact.
    const y2025 = await buildActivityForRepo(dir, 100, 'commits', 2025);
    assert.equal(y2025.total, 0);
    assert.equal(y2025.year, 2025);
    assert.deepEqual(y2025.years, [2026, 2024]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildDayCommitsForRepo (W22, integration) ────────────────────────

test('buildDayCommitsForRepo returns commits bucketed to one author-local day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-day-'));
  try {
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    const day = (d) => ({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
    await git(['commit', '--allow-empty', '-q', '-m', 'jun1-morning'], day('2026-06-01T09:00:00'));
    await git(['commit', '--allow-empty', '-q', '-m', 'jun1-evening'], day('2026-06-01T18:00:00'));
    await git(['commit', '--allow-empty', '-q', '-m', 'jun3-noon'], day('2026-06-03T12:00:00'));

    const jun1 = await buildDayCommitsForRepo(dir, '2026-06-01', 100);
    assert.equal(jun1.date, '2026-06-01');
    assert.equal(jun1.total, 2);
    assert.deepEqual(jun1.commits.map(c => c.subject).sort(), ['jun1-evening', 'jun1-morning']);

    const jun3 = await buildDayCommitsForRepo(dir, '2026-06-03', 100);
    assert.equal(jun3.total, 1);
    assert.equal(jun3.commits[0].subject, 'jun3-noon');

    // A day with no commits is an empty (but valid) list.
    const empty = await buildDayCommitsForRepo(dir, '2026-06-02', 100);
    assert.equal(empty.total, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildDayCommitsForRepo rejects a malformed day key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-daybad-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    await assert.rejects(() => buildDayCommitsForRepo(dir, 'not-a-day', 100), /invalid day/);
    await assert.rejects(() => buildDayCommitsForRepo(dir, '06/01/2026', 100), /invalid day/);
    // A structurally-valid but impossible key is accepted as a key and
    // simply matches nothing (the bucket compare is a cheap string match).
    const none = await buildDayCommitsForRepo(dir, '2026-13-40', 100);
    assert.equal(none.total, 0);
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

// ── buildAuthorDetailForRepo (W23, integration) ──────────────────────

test('buildAuthorDetailForRepo folds one author\'s files + sparkline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-author-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args, env) => pexec('git', args, { cwd: dir, env: { ...process.env, ...env } });
    const as = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'fallback@b.c']);
    await git(['config', 'user.name', 'Fallback']);

    await writeFile(join(dir, 'a.txt'), 'one\n');
    await git(['add', 'a.txt']);
    await git(['commit', '-q', '-m', 'ada c1'], as('Ada', 'ada@x.com'));
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
    await git(['add', 'a.txt']);
    await git(['commit', '-q', '-m', 'ada c2'], as('Ada', 'ada@x.com'));
    await writeFile(join(dir, 'b.txt'), 'b\n');
    await git(['add', 'b.txt']);
    await git(['commit', '-q', '-m', 'bob c1'], as('Bob', 'bob@y.com'));

    const detail = await buildAuthorDetailForRepo(dir, 'ada@x.com', 100);
    assert.equal(detail.email, 'ada@x.com');
    assert.equal(detail.name, 'Ada');
    assert.equal(detail.commits, 2);
    // a.txt touched by both of Ada's commits; b.txt belongs to Bob (excluded).
    assert.ok(detail.files.some(f => f.path === 'a.txt' && f.commits === 2));
    assert.ok(!detail.files.some(f => f.path === 'b.txt'));
    // Sparkline carries the 26-week window and counts Ada's commits.
    assert.equal(detail.sparkline.weeks, 26);
    assert.equal(detail.sparkline.total, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAuthorDetailForRepo rejects a flag-like author', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-authorbad-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    await assert.rejects(() => buildAuthorDetailForRepo(dir, '--output=evil', 100), /invalid author/);
    await assert.rejects(() => buildAuthorDetailForRepo(dir, '', 100), /invalid author/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildCompareForRepo (W18, integration) ───────────────────────────

test('buildCompareForRepo computes ahead/behind + file churn for a branch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-compare-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'cmp@gitsight.local']);
    await git(['config', 'user.name', 'Compare Test']);
    await writeFile(join(dir, 'app.txt'), 'one\ntwo\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'base: seed']);

    // A feature branch adds two commits + edits a file.
    await git(['checkout', '-q', '-b', 'feature']);
    await writeFile(join(dir, 'app.txt'), 'one\nTWO\nthree\n');
    await writeFile(join(dir, 'new.txt'), 'fresh\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'feat: extend app']);
    await git(['commit', '--allow-empty', '-q', '-m', 'chore: tidy']);

    // main moves forward independently (so feature is also 1 behind).
    await git(['checkout', '-q', 'main']);
    await git(['commit', '--allow-empty', '-q', '-m', 'main: hotfix']);

    const cmp = await buildCompareForRepo(dir, 'main', 'feature');
    assert.equal(cmp.base, 'main');
    assert.equal(cmp.head, 'feature');
    // feature has 2 commits main doesn't.
    assert.equal(cmp.ahead.length, 2);
    assert.equal(cmp.ahead[0].subject, 'chore: tidy');
    // main has 1 commit feature doesn't.
    assert.equal(cmp.behind.length, 1);
    assert.equal(cmp.behind[0].subject, 'main: hotfix');
    // The file set: app.txt modified + new.txt added.
    const byPath = Object.fromEntries(cmp.files.map(f => [f.path, f]));
    assert.equal(byPath['app.txt'].status, 'modified');
    assert.equal(byPath['new.txt'].status, 'added');
    assert.ok(cmp.insertions > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildCompareForRepo rejects an unsafe ref', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-cmpbad-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    await assert.rejects(() => buildCompareForRepo(dir, '--output=/tmp/x', 'HEAD'), /invalid base/);
    await assert.rejects(() => buildCompareForRepo(dir, 'main', '--bad'), /invalid head/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── buildStashesForRepo (W19, integration) ───────────────────────────

test('buildStashesForRepo lists stashes with file churn + lazy diff', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-stash-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'stash@gitsight.local']);
    await git(['config', 'user.name', 'Stash Test']);
    await writeFile(join(dir, 'app.txt'), 'one\ntwo\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'base']);

    // Create two stashes.
    await writeFile(join(dir, 'app.txt'), 'one\nTWO\nthree\n');
    await writeFile(join(dir, 'extra.txt'), 'new file\n');
    await git(['add', '-A']);
    await git(['stash', 'push', '-q', '-m', 'first wip']);
    await writeFile(join(dir, 'app.txt'), 'one\ntwo\nLATER\n');
    await git(['add', '-A']);
    await git(['stash', 'push', '-q', '-m', 'second wip']);

    const list = await buildStashesForRepo(dir);
    assert.equal(list.total, 2);
    // Newest first: stash@{0} is "second wip".
    assert.equal(list.stashes[0].index, 0);
    assert.equal(list.stashes[0].ref, 'stash@{0}');
    assert.equal(list.stashes[0].branch, 'main');
    assert.ok(list.stashes[0].subject.includes('second wip'));
    assert.ok(list.stashes[0].filesChanged >= 1);
    // The first stash touched two files (app.txt + extra.txt).
    const first = list.stashes[1];
    assert.ok(first.subject.includes('first wip'));
    assert.equal(first.filesChanged, 2);
    const paths = first.files.map(f => f.path).sort();
    assert.deepEqual(paths, ['app.txt', 'extra.txt']);

    // Lazy per-file diff for a stash file.
    const { file } = await buildStashFileDiffForRepo(dir, 1, 'extra.txt');
    assert.ok(file);
    assert.equal(file.path, 'extra.txt');
    assert.equal(file.status, 'added');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildStashesForRepo returns an empty list when there are no stashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-nostash-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    const list = await buildStashesForRepo(dir);
    assert.equal(list.total, 0);
    assert.deepEqual(list.stashes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── runStashActionForRepo (W25, integration) ─────────────────────────

test('runStashActionForRepo applies then drops a stash (mutating)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-stashact-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await writeFile(join(dir, 'f.txt'), 'base\n');
    await git(['add', 'f.txt']);
    await git(['commit', '-q', '-m', 'init']);
    // Create two stashes.
    await writeFile(join(dir, 'f.txt'), 'change one\n');
    await git(['stash', 'push', '-m', 'wip one']);
    await writeFile(join(dir, 'f.txt'), 'change two\n');
    await git(['stash', 'push', '-m', 'wip two']);

    let list = await buildStashesForRepo(dir);
    assert.equal(list.total, 2);

    // apply leaves the entry in place (working tree now dirty).
    const applied = await runStashActionForRepo(dir, 'apply', 0);
    assert.equal(applied.action, 'apply');
    assert.equal(applied.removed, false);
    assert.equal(applied.total, 2);
    // Reset the working tree so the next op is clean.
    await git(['checkout', '--', 'f.txt']);

    // drop removes the entry.
    const dropped = await runStashActionForRepo(dir, 'drop', 0);
    assert.equal(dropped.removed, true);
    assert.equal(dropped.total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runStashActionForRepo rejects a bad action / index (no injection)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-stashactbad-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    await assert.rejects(() => runStashActionForRepo(dir, 'clear', 0), /invalid stash action/);
    await assert.rejects(() => runStashActionForRepo(dir, '--exec=evil', 0), /invalid stash action/);
    await assert.rejects(() => runStashActionForRepo(dir, 'apply', -1), /invalid stash index/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseArgs reads --allow-mutations (defaults off)', () => {
  assert.equal(parseArgs([]).allowMutations, false);
  assert.equal(parseArgs(['--allow-mutations']).allowMutations, true);
});

// ── runStashCreateForRepo (W42, integration) ─────────────────────────

test('runStashCreateForRepo stashes working changes with a message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-stashnew-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await writeFile(join(dir, 'f.txt'), 'base\n');
    await git(['add', 'f.txt']);
    await git(['commit', '-q', '-m', 'init']);
    // Dirty the tree, then stash via the builder.
    await writeFile(join(dir, 'f.txt'), 'edited\n');

    const result = await runStashCreateForRepo(dir, { message: 'wip: my work' });
    assert.equal(result.created, true);
    assert.equal(result.total, 1);
    assert.match(result.stashes[0].subject, /wip: my work/);
    // The working tree is clean again (the change went into the stash).
    const status = (await git(['status', '--porcelain'])).stdout.trim();
    assert.equal(status, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runStashCreateForRepo includes untracked files when asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-stashnewu-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    // A brand-new untracked file: only -u captures it.
    await writeFile(join(dir, 'new.txt'), 'fresh\n');

    const result = await runStashCreateForRepo(dir, { includeUntracked: true });
    assert.equal(result.created, true);
    assert.equal(result.total, 1);
    const status = (await git(['status', '--porcelain'])).stdout.trim();
    assert.equal(status, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runStashCreateForRepo reports created=false when there is nothing to stash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitsight-stashnoop-'));
  try {
    const git = (args) => pexec('git', args, { cwd: dir });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'a@b.c']);
    await git(['config', 'user.name', 'A']);
    await git(['commit', '--allow-empty', '-q', '-m', 'init']);
    // Clean tree -> nothing to stash. Should NOT throw; created=false.
    const result = await runStashCreateForRepo(dir, { message: 'noop' });
    assert.equal(result.created, false);
    assert.equal(result.total, 0);
    assert.match(result.message, /no local changes/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonBody parses a small JSON object and rejects junk', async () => {
  const { Readable } = await import('node:stream');
  const makeReq = (s) => Readable.from([Buffer.from(s)]);
  assert.deepEqual(await readJsonBody(makeReq('{"action":"pop","index":1}')), { action: 'pop', index: 1 });
  assert.deepEqual(await readJsonBody(makeReq('')), {});
  await assert.rejects(() => readJsonBody(makeReq('not json')), /invalid JSON/);
  await assert.rejects(() => readJsonBody(makeReq('[1,2]')), /must be a JSON object/);
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

