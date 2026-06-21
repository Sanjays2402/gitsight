/**
 * SSH Key Sanity Check (F54) — when `gitsight.push` (or fetch/pull) fails
 * with a recognisable auth error, surface a friendly recovery picker.
 *
 * Without this, the user gets the raw stderr buried in a tiny VS Code
 * toast and has to remember `ssh-keygen -t ed25519 …` from memory. The
 * picker maps each well-known failure to a small menu of one-click
 * actions (open ~/.ssh/config, copy the keygen line, open GitHub's SSH
 * keys page, etc).
 *
 * Configurable via:
 *   gitsight.sshKeyCheck.enabled        (default true) — turn off to get
 *                                                         raw errors back
 *   gitsight.sshKeyCheck.autoCheckOnActivate (default false) — at startup,
 *                                                         silently run
 *                                                         `git ls-remote
 *                                                         --heads origin`
 *                                                         and surface
 *                                                         the prompt early
 *                                                         (catches stale
 *                                                         keys before the
 *                                                         user tries to
 *                                                         push)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import {
  classifyAuthFailure,
  summariseFailure,
  suggestActions,
  actionPayload,
  AuthFailure,
  RecoveryAction,
} from '../git/sshKeyCheck';

/**
 * Wrap a git network operation. If it fails with an auth error, surface
 * the recovery picker and (always) re-throw the original error so callers
 * stay in their existing failure path.
 */
export async function withAuthSanityCheck<T>(
  git: Git,
  remoteName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const cfg = vscode.workspace.getConfiguration('gitsight.sshKeyCheck');
  const enabled = cfg.get<boolean>('enabled', true);
  try {
    return await fn();
  } catch (e: any) {
    if (!enabled) throw e;
    const stderr = (e?.stderr || e?.message || '').toString();
    const remoteUrl = await safeRemoteUrl(git, remoteName);
    const failure = classifyAuthFailure(stderr, remoteUrl);
    if (!failure) throw e;
    // Show the picker but don't block the throw — the user wanted to push,
    // we still owe them the error.
    void surfaceAuthRecovery(failure);
    throw e;
  }
}

export async function surfaceAuthRecovery(failure: AuthFailure): Promise<void> {
  const summary = summariseFailure(failure);
  const actions = suggestActions(failure);
  if (!actions.length) {
    vscode.window.showErrorMessage(`GitSight: ${summary}`);
    return;
  }
  type Pk = vscode.QuickPickItem & { _id: RecoveryAction['id'] };
  const items: Pk[] = actions.map(a => ({
    label: a.label,
    description: actionDescription(a.id),
    _id: a.id,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `GitSight: ${headlineFor(failure.kind)} — pick a recovery step`,
    matchOnDescription: true,
  });
  if (!picked) return;
  await dispatchAction(picked._id, failure);
}

async function dispatchAction(id: RecoveryAction['id'], failure: AuthFailure): Promise<void> {
  // ~ expansion is the view's job (the pure helper stays vscode-free).
  if (id === 'open-ssh-config') return openConfigFile('~/.ssh/config', { createIfMissing: true });
  if (id === 'open-known-hosts') return openConfigFile('~/.ssh/known_hosts', { createIfMissing: false });

  const payload = actionPayload(id, failure.host);
  if (!payload) {
    vscode.window.showWarningMessage(`GitSight: no action wired for ${id}`);
    return;
  }
  if (payload.kind === 'open') {
    await vscode.env.openExternal(vscode.Uri.parse(payload.value));
    return;
  }
  // copy
  await vscode.env.clipboard.writeText(payload.value);
  vscode.window.setStatusBarMessage(`GitSight: copied — ${truncate(payload.value, 60)}`, 4000);
}

async function openConfigFile(p: string, opts: { createIfMissing: boolean }) {
  const resolved = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  try {
    await fs.access(resolved);
  } catch {
    if (!opts.createIfMissing) {
      vscode.window.showWarningMessage(`GitSight: ${resolved} doesn't exist yet.`);
      return;
    }
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      await fs.writeFile(resolved, '# Created by GitSight\n', { mode: 0o600 });
    } catch (e: any) {
      vscode.window.showErrorMessage(`GitSight: couldn't create ${resolved}: ${e.message ?? e}`);
      return;
    }
  }
  const doc = await vscode.workspace.openTextDocument(resolved);
  await vscode.window.showTextDocument(doc);
}

async function safeRemoteUrl(git: Git, remoteName: string): Promise<string | undefined> {
  try {
    const out = await git.raw(['remote', 'get-url', remoteName]);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

function actionDescription(id: RecoveryAction['id']): string {
  switch (id) {
    case 'open-ssh-config':       return 'opens (and creates if missing) ~/.ssh/config';
    case 'open-known-hosts':      return 'edit known SSH host fingerprints';
    case 'open-gh-keys':          return 'browser: github.com/settings/keys';
    case 'open-pat-page':         return 'browser: github.com/settings/tokens';
    case 'copy-keygen':           return 'creates a new ed25519 key';
    case 'copy-add-key':          return 'uploads the public key via gh CLI';
    case 'copy-ssh-keyscan':      return 'add/refresh the host fingerprint';
    case 'copy-ssh-test':         return 'verifies SSH auth (verbose)';
    case 'gh-status':             return 'check gh CLI sees a token';
    case 'ssh-add-check':         return 'lists keys in ssh-agent';
    case 'use-gh-cli':            return 'gh auth setup-git';
    case 'copy-gh-login':         return 'gh CLI HTTPS login';
    case 'open-ssh-debug':        return 'verbose SSH probe';
  }
}

function headlineFor(kind: AuthFailure['kind']): string {
  switch (kind) {
    case 'permission-denied':       return 'auth denied';
    case 'host-key-verification':   return 'host key mismatch';
    case 'repo-not-found-via-ssh':  return 'repo not visible';
    case 'connection-closed':       return 'connection died';
    case 'https-credential-prompt': return 'no TTY for credentials';
    case 'unknown':                 return 'auth problem';
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '\u2026';
}

/**
 * Optional first-load probe. Runs `git ls-remote --heads origin` so the
 * user learns about stale credentials before a push or pull blows up.
 * Triggered when `gitsight.sshKeyCheck.autoCheckOnActivate` is on.
 */
export async function runStartupAuthProbe(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.sshKeyCheck');
  if (!cfg.get<boolean>('autoCheckOnActivate', false)) return;
  if (!cfg.get<boolean>('enabled', true)) return;
  try {
    await git.raw(['ls-remote', '--heads', 'origin']);
  } catch (e: any) {
    const stderr = (e?.stderr || e?.message || '').toString();
    const url = await safeRemoteUrl(git, 'origin');
    const failure = classifyAuthFailure(stderr, url);
    if (!failure) return;
    void surfaceAuthRecovery(failure);
  }
}
