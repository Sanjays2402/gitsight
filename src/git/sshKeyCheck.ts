/**
 * Pure helpers for the SSH Key Sanity Check (F54).
 *
 * When a push (or fetch/pull) fails with one of the well-known git
 * remote-auth errors, this module classifies the stderr so the view layer
 * can surface a one-click recovery path:
 *
 *   - Permission denied (publickey)            -> no key offered, or wrong key
 *   - Host key verification failed             -> known_hosts mismatch
 *   - Repository not found                     -> GitHub returns this when
 *                                                 the key auth succeeds but
 *                                                 the user has no read access
 *   - Could not read from remote               -> SSH connection died
 *   - fatal: could not read Username           -> HTTPS interactive prompt
 *                                                 (we have no TTY in VS Code)
 *
 * Pure — no vscode, no child_process. Tests in test/git/sshKeyCheck.test.ts.
 */

export type AuthFailureKind =
  | 'permission-denied'
  | 'host-key-verification'
  | 'repo-not-found-via-ssh'
  | 'connection-closed'
  | 'https-credential-prompt'
  | 'unknown';

export interface AuthFailure {
  kind: AuthFailureKind;
  /**
   * The matched line that proved the classification — useful for the view to
   * quote in the error toast so the user can verify our reading of git's
   * complaint.
   */
  evidence: string;
  /** Transport guess, derived from URL shape when supplied or the message. */
  transport: 'ssh' | 'https' | 'unknown';
  /** Host extracted from URL or the stderr (best effort). */
  host?: string;
}

const PATTERNS: Array<{ kind: AuthFailureKind; re: RegExp; transport?: 'ssh' | 'https' }> = [
  // SSH: explicit "no key" rejection from the server.
  { kind: 'permission-denied', re: /Permission denied \(publickey\)/i, transport: 'ssh' },
  // SSH: server changed its host key (or first contact).
  { kind: 'host-key-verification', re: /Host key verification failed/i, transport: 'ssh' },
  // GitHub's reply when the SSH key authenticates as a user with no access
  // to the requested repo (rather than "permission denied", which means the
  // key never even matched a user). Check this BEFORE the connection-closed
  // pattern because the standard GitHub response also includes
  // "Could not read from remote repository" as a trailing line.
  { kind: 'repo-not-found-via-ssh', re: /(?:fatal: )?(?:ERROR: )?Repository not found\.?/i, transport: 'ssh' },
  // SSH: connection death (often kex algorithm mismatch, firewall, sleep).
  { kind: 'connection-closed', re: /(?:Connection (?:reset|closed|refused)|Could not read from remote repository|kex_exchange_identification|connection unexpectedly closed)/i, transport: 'ssh' },
  // HTTPS: we have no TTY here, so a credential prompt is a hard fail.
  { kind: 'https-credential-prompt', re: /could not read (?:Username|Password) for/i, transport: 'https' },
  // HTTPS auth failures (bad/expired PAT).
  { kind: 'permission-denied', re: /(?:fatal: )?Authentication failed for/i, transport: 'https' },
  // HTTPS 401/403 from a remote helper.
  { kind: 'permission-denied', re: /(?:fatal: )?HTTP (?:401|403)|The requested URL returned error: 40[13]/i, transport: 'https' },
];

/**
 * Classify a stderr blob (typically from `git push` / `git fetch`). Returns
 * undefined when none of the known auth signatures match — the caller
 * should leave such errors alone (not every push failure is an auth
 * problem).
 */
export function classifyAuthFailure(stderr: string, url?: string): AuthFailure | undefined {
  const blob = (stderr ?? '').trim();
  if (!blob) return undefined;
  const transportFromUrl = guessTransportFromUrl(url);
  for (const p of PATTERNS) {
    const m = p.re.exec(blob);
    if (!m) continue;
    return {
      kind: p.kind,
      evidence: extractEvidenceLine(blob, m.index),
      transport: transportFromUrl ?? p.transport ?? 'unknown',
      host: extractHost(url, blob),
    };
  }
  return undefined;
}

/**
 * Map an AuthFailure to a short, plainspoken summary. Suitable for the
 * `detail:` field of a modal warning.
 */
export function summariseFailure(f: AuthFailure): string {
  switch (f.kind) {
    case 'permission-denied':
      return f.transport === 'https'
        ? 'Authentication failed. Your token may be expired or lack repo scope.'
        : 'The server rejected your SSH key. Either no key was offered, or the key isn\u2019t registered for this account.';
    case 'host-key-verification':
      return `Host key verification failed${f.host ? ` for ${f.host}` : ''}. The server\u2019s host key changed (or this is the first connection).`;
    case 'repo-not-found-via-ssh':
      return 'SSH authenticated but the repository isn\u2019t visible to this account. The key may belong to a different user, or you need to be added as a collaborator.';
    case 'connection-closed':
      return 'SSH connection died before completing. Often caused by a sleep/wifi flap, corporate proxy, or stale ssh-agent.';
    case 'https-credential-prompt':
      return 'Git is asking for credentials interactively, but VS Code has no terminal to type them in. Configure a credential helper or switch to gh CLI auth.';
    case 'unknown':
      return 'Unrecognised auth failure.';
  }
}

/**
 * Map an AuthFailure to a list of actionable suggestions. The view turns
 * each into a button (or a quickpick row when there are more than 3).
 */
