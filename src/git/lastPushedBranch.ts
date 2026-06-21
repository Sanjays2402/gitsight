/**
 * Pure helpers for the "Open Last Pushed Branch" command (F38).
 *
 * Mining strategy: scan `git reflog --date=iso-strict --all` (or just the
 * branch reflogs) for entries whose subject begins with `update by push`
 * (the literal phrase git writes when it advances a ref via push) and
 * return the most recent branch + timestamp. Falls back to the most
 * recently checked-out branch (recentBranches MRU) when no push event is
 * visible in the local reflog — useful right after a fresh clone.
 *
 * URL building is host-aware. Three GitHub-flavoured shapes are useful:
 *
 *   GitHub      → https://github.com/<repo>/tree/<branch>
 *   GitLab      → https://gitlab.com/<repo>/-/tree/<branch>
 *   Bitbucket   → https://bitbucket.org/<repo>/branch/<branch>
 *   Azure DevOps→ https://dev.azure.com/<org>/<proj>/_git/<repo>?version=GB<branch>
 *
 * Pure — no vscode, no child_process. Tests in test/git/lastPushedBranch.test.ts.
 */

export interface LastPushedBranch {
  branch: string;
  /** ISO 8601 timestamp of the push event. */
  dateIso: string;
}

/**
 * Parse stdout from:
 *
 *   git reflog --date=iso-strict --pretty=format:'%gD %gs' --all
 *
 * Each reflog entry looks like:
 *
 *   refs/heads/main@{2026-06-20T12:30:45-07:00} update by push
 *   HEAD@{2026-06-20T12:30:45-07:00} update by push
 *
 * We want the destination ref (refs/heads/<branch>) for the most recent
 * "update by push" subject, mapped to its branch name. Lines whose ref
 * doesn't start with refs/heads/ are ignored (push events on HEAD aren't
 * useful when picking a branch URL).
 *
 * The reflog stream is newest-first, so we return on the first hit.
 */
export function parsePushReflog(raw: string): LastPushedBranch | undefined {
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const m = REFLOG_RE.exec(line);
    if (!m) continue;
    const ref = m[1];
    const iso = m[2];
    const subject = m[3];
    if (!subject.startsWith('update by push')) continue;
    if (!ref.startsWith('refs/heads/')) continue;
    return { branch: ref.slice('refs/heads/'.length), dateIso: iso };
  }
  return undefined;
}

const REFLOG_RE = /^(\S+)@\{([^}]+)\}\s+(.*)$/;

export type Host = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'unknown';

/**
 * Detect host from the `remoteWebUrl()` base. Kept here so the URL builder
 * is fully unit-testable without dragging the existing host detect helper
 * into tsconfig.test.json. Matches the same substring heuristics as the
 * rest of GitSight ("github.com", "gitlab", "bitbucket.org", "dev.azure.com"
 * or "/_git/" inside the path).
 */
export function detectHost(baseUrl: string): Host {
  if (!baseUrl) return 'unknown';
  if (baseUrl.includes('github.com')) return 'github';
  if (baseUrl.includes('gitlab')) return 'gitlab';
  if (baseUrl.includes('bitbucket.org')) return 'bitbucket';
  if (baseUrl.includes('dev.azure.com') || baseUrl.includes('/_git/')) return 'azure-devops';
  return 'unknown';
}

/**
 * Build the canonical "view this branch on the web" URL.
 *
 * `baseUrl` is the output of `remoteWebUrl(origin.fetchUrl)` (no SHA, no
 * trailing slash). The branch name is URI-encoded; slashes inside the
 * branch (`release/1.x`) are preserved by `encodeURI` so the resulting
 * path matches what GitHub etc. actually serve.
 *
 * Returns undefined for unknown hosts so callers can fall back to a copy
 * action instead of opening a wrong URL.
 */
export function branchTreeUrl(baseUrl: string, branch: string): string | undefined {
  const host = detectHost(baseUrl);
  const enc = encodeURI(branch);
  switch (host) {
    case 'github':       return `${baseUrl}/tree/${enc}`;
    case 'gitlab':       return `${baseUrl}/-/tree/${enc}`;
    case 'bitbucket':    return `${baseUrl}/branch/${enc}`;
    case 'azure-devops': return `${baseUrl}?version=GB${enc}`;
    default:             return undefined;
  }
}

/**
 * Build a compare URL for the branch vs the default base (typically `main`
 * or `master`). Useful when the user wants to open a PR-ready diff in the
 * browser rather than a raw tree view.
 */
export function compareUrl(baseUrl: string, base: string, head: string): string | undefined {
  const host = detectHost(baseUrl);
  const eBase = encodeURIComponent(base);
  const eHead = encodeURIComponent(head);
  switch (host) {
    case 'github':       return `${baseUrl}/compare/${eBase}...${eHead}`;
    case 'gitlab':       return `${baseUrl}/-/compare/${eBase}...${eHead}`;
    case 'bitbucket':    return `${baseUrl}/branches/compare/${eHead}..${eBase}`;
    case 'azure-devops': return `${baseUrl}/pullrequestcreate?sourceRef=${eHead}&targetRef=${eBase}`;
    default:             return undefined;
  }
}

/**
 * Build the canonical "new PR / MR" URL prefilled with the branch as the
 * source. Each host has a slightly different convention; we encode the
 * branch but leave the base unset so the host's UI picks the repo default.
 */
export function newPullRequestUrl(baseUrl: string, head: string): string | undefined {
  const host = detectHost(baseUrl);
  const eHead = encodeURIComponent(head);
  switch (host) {
    case 'github':       return `${baseUrl}/pull/new/${eHead}`;
    case 'gitlab':       return `${baseUrl}/-/merge_requests/new?merge_request[source_branch]=${eHead}`;
    case 'bitbucket':    return `${baseUrl}/pull-requests/new?source=${eHead}`;
    case 'azure-devops': return `${baseUrl}/pullrequestcreate?sourceRef=${eHead}`;
    default:             return undefined;
  }
}
