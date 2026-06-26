/**
 * Pure helpers for the `gitsight web` launcher (W20).
 *
 * No `vscode`, no `child_process`, no `net` — just the deterministic bits
 * of launching the bundled companion server + opening the browser, so the
 * port/argv/URL logic is unit-tested without spinning up a process.
 *
 * The view layer (src/views/webApp.ts) owns the side effects: spawning
 * `node web/server/index.mjs`, waiting for it to bind, and calling
 * `vscode.env.openExternal`.
 *
 * Tests: test/git/webApp.test.ts
 */

/** Default port the companion binds when free. */
export const DEFAULT_WEB_PORT = 5274;
/** How many sequential ports to try before giving up. */
export const PORT_SCAN_RANGE = 50;

/** Clamp a configured port into the valid TCP range, or fall back. */
export function normalizePort(port: unknown, fallback: number = DEFAULT_WEB_PORT): number {
  const n = typeof port === 'number' ? port : Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/**
 * Build the argv (after `node`) for the companion server. `serverEntry` is
 * the absolute path to web/server/index.mjs; the repo + port + optional
 * scan root are passed as flags the server already understands.
 */
export function buildServerArgs(opts: {
  serverEntry: string;
  repo: string;
  port: number;
  root?: string;
  max?: number;
  allowMutations?: boolean;
}): string[] {
  const args = [opts.serverEntry, '--repo', opts.repo, '--port', String(opts.port)];
  if (opts.root) args.push('--root', opts.root);
  if (opts.max && opts.max > 0) args.push('--max', String(opts.max));
  if (opts.allowMutations) args.push('--allow-mutations');
  return args;
}

/** The localhost URL the browser should open for a bound port. */
export function webUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Detect the "address in use" failure from a spawned server's stderr so
 * the launcher can retry on the next port rather than surfacing a raw
 * error. Matches Node's EADDRINUSE and the common phrasings.
 */
export function isPortInUseError(stderr: string): boolean {
  return /EADDRINUSE|address already in use|listen EADDRINUSE/i.test(stderr);
}

/**
 * Parse the companion's startup banner to confirm it bound + extract the
 * port it actually used. The server prints
 *   "GitSight companion on http://127.0.0.1:<port>  (repo: ...)"
 * Returns the port number, or null if the line isn't a ready banner.
 */
export function parseReadyBanner(line: string): number | null {
  const m = /GitSight companion on https?:\/\/[^:]+:(\d+)/.exec(line);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) ? port : null;
}

/**
 * The next port to try after a collision. Wraps within the scan range so
 * we never wander past a sane window of ports.
 */
export function nextPort(current: number, base: number, range: number = PORT_SCAN_RANGE): number {
  const offset = current - base;
  const next = base + ((offset + 1) % range);
  return next;
}
