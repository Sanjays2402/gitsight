/**
 * GitSight companion server (W4).
 *
 * The "bundled companion" data path recorded in STATE.md: a tiny local
 * Node HTTP server that shells out to `git` in a target repo, builds a
 * GraphSnapshot with the SHARED pure builder, and serves it at
 * /api/graph. It also serves the built SPA (web/dist) so the whole thing
 * is one `gitsight web` command with no external services.
 *
 * Runtime note: Node >= 22.18 / 23 strips TypeScript types on the fly, so
 * this .mjs imports the shared .ts builder DIRECTLY — no build step for
 * the server, and zero snapshot-shape drift from the extension.
 *
 * Usage:
 *   node server/index.mjs [--repo <path>] [--port 5274] [--max 500]
 *
 * Endpoints:
 *   GET /api/graph   -> GraphSnapshot JSON for the target repo
 *   GET /api/health  -> { ok, repo, head }
 *   GET /*           -> static SPA from ../dist (falls back to index.html)
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, normalize, extname, resolve } from 'node:path';
import {
  buildGraphSnapshot,
  buildLogArgs,
  resolveHeadLabel,
} from '../../src/shared/graphSnapshotBuild.ts';
import {
  buildCommitDetail,
  COMMIT_DETAIL_FORMAT,
} from '../../src/shared/commitDetail.ts';
import { parseUnifiedDiff } from '../../src/shared/diffParse.ts';
import {
  isRepoAllowed,
  buildRepoEntries,
} from '../../src/shared/repoPicker.ts';
import { parsePorcelainBlame } from '../../src/shared/blame.ts';
import { buildActivityCalendar } from '../../src/shared/activity.ts';
import { buildContributors } from '../../src/shared/contributors.ts';
import {
  gitChangeTriggersRefresh,
  formatSseMessage,
} from '../../src/shared/repoWatch.ts';
import {
  buildRangeComparison,
  COMPARE_LOG_FORMAT,
} from '../../src/shared/rangeCompare.ts';

const pexec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function parseArgs(argv) {
  const opts = { repo: process.cwd(), port: 5274, max: 500, root: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--repo' || a === '-C') && argv[i + 1]) opts.repo = argv[++i];
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]) || opts.port;
    else if (a === '--max' && argv[i + 1]) opts.max = Number(argv[++i]) || opts.max;
    else if (a === '--root' && argv[i + 1]) opts.root = argv[++i];
  }
  // Normalise to absolute paths so the repo-allow gate compares like with like.
  opts.repo = resolve(opts.repo);
  if (opts.root) opts.root = resolve(opts.root);
  return opts;
}

async function git(repo, args) {
  const { stdout } = await pexec('git', args, {
    cwd: repo,
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

async function readHead(repo) {
  let branch;
  try {
    branch = (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    branch = undefined; // detached
  }
  let shortSha;
  try {
    shortSha = (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim();
  } catch {
    shortSha = undefined;
  }
  return resolveHeadLabel(branch, shortSha);
}

export async function buildSnapshotForRepo(repo, max) {
  // Validate the repo first so we return a clean 400 rather than a 500.
  await git(repo, ['rev-parse', '--git-dir']);
  const toplevel = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  const head = await readHead(repo);
  const stdout = await git(repo, buildLogArgs({ max, all: true }));
  return buildGraphSnapshot({
    repo: basename(toplevel) || 'repository',
    head,
    stdout,
  });
}

/**
 * Validate that a string is a plausible git rev (sha, short sha, or a
 * ref name) before we hand it to `git show`. Rejects flag-like and
 * whitespace-bearing inputs so a crafted query can't smuggle an option
 * into the argv. Allows the limited punctuation valid refs use (`/._-`).
 */
export function isSafeRev(rev) {
  return typeof rev === 'string' && /^[0-9a-zA-Z][0-9a-zA-Z/._^~-]*$/.test(rev) && rev.length <= 200;
}

