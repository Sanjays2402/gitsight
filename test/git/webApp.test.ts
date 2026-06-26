import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  normalizePort,
  buildServerArgs,
  webUrl,
  isPortInUseError,
  parseReadyBanner,
  nextPort,
  DEFAULT_WEB_PORT,
  PORT_SCAN_RANGE,
} from '../../src/git/webApp';

// ── normalizePort ────────────────────────────────────────────────────

test('normalizePort keeps valid ports and falls back otherwise', () => {
  assert.equal(normalizePort(5300), 5300);
  assert.equal(normalizePort('5300'), 5300);
  assert.equal(normalizePort(0), DEFAULT_WEB_PORT);
  assert.equal(normalizePort(70000), DEFAULT_WEB_PORT);
  assert.equal(normalizePort('nope'), DEFAULT_WEB_PORT);
  assert.equal(normalizePort(undefined), DEFAULT_WEB_PORT);
  assert.equal(normalizePort(1.5), DEFAULT_WEB_PORT);
});

// ── buildServerArgs ──────────────────────────────────────────────────

test('buildServerArgs builds the entry + repo + port flags', () => {
  const args = buildServerArgs({ serverEntry: '/x/server/index.mjs', repo: '/proj/repo', port: 5274 });
  assert.deepEqual(args, ['/x/server/index.mjs', '--repo', '/proj/repo', '--port', '5274']);
});

test('buildServerArgs appends --root and --max when given', () => {
  const args = buildServerArgs({
    serverEntry: '/x/server/index.mjs',
    repo: '/proj/repo',
    port: 5300,
    root: '/proj',
    max: 800,
  });
  assert.ok(args.includes('--root'));
  assert.ok(args.includes('/proj'));
  assert.ok(args.includes('--max'));
  assert.ok(args.includes('800'));
});

test('buildServerArgs omits --max when zero or missing', () => {
  const args = buildServerArgs({ serverEntry: '/s.mjs', repo: '/r', port: 5274, max: 0 });
  assert.ok(!args.includes('--max'));
});

test('buildServerArgs appends --allow-mutations only when enabled (W25)', () => {
  const off = buildServerArgs({ serverEntry: '/s.mjs', repo: '/r', port: 5274 });
  assert.ok(!off.includes('--allow-mutations'));
  const on = buildServerArgs({ serverEntry: '/s.mjs', repo: '/r', port: 5274, allowMutations: true });
  assert.ok(on.includes('--allow-mutations'));
});

// ── webUrl ───────────────────────────────────────────────────────────

test('webUrl builds a localhost URL', () => {
  assert.equal(webUrl(5274), 'http://127.0.0.1:5274');
});

// ── isPortInUseError ─────────────────────────────────────────────────

test('isPortInUseError recognises EADDRINUSE phrasings', () => {
  assert.equal(isPortInUseError('Error: listen EADDRINUSE: address already in use 127.0.0.1:5274'), true);
  assert.equal(isPortInUseError('EADDRINUSE'), true);
  assert.equal(isPortInUseError('some other failure'), false);
  assert.equal(isPortInUseError(''), false);
});

// ── parseReadyBanner ─────────────────────────────────────────────────

test('parseReadyBanner extracts the bound port from the banner', () => {
  assert.equal(parseReadyBanner('GitSight companion on http://127.0.0.1:5274  (repo: /x)'), 5274);
  assert.equal(parseReadyBanner('GitSight companion on http://localhost:9001 (repo: /y)'), 9001);
  assert.equal(parseReadyBanner('  GET /api/graph  snapshot JSON'), null);
  assert.equal(parseReadyBanner('random line'), null);
});

// ── nextPort ─────────────────────────────────────────────────────────

test('nextPort steps forward and wraps within the scan range', () => {
  assert.equal(nextPort(5274, 5274), 5275);
  assert.equal(nextPort(5275, 5274), 5276);
  // At the end of the window it wraps back to the base.
  assert.equal(nextPort(5274 + PORT_SCAN_RANGE - 1, 5274), 5274);
});

test('nextPort honours a custom range', () => {
  assert.equal(nextPort(5274, 5274, 3), 5275);
  assert.equal(nextPort(5276, 5274, 3), 5274); // wraps after 3 ports
});
