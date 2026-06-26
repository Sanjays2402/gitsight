/**
 * `GitSight: Open Web App` (W20) — launch the bundled companion server +
 * open the standalone web frontend in the browser, closing the loop so the
 * extension ships the web app.
 *
 * Flow:
 *   1. Resolve the served repo (the primary GitSight repo).
 *   2. Reuse a running companion if we already started one this session;
 *      otherwise spawn `node web/server/index.mjs --repo <repo> --port N`
 *      (the entry that imports the SHARED builders with no build step).
 *   3. Wait for the ready banner (or an EADDRINUSE -> retry the next port).
 *   4. Open http://127.0.0.1:<port> via vscode.env.openExternal, and keep
 *      the process alive until VS Code disposes the extension.
 *
 * The pure port/argv/URL/banner logic lives in src/git/webApp.ts (tested);
 * this module owns the spawn + lifecycle side effects.
 *
 * Configurable via:
 *   gitsight.web.port   preferred port (default 5274)
 *   gitsight.web.root   scan root for the in-app repo switcher (optional)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { Git } from '../git/git';
import {
  normalizePort,
  buildServerArgs,
  webUrl,
  isPortInUseError,
  parseReadyBanner,
  nextPort,
  DEFAULT_WEB_PORT,
  PORT_SCAN_RANGE,
} from '../git/webApp';

interface RunningServer {
  proc: ChildProcess;
  port: number;
  repo: string;
}

/** The single companion process we manage for this VS Code session. */
let running: RunningServer | null = null;

/** Dispose hook so the process is killed when the extension deactivates. */
export function registerWebAppLifecycle(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push({
    dispose() {
      stopWebApp();
    },
  });
}

/** Kill the managed companion (extension deactivate / explicit stop). */
export function stopWebApp(): void {
  if (running) {
    try {
      running.proc.kill();
    } catch {
      /* already gone */
    }
    running = null;
  }
}

export async function openWebApp(ctx: vscode.ExtensionContext, git: Git): Promise<void> {
  const serverEntry = path.join(ctx.extensionPath, 'web', 'server', 'index.mjs');
  if (!fs.existsSync(serverEntry)) {
    vscode.window.showErrorMessage(
      'GitSight: the bundled web companion is missing (web/server/index.mjs). Reinstall the extension or run a full build.',
    );
    return;
  }

  const repo = git.cwd;

  // Reuse a healthy companion already serving this repo.
  if (running && running.repo === repo && running.proc.exitCode === null) {
    await vscode.env.openExternal(vscode.Uri.parse(webUrl(running.port)));
    vscode.window.setStatusBarMessage(`GitSight web running on ${webUrl(running.port)}`, 4000);
    return;
  }
  // A stale process (different repo / exited) — replace it.
  stopWebApp();

  const cfg = vscode.workspace.getConfiguration('gitsight.web');
  const preferredPort = normalizePort(cfg.get('port', DEFAULT_WEB_PORT), DEFAULT_WEB_PORT);
  const root = cfg.get<string>('root', '').trim() || undefined;
  const allowMutations = cfg.get<boolean>('allowMutations', false) === true;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitSight: starting web app…' },
    () => launchServer({ serverEntry, repo, preferredPort, root, allowMutations }),
  );

  if (!result.ok) {
    vscode.window.showErrorMessage(`GitSight: could not start the web app — ${result.error}`);
    return;
  }

  running = { proc: result.proc, port: result.port, repo };
  // If the process dies later, forget it so the next launch respawns.
  result.proc.on('exit', () => {
    if (running && running.proc === result.proc) running = null;
  });

  await vscode.env.openExternal(vscode.Uri.parse(webUrl(result.port)));
  const choice = await vscode.window.showInformationMessage(
    `GitSight web app is live at ${webUrl(result.port)}`,
    'Copy URL',
    'Stop server',
  );
  if (choice === 'Copy URL') {
    await vscode.env.clipboard.writeText(webUrl(result.port));
    vscode.window.setStatusBarMessage('GitSight web URL copied', 3000);
  } else if (choice === 'Stop server') {
    stopWebApp();
    vscode.window.setStatusBarMessage('GitSight web server stopped', 3000);
  }
}

type LaunchResult =
  | { ok: true; proc: ChildProcess; port: number }
  | { ok: false; error: string };

/**
 * Spawn the companion, waiting for its ready banner. On EADDRINUSE we kill
 * the attempt and retry the next port, up to PORT_SCAN_RANGE tries, so a
 * stale dev server doesn't block the launch.
 */
async function launchServer(opts: {
  serverEntry: string;
  repo: string;
  preferredPort: number;
  root?: string;
  allowMutations?: boolean;
}): Promise<LaunchResult> {
  let port = opts.preferredPort;
  for (let attempt = 0; attempt < PORT_SCAN_RANGE; attempt++) {
    const args = buildServerArgs({ serverEntry: opts.serverEntry, repo: opts.repo, port, root: opts.root, allowMutations: opts.allowMutations });
    const attemptResult = await tryPort(args, port);
    if (attemptResult.ok) return attemptResult;
    if (!attemptResult.retry) return { ok: false, error: attemptResult.error };
    port = nextPort(port, opts.preferredPort);
  }
  return { ok: false, error: `no free port found in range ${opts.preferredPort}-${opts.preferredPort + PORT_SCAN_RANGE}` };
}

type TryResult =
  | { ok: true; proc: ChildProcess; port: number }
  | { ok: false; retry: boolean; error: string };

/** Spawn one attempt on a specific port and resolve when it binds or fails. */
function tryPort(args: string[], port: number): Promise<TryResult> {
  return new Promise<TryResult>(resolve => {
    let settled = false;
    const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    const finish = (r: TryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      // No banner in time — assume bound but quiet, accept it.
      finish({ ok: true, proc, port });
    }, 4000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const bound = parseReadyBanner(text);
      if (bound !== null) finish({ ok: true, proc, port: bound });
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (isPortInUseError(text)) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        finish({ ok: false, retry: true, error: `port ${port} in use` });
      }
    });

    proc.on('error', err => {
      finish({ ok: false, retry: false, error: err.message });
    });

    proc.on('exit', code => {
      // Exited before a banner without an EADDRINUSE we caught — fail hard.
      if (!settled) finish({ ok: false, retry: false, error: `server exited with code ${code}` });
    });
  });
}