export async function buildCommitDetailForRepo(repo, rev) {
  await git(repo, ['rev-parse', '--git-dir']);
  if (!isSafeRev(rev)) {
    throw new Error(`invalid revision: ${rev}`);
  }
  // Three reads: meta+body, numstat (-z), name-status (-z). The `--` guard
  // and `-m --first-parent` make merges show their first-parent diff.
  const metaStdout = await git(repo, [
    'show',
    '--no-patch',
    `--format=${COMMIT_DETAIL_FORMAT}`,
    rev,
  ]);
  const numstatStdout = await git(repo, [
    'show',
    '-m',
    '--first-parent',
    '--numstat',
    '-z',
    '--format=',
    rev,
  ]);
  const nameStatusStdout = await git(repo, [
    'show',
    '-m',
    '--first-parent',
    '--name-status',
    '-z',
    '--format=',
    rev,
  ]);
  let refs = [];
  try {
    const decoration = (await git(repo, ['log', '-1', '--format=%D', rev])).trim();
    refs = decoration.split(',').map(s => s.trim()).filter(Boolean);
  } catch {
    refs = [];
  }
  const detail = buildCommitDetail({ metaStdout, numstatStdout, nameStatusStdout, refs });
  if (!detail) throw new Error(`could not read commit ${rev}`);
  return detail;
}

/**
 * Build the unified diff for a single file in a commit and parse it into
 * the shared FileDiff shape. Scopes `git show` to one pathspec so we
 * never stream a huge multi-file patch to the browser.
 */
export async function buildFileDiffForRepo(repo, rev, path) {
  await git(repo, ['rev-parse', '--git-dir']);
  if (!isSafeRev(rev)) {
    throw new Error(`invalid revision: ${rev}`);
  }
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new Error('invalid path');
  }
  // `--` separates the rev from the pathspec so a path that looks like a
  // flag can't be reinterpreted as one. `-M -C` enable rename/copy
  // detection so the diff header carries the old path.
  const stdout = await git(repo, [
    'show',
    '--no-color',
    '--first-parent',
    '-m',
    '-M',
    '-C',
    '--format=',
    rev,
    '--',
    path,
  ]);
  const files = parseUnifiedDiff(stdout);
  // Prefer the file whose post-image path matches the request; fall back
  // to the first stanza (renames change the path under us).
  const file = files.find(f => f.path === path) ?? files[0] ?? null;
  return { rev, path, file };
}

/**
 * Build the age-heatmap blame model for one file (W12). Shells out to
 * `git blame --porcelain` and parses it with the shared pure parser. The
 * `--` guard keeps a flag-like path from being reinterpreted as an option.
 */
export async function buildBlameForRepo(repo, rev, path) {
  await git(repo, ['rev-parse', '--git-dir']);
  if (!isSafeRev(rev)) {
    throw new Error(`invalid revision: ${rev}`);
  }
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new Error('invalid path');
  }
  const stdout = await git(repo, [
    'blame',
    '--porcelain',
    rev,
    '--',
    path,
  ]);
  const model = parsePorcelainBlame(stdout);
  return { rev, path, ...model };
}

/**
 * Build the contribution calendar (W13). Reuses the snapshot builder
 * (which already carries author dates) but pulls a larger history window
 * so the calendar reflects more than the graph's default cap.
 */
export async function buildActivityForRepo(repo, max) {
  const snapshot = await buildSnapshotForRepo(repo, max);
  const calendar = buildActivityCalendar(snapshot.commits, { maxWeeks: 53 });
  return { repo: snapshot.repo, head: snapshot.head, ...calendar };
}

/**
 * Build the contributor leaderboard (W14) from the snapshot's commits.
 */
export async function buildContributorsForRepo(repo, max) {
  const snapshot = await buildSnapshotForRepo(repo, max);
  const stats = buildContributors(snapshot.commits);
  return { repo: snapshot.repo, head: snapshot.head, ...stats };
}

/**
 * Resolve a repo's git directory (W17). For a normal clone this is
 * `<repo>/.git`; for a linked worktree `.git` is a file pointing
 * elsewhere, so we ask git for the absolute path.
 */
export async function resolveGitDir(repo) {
  const out = await git(repo, ['rev-parse', '--absolute-git-dir']);
  return out.trim();
}

