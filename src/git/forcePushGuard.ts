/**
 * Pure helpers for the Force-Push Protection Guard (F71).
 *
 * GitHub's branch protection API returns a JSON blob describing the
 * protection rules for a branch:
 *
 *   gh api repos/:owner/:repo/branches/:branch/protection
 *
 * On a protected branch the response looks like:
 *
 *   {
 *     "enforce_admins": { "enabled": true },
 *     "allow_force_pushes": { "enabled": false },
 *     "allow_deletions": { "enabled": false },
 *     "required_pull_request_reviews": { ... },
 *     "required_status_checks": { ... },
 *     ...
 *   }
 *
 * On an unprotected branch `gh` exits with 404 and stderr containing
 * "Branch not protected" — we treat both the JSON-with-protections shape
 * and the 404-shape distinctly.
 *
 * The classifier returns a decision the view layer can act on without
 * further parsing:
 *
 *   - unprotected → push allowed (no warning).
 *   - protected, force allowed → push allowed (no warning, GitHub will
 *     accept it).
 *   - protected, force disallowed → REFUSE (push will fail at GitHub;
 *     stop the user from wasting the round-trip).
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/forcePushGuard.test.ts.
 */

export type ProtectionDecision =
  | { kind: 'unprotected' }
  | { kind: 'protected'; allowsForcePush: boolean; rules: ProtectionRule[] }
  | { kind: 'unknown'; reason: string };

/** A single protection clause we report back to the user. */
export interface ProtectionRule {
  /** Stable id for the rule (used in the warning detail). */
  id:
    | 'enforce-admins'
    | 'force-push'
    | 'deletions'
    | 'required-reviews'
    | 'required-status-checks'
    | 'required-signatures'
    | 'required-linear-history'
    | 'lock-branch';
  /** True when the rule is actively enabled. */
  enabled: boolean;
  /** Short human-readable label for the warning detail. */
  label: string;
}

/**
 * Classify a gh-api response body + exit context into a decision.
 *
 * `body` is the stdout from `gh api ...` (a JSON string, or '' on
 * failure). `stderr` is the corresponding stderr. `exitCode` is the
 * process exit code; non-zero with stderr matching `Branch not protected`
 * means unprotected.
 *
 * Returns 'unknown' when we can't tell — caller should treat it as
 * "warn the user, but let them proceed" (cheaper than blocking an
 * intended force-push on a glitchy network).
 */
export function classifyProtection(
  body: string,
  stderr: string,
  exitCode: number,
): ProtectionDecision {
  if (exitCode !== 0) {
    if (/branch\s+not\s+protected/i.test(stderr)) return { kind: 'unprotected' };
    if (/HTTP\s+404/i.test(stderr) || /\b404\b/.test(stderr)) {
      // Most likely unprotected; fall through to unknown if the message
      // wasn't the canonical "Branch not protected" so we don't swallow
      // a legit auth error.
      if (/branch/i.test(stderr) || /protection/i.test(stderr)) return { kind: 'unprotected' };
    }
    return { kind: 'unknown', reason: classifyStderr(stderr) };
  }
  if (!body || !body.trim()) return { kind: 'unprotected' };
  let json: any;
  try { json = JSON.parse(body); }
  catch { return { kind: 'unknown', reason: 'protection response was not valid JSON' }; }

  const rules: ProtectionRule[] = [];
  const get = (path: string[]): any => path.reduce((acc, k) => (acc == null ? acc : acc[k]), json);

  pushIfEnabled(rules, 'enforce-admins', get(['enforce_admins', 'enabled']), 'Admin enforcement enabled');
  // Treat missing `allow_force_pushes` as forced-off (GitHub's default).
  const forcePushEnabled = !!get(['allow_force_pushes', 'enabled']);
  rules.push({ id: 'force-push', enabled: forcePushEnabled, label: forcePushEnabled ? 'Force-push allowed' : 'Force-push disallowed' });
  pushIfEnabled(rules, 'deletions', get(['allow_deletions', 'enabled']), 'Branch deletions allowed');
  pushIfEnabled(rules, 'required-reviews', get(['required_pull_request_reviews']) != null, 'PR review required');
  pushIfEnabled(rules, 'required-status-checks', get(['required_status_checks']) != null, 'Required status checks');
  pushIfEnabled(rules, 'required-signatures', get(['required_signatures', 'enabled']), 'Signed commits required');
  pushIfEnabled(rules, 'required-linear-history', get(['required_linear_history', 'enabled']), 'Linear history required');
  pushIfEnabled(rules, 'lock-branch', get(['lock_branch', 'enabled']), 'Branch locked');

  return { kind: 'protected', allowsForcePush: forcePushEnabled, rules };
}

function pushIfEnabled(rules: ProtectionRule[], id: ProtectionRule['id'], enabled: any, label: string) {
  if (enabled) rules.push({ id, enabled: true, label });
}

function classifyStderr(stderr: string): string {
  if (!stderr) return 'gh exited non-zero with no stderr';
  const first = stderr.split('\n').find(l => l.trim());
  if (!first) return 'gh exited non-zero';
  if (/not\s+authenticated/i.test(stderr) || /gh\s+auth\s+login/i.test(stderr)) {
    return 'gh CLI is not authenticated (run `gh auth login`)';
  }
  if (/no\s+matching\s+remote/i.test(stderr) || /no\s+remote\s+repository/i.test(stderr)) {
    return 'origin is not a GitHub repository';
  }
  return first.trim().slice(0, 240);
}

/**
 * Headline used by the modal/toast in the view. Stable shape so the
 * tests can assert on it without coupling to UI strings.
 */
export function describeDecision(d: ProtectionDecision, branch: string): string {
  if (d.kind === 'unprotected') return `Branch \`${branch}\` is not protected.`;
  if (d.kind === 'unknown')     return `Could not check protection for \`${branch}\`: ${d.reason}.`;
  return d.allowsForcePush
    ? `Branch \`${branch}\` is protected but allows force-push.`
    : `Branch \`${branch}\` is protected and does NOT allow force-push.`;
}

/**
 * Parse an `origin` remote URL into owner/repo. Returns undefined for
 * non-GitHub remotes. Mirrors the same heuristic used by
 * defaultReviewers and openLastPushedBranch.
 */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | undefined {
  if (!remoteUrl) return undefined;
  // git@github.com:owner/repo(.git)?
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // https://github.com/owner/repo(.git)?
  const https = /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[/?#]|$)/.exec(remoteUrl.trim());
  if (https) return { owner: https[1], repo: https[2] };
  // ssh://git@github.com[:port]/owner/repo(.git)?
  const sshUri = /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (sshUri) return { owner: sshUri[1], repo: sshUri[2] };
  return undefined;
}
