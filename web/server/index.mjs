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
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, normalize, extname } from 'node:path';
import {
  buildGraphSnapshot,
  buildLogArgs,
  resolveHeadLabel,
} from '../../src/shared/graphSnapshotBuild.ts';

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
  const opts = { repo: process.cwd(), port: 5274, max: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--repo' || a === '-C') && argv[i + 1]) opts.repo = argv[++i];
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]) || opts.port;
    else if (a === '--max' && argv[i + 1]) opts.max = Number(argv[++i]) || opts.max;
  }
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

export function createCompanionServer(opts) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/health') {
        const head = await readHead(opts.repo).catch(() => 'unknown');
        sendJson(res, 200, { ok: true, repo: basename(opts.repo), head });
        return;
      }
      if (url.pathname === '/api/graph') {
        const max = Number(url.searchParams.get('max')) || opts.max;
        try {
          const snapshot = await buildSnapshotForRepo(opts.repo, max);
          sendJson(res, 200, snapshot);
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
}

// Only listen when run directly (not when imported by a test).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const server = createCompanionServer(opts);
  server.listen(opts.port, '127.0.0.1', () => {
    process.stdout.write(
      `GitSight companion on http://127.0.0.1:${opts.port}  (repo: ${opts.repo})\n` +
        `  GET /api/graph   snapshot JSON\n` +
        `  GET /api/health  liveness\n`,
    );
  });
}