/**
 * Build a symmetric-range comparison between two refs (W18). Runs four
 * cheap git reads and folds them with the shared pure assembler: the
 * commits unique to head (`base..head`), the commits unique to base
 * (`head..base`), and the `base...head` file churn (numstat + name-status).
 * Per-file unified diffs are fetched lazily by /api/diff (W7).
 */
export async function buildCompareForRepo(repo, base, head) {
  await git(repo, ['rev-parse', '--git-dir']);
  if (!isSafeRev(base)) throw new Error(`invalid base: ${base}`);
  if (!isSafeRev(head)) throw new Error(`invalid head: ${head}`);
  const logFmt = `--pretty=format:${COMPARE_LOG_FORMAT}`;
  // `--` terminates the rev list so a ref that looks like a flag can't be
  // reinterpreted as an option.
  const [aheadStdout, behindStdout, numstatStdout, nameStatusStdout] = await Promise.all([
    git(repo, ['log', logFmt, `${base}..${head}`, '--']),
    git(repo, ['log', logFmt, `${head}..${base}`, '--']),
    git(repo, ['diff', '--numstat', '-z', '-M', '-C', `${base}...${head}`, '--']),
    git(repo, ['diff', '--name-status', '-z', '-M', '-C', `${base}...${head}`, '--']),
  ]);
  return buildRangeComparison({ base, head, aheadStdout, behindStdout, numstatStdout, nameStatusStdout });
}

/**
 * Watches a repo's git dir and invokes `onRefresh` (debounced) whenever a
 * commit/ref/stash mutation lands (W17). Uses a single recursive
 * fs.watch where supported (macOS/Windows) and falls back to watching the
 * key subdirectories (refs, logs) plus the git-dir root elsewhere. The
 * change classifier (shared, tested) decides what counts as a refresh so
 * index writes and pack churn don't spam the browser.
 */
export class RepoWatcher {
  constructor(gitDir, onRefresh, opts = {}) {
    this.gitDir = gitDir;
    this.onRefresh = onRefresh;
    this.debounceMs = opts.debounceMs ?? 250;
    this.watchers = [];
    this.timer = null;
    this.closed = false;
  }

  start() {
    // Try one recursive watch first (cheap + complete where supported).
    try {
      this.watchers.push(
        watch(this.gitDir, { recursive: true }, (_event, filename) => {
          if (filename) this.onPath(String(filename));
        }),
      );
      return this;
    } catch {
      /* recursive unsupported on this platform — fall back below */
    }
    // Fallback: watch the git-dir root + the ref/log subtrees individually.
    const targets = [this.gitDir, join(this.gitDir, 'refs'), join(this.gitDir, 'logs')];
    for (const dir of targets) {
      try {
        this.watchers.push(
          watch(dir, (_event, filename) => {
            if (!filename) return;
            // Re-root the filename under the git dir so the classifier sees
            // the same shape the recursive watcher would emit.
            const rel = dir === this.gitDir ? String(filename) : `${basename(dir)}/${filename}`;
            this.onPath(rel);
          }),
        );
      } catch {
        /* a missing subtree (e.g. no logs yet) is fine */
      }
    }
    return this;
  }

  onPath(relPath) {
    if (this.closed) return;
    if (!gitChangeTriggersRefresh(relPath)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.onRefresh();
    }, this.debounceMs);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
  }
}