export function suggestActions(f: AuthFailure): RecoveryAction[] {
  switch (f.kind) {
    case 'permission-denied':
      return f.transport === 'https'
        ? [
            { id: 'use-gh-cli', label: 'Configure gh CLI as the credential helper' },
            { id: 'copy-gh-login', label: 'Copy: gh auth login --git-protocol https' },
            { id: 'open-pat-page', label: 'Open: GitHub personal access tokens' },
          ]
        : [
            { id: 'open-ssh-config', label: 'Open ~/.ssh/config' },
            { id: 'copy-keygen', label: 'Copy: ssh-keygen -t ed25519 -C "me@example.com"' },
            { id: 'copy-add-key', label: 'Copy: gh ssh-key add ~/.ssh/id_ed25519.pub' },
            { id: 'open-gh-keys', label: 'Open: GitHub SSH keys settings' },
          ];
    case 'host-key-verification':
      return [
        { id: 'copy-ssh-keyscan', label: f.host
            ? `Copy: ssh-keyscan -t ed25519 ${f.host} >> ~/.ssh/known_hosts`
            : 'Copy: ssh-keyscan -t ed25519 <host> >> ~/.ssh/known_hosts' },
        { id: 'open-known-hosts', label: 'Open ~/.ssh/known_hosts' },
        { id: 'open-ssh-debug', label: 'Open SSH debug command (ssh -vT)' },
      ];
    case 'repo-not-found-via-ssh':
      return [
        { id: 'copy-ssh-test', label: f.host
            ? `Copy: ssh -T git@${f.host}`
            : 'Copy: ssh -T git@github.com' },
        { id: 'open-ssh-config', label: 'Open ~/.ssh/config' },
        { id: 'gh-status', label: 'Run: gh auth status' },
      ];
    case 'connection-closed':
      return [
        { id: 'copy-ssh-test', label: f.host
            ? `Copy: ssh -vT git@${f.host}`
            : 'Copy: ssh -vT git@github.com' },
        { id: 'ssh-add-check', label: 'Run: ssh-add -l (check ssh-agent)' },
      ];
    case 'https-credential-prompt':
      return [
        { id: 'use-gh-cli', label: 'Configure gh CLI as the credential helper' },
        { id: 'copy-gh-login', label: 'Copy: gh auth login --git-protocol https' },
      ];
    case 'unknown':
      return [];
  }
}

export interface RecoveryAction {
  id:
    | 'open-ssh-config'
    | 'copy-keygen'
    | 'copy-add-key'
    | 'open-gh-keys'
    | 'copy-ssh-keyscan'
    | 'open-known-hosts'
    | 'open-ssh-debug'
    | 'copy-ssh-test'
    | 'gh-status'
    | 'ssh-add-check'
    | 'use-gh-cli'
    | 'copy-gh-login'
    | 'open-pat-page';
  label: string;
}

function guessTransportFromUrl(url: string | undefined): 'ssh' | 'https' | undefined {
  if (!url) return undefined;
  if (/^(?:ssh:\/\/|git@)/i.test(url)) return 'ssh';
  if (/^https?:\/\//i.test(url)) return 'https';
  return undefined;
}

function extractHost(url: string | undefined, blob: string): string | undefined {
  // SCP-style "git@github.com:user/repo.git"
  if (url) {
    const scp = /^[^@]+@([^:]+):/.exec(url);
    if (scp) return scp[1].toLowerCase();
    const proto = /^(?:ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)/.exec(url);
    if (proto) return proto[1].toLowerCase();
  }
  const fromStderr = /(?:host key for|connection to|connecting to|@)([a-z0-9.-]+\.(?:com|org|net|io|dev|app|so|me|co))/i.exec(blob);
  if (fromStderr) return fromStderr[1].toLowerCase();
  return undefined;
}

function extractEvidenceLine(blob: string, idx: number): string {
  const before = blob.lastIndexOf('\n', idx) + 1;
  const after = blob.indexOf('\n', idx);
  return blob.slice(before, after === -1 ? undefined : after).trim();
}

/**
 * Resolve a recovery action id to a concrete payload — either a URL to
 * open or text to copy. Lets the view layer remain dumb (just dispatch the
 * action). Returns undefined for ids that need file-system access (those
 * are handled directly by the view).
 */
export function actionPayload(id: RecoveryAction['id'], host?: string): { kind: 'open' | 'copy'; value: string } | undefined {
  const h = host ?? 'github.com';
  switch (id) {
    case 'copy-keygen':
      return { kind: 'copy', value: 'ssh-keygen -t ed25519 -C "me@example.com"' };
    case 'copy-add-key':
      return { kind: 'copy', value: 'gh ssh-key add ~/.ssh/id_ed25519.pub' };
    case 'open-gh-keys':
      return { kind: 'open', value: h.includes('github.com') ? 'https://github.com/settings/keys' : `https://${h}` };
    case 'open-pat-page':
      return { kind: 'open', value: h.includes('github.com') ? 'https://github.com/settings/tokens' : `https://${h}` };
    case 'copy-ssh-keyscan':
      return { kind: 'copy', value: `ssh-keyscan -t ed25519 ${h} >> ~/.ssh/known_hosts` };
    case 'copy-ssh-test':
      return { kind: 'copy', value: `ssh -vT git@${h}` };
    case 'gh-status':
      return { kind: 'copy', value: 'gh auth status' };
    case 'ssh-add-check':
      return { kind: 'copy', value: 'ssh-add -l' };
    case 'use-gh-cli':
      return { kind: 'copy', value: 'gh auth setup-git' };
    case 'copy-gh-login':
      return { kind: 'copy', value: 'gh auth login --git-protocol https' };
    case 'open-ssh-debug':
      return { kind: 'copy', value: `ssh -vT git@${h}` };
    case 'open-ssh-config':
    case 'open-known-hosts':
      // These need the view to expand "~" and open a file URI — handled
      // outside the pure helper.
      return undefined;
  }
}