/** True when a directory is the top of a git work tree or a bare repo. */
async function isGitRepo(dir) {
  try {
    const s = await stat(join(dir, '.git'));
    if (s.isDirectory() || s.isFile()) return true;
  } catch {
    /* no .git entry */
  }
  // Bare repo heuristic: a HEAD file + objects dir at the top level.
  try {
    const [head, objects] = await Promise.all([
      stat(join(dir, 'HEAD')),
      stat(join(dir, 'objects')),
    ]);
    return head.isFile() && objects.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan one level under `root` for git repositories. Shallow on purpose:
 * the picker lists project directories, not every nested submodule, and a
 * deep recursive walk on a big tree would be slow + surprising. The
 * configured root and the current repo are always considered too.
 */
export async function scanReposUnder(root, opts = {}) {
  if (!root) return [];
  const found = [];
  // The root itself may be a repo.
  if (await isGitRepo(root)) found.push(resolve(root));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  const limit = opts.limit ?? 200;
  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .slice(0, limit);
  await Promise.all(
    dirs.map(async e => {
      const full = resolve(root, e.name);
      if (await isGitRepo(full)) found.push(full);
    }),
  );
  return found;
}

/**
 * Resolve the repo a request should act on: the `?repo=` override when it
 * is allowed (default repo or within root), else the default. Throws on a
 * disallowed override so the browser gets a clean 403-style error rather
 * than silently reading the default.
 */
export function resolveRequestRepo(searchParams, opts) {
  const override = searchParams.get('repo');
  if (!override) return opts.repo;
  const candidate = resolve(override);
  if (isRepoAllowed(candidate, { repo: opts.repo, root: opts.root })) return candidate;
  throw new Error(`repo not allowed: ${override}`);
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

async function serveStatic(res, urlPath) {
  // Resolve within DIST_DIR only; reject path traversal.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST_DIR, rel === '/' || rel === '' ? 'index.html' : rel);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback: serve index.html for unknown non-asset routes.
    try {
      const html = await readFile(join(DIST_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(html);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('GitSight web build not found. Run `npm --prefix web run build` first.');
    }
  }
}

/**
 * A reference-counted registry of RepoWatchers keyed by git dir (W17).
 * Many SSE clients can watch the same repo with one underlying fs watcher;
 * the watcher is torn down when the last subscriber disconnects.
 */
export function createWatcherRegistry() {
  const entries = new Map(); // gitDir -> { watcher, subscribers:Set<fn> }
  return {
    subscribe(gitDir, onRefresh) {
      let entry = entries.get(gitDir);
      if (!entry) {
        const subscribers = new Set();
        const watcher = new RepoWatcher(gitDir, () => {
          for (const fn of subscribers) {
            try {
              fn();
            } catch {
              /* a broken subscriber shouldn't sink the rest */
            }
          }
        }).start();
        entry = { watcher, subscribers };
        entries.set(gitDir, entry);
      }
      entry.subscribers.add(onRefresh);
      return () => {
        const e = entries.get(gitDir);
        if (!e) return;
        e.subscribers.delete(onRefresh);
        if (e.subscribers.size === 0) {
          e.watcher.close();
          entries.delete(gitDir);
        }
      };
    },
    /** Tear every watcher down (server shutdown / tests). */
    closeAll() {
      for (const e of entries.values()) e.watcher.close();
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Open an SSE stream for a repo (W17). Resolves the repo's git dir,
 * subscribes to the shared watcher, and pushes a `refresh` event (with the
 * fresh HEAD label) whenever the graph changes. A periodic keep-alive
 * comment holds the connection open through proxies; the subscription is
 * released + watcher refcount dropped when the client disconnects.
 */
export async function openEventStream(req, res, repo, watchers) {
  const gitDir = await resolveGitDir(repo);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
  // Greet the client so EventSource flips to OPEN immediately.
  res.write(formatSseMessage({ event: 'hello', data: { repo: basename(repo) }, retry: 3000 }));

  const push = async () => {
    const head = await readHead(repo).catch(() => 'unknown');
    res.write(formatSseMessage({ event: 'refresh', data: { repo: basename(repo), head, at: Date.now() } }));
  };
  const unsubscribe = watchers.subscribe(gitDir, () => void push());

  const keepAlive = setInterval(() => {
    res.write(formatSseMessage({ comment: 'keep-alive' }));
  }, 25000);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

export function createCompanionServer(opts) {
  const watchers = createWatcherRegistry();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/health') {
        const head = await readHead(opts.repo).catch(() => 'unknown');
        sendJson(res, 200, { ok: true, repo: basename(opts.repo), head, root: opts.root ?? null });
        return;
      }
      // GET /api/repos -> the switchable repo list (current + scan root).
      if (url.pathname === '/api/repos') {
        try {
          const paths = await scanReposUnder(opts.root);
          const repos = buildRepoEntries(paths, opts.repo);
          sendJson(res, 200, { repos, root: opts.root ?? null });
        } catch (e) {
          sendJson(res, 500, { error: String(e?.message ?? e) });
        }
        return;
      }
      if (url.pathname === '/api/graph') {
        const max = Number(url.searchParams.get('max')) || opts.max;
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const snapshot = await buildSnapshotForRepo(repo, max);
          sendJson(res, 200, snapshot);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), repo: opts.repo });
        }
        return;
      }
      // GET /api/commit/<rev> -> CommitDetail JSON for one commit.
      const commitMatch = /^\/api\/commit\/(.+)$/.exec(url.pathname);
      if (commitMatch) {
        const rev = decodeURIComponent(commitMatch[1]);
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const detail = await buildCommitDetailForRepo(repo, rev);
          sendJson(res, 200, detail);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), rev });
        }
        return;
      }
      // GET /api/diff?rev=<rev>&path=<file> -> parsed FileDiff for one file.
      if (url.pathname === '/api/diff') {
        const rev = url.searchParams.get('rev') ?? 'HEAD';
        const path = url.searchParams.get('path') ?? '';
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const diff = await buildFileDiffForRepo(repo, rev, path);
          sendJson(res, 200, diff);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), rev, path });
        }
        return;
      }
      // GET /api/blame?rev=<rev>&path=<file> -> per-line blame heatmap (W12).
      if (url.pathname === '/api/blame') {
        const rev = url.searchParams.get('rev') ?? 'HEAD';
        const path = url.searchParams.get('path') ?? '';
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const blame = await buildBlameForRepo(repo, rev, path);
          sendJson(res, 200, blame);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), rev, path });
        }
        return;
      }
      // GET /api/activity -> contribution calendar (W13). Pulls a wider
      // history window than the graph so the calendar is meaningful.
      if (url.pathname === '/api/activity') {
        const max = Number(url.searchParams.get('max')) || 5000;
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const activity = await buildActivityForRepo(repo, max);
          sendJson(res, 200, activity);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), repo: opts.repo });
        }
        return;
      }
      // GET /api/contributors -> author leaderboard (W14).
      if (url.pathname === '/api/contributors') {
        const max = Number(url.searchParams.get('max')) || 5000;
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const contributors = await buildContributorsForRepo(repo, max);
          sendJson(res, 200, contributors);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), repo: opts.repo });
        }
        return;
      }
      // GET /api/compare?base=&head= -> symmetric range comparison (W18).
      if (url.pathname === '/api/compare') {
        const base = url.searchParams.get('base') ?? 'main';
        const head = url.searchParams.get('head') ?? 'HEAD';
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          const comparison = await buildCompareForRepo(repo, base, head);
          sendJson(res, 200, comparison);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), base, head });
        }
        return;
      }
      // GET /api/events -> Server-Sent Events live-refresh stream (W17).
      // Emits a `refresh` event (debounced) whenever the watched repo's
      // commit graph changes, so the browser can re-pull without polling.
      if (url.pathname === '/api/events') {
        try {
          const repo = resolveRequestRepo(url.searchParams, opts);
          await openEventStream(req, res, repo, watchers);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message ?? e), repo: opts.repo });
        }
        return;
      }
      await serveStatic(res, url.pathname);
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  });
  // Tear watchers down when the server closes (tidy shutdown + tests).
  server.on('close', () => watchers.closeAll());
  // Expose the registry so callers/tests can inspect or force-cleanup.
  server.watchers = watchers;
  return server;
}

// Only listen when run directly (not when imported by a test).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const server = createCompanionServer(opts);
  server.listen(opts.port, '127.0.0.1', () => {
    process.stdout.write(
      `GitSight companion on http://127.0.0.1:${opts.port}  (repo: ${opts.repo})\n` +
        (opts.root ? `  scan root: ${opts.root}\n` : '') +
        `  GET /api/graph         snapshot JSON\n` +
        `  GET /api/activity      contribution calendar\n` +
        `  GET /api/contributors  author leaderboard\n` +
        `  GET /api/blame         per-file blame heatmap\n` +
        `  GET /api/events        live-refresh SSE stream\n` +
        `  GET /api/repos         switchable repos\n` +
        `  GET /api/health        liveness\n`,
    );
  });
}
