/**
 * GitSight shared remote-URL logic (W28).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. The canonical parser that
 * turns a git remote URL into a host + web base + a per-commit web URL,
 * supporting GitHub, Azure DevOps (new + legacy), GitLab, and Bitbucket.
 *
 * This is the EXTRACTED core of the extension's `src/git/hostDetect.ts`
 * (which now re-exports from here, the graphPalette/graphExport pattern) so
 * the standalone web app can build an "Open on remote" link for a commit
 * without forking host detection or depending on the extension tree. The
 * companion server attaches the origin remote URL to each snapshot; the web
 * app passes it through `commitWebUrl` here.
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/remoteUrl.test.ts
 */

export type GitHost = 'github' | 'azure-devops' | 'gitlab' | 'bitbucket' | 'unknown';

export interface HostInfo {
  host: GitHost;
  /** Hostname (dev.azure.com, github.com, ...). */
  hostname: string;
  /** Web base URL for the repo. */
  webBase: string;
  /** For GH: owner. For ADO: organization. */
  owner: string;
  /** For ADO only: project name. Undefined for GH. */
  project?: string;
  /** Repo name. */
  repo: string;
}

/**
 * Parse any remote URL into normalized parts. Supports:
 *   GitHub:  git@github.com:owner/repo.git   https://github.com/owner/repo(.git)
 *   ADO new: git@ssh.dev.azure.com:v3/org/project/repo
 *            https://dev.azure.com/org/project/_git/repo
 *   ADO old: https://org.visualstudio.com/project/_git/repo
 *   GitLab:  git@gitlab.com:group/sub/repo.git   https://gitlab.com/group/sub/repo
 *   Bitbucket: git@bitbucket.org:owner/repo.git   https://bitbucket.org/owner/repo
 */
export function parseRemote(remoteUrl: string): HostInfo | undefined {
  if (!remoteUrl) return undefined;
  const url = remoteUrl.trim();

  // Azure DevOps (new dev.azure.com).
  let m = /^(?:https?:\/\/(?:[^@]+@)?dev\.azure\.com|git@ssh\.dev\.azure\.com:v3)\/([^/]+)\/([^/]+)\/(?:_git\/)?([^/.]+?)(?:\.git)?$/.exec(url);
  if (m) {
    const [, org, project, repo] = m;
    return {
      host: 'azure-devops',
      hostname: 'dev.azure.com',
      webBase: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
      owner: org,
      project,
      repo,
    };
  }
  // Azure DevOps (legacy *.visualstudio.com).
  m = /^(?:https?:\/\/([^.]+)\.visualstudio\.com|[^@]+@vs-ssh\.visualstudio\.com:v3\/([^/]+))\/([^/]+)\/(?:_git\/)?([^/.]+?)(?:\.git)?$/.exec(url);
  if (m) {
    const org = m[1] || m[2];
    const project = m[3];
    const repo = m[4];
    return {
      host: 'azure-devops',
      hostname: `${org}.visualstudio.com`,
      webBase: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
      owner: org,
      project,
      repo,
    };
  }

  // SSH form: git@host:path
  m = /^[^@\s]+@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  let hostname: string;
  let fullPath: string;
  if (m) {
    hostname = m[1];
    fullPath = m[2];
  } else {
    // HTTPS form.
    m = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (!m) return undefined;
    hostname = m[1];
    fullPath = m[2];
  }

  const segments = fullPath.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const repo = segments[segments.length - 1].replace(/\.git$/, '');
  const owner = segments.slice(0, -1).join('/');

  const lower = hostname.toLowerCase();
  let host: GitHost = 'unknown';
  if (lower.includes('github')) host = 'github';
  else if (lower.includes('gitlab')) host = 'gitlab';
  else if (lower.includes('bitbucket')) host = 'bitbucket';

  return {
    host,
    hostname,
    webBase: `https://${hostname}/${owner}/${repo}`,
    owner,
    repo,
  };
}

/** Translate origin URL -> web URL for a commit (or just the repo). */
export function remoteWebUrl(remoteUrl: string, sha?: string): string | undefined {
  const info = parseRemote(remoteUrl);
  if (!info) return undefined;
  if (!sha) return info.webBase;
  switch (info.host) {
    case 'bitbucket':
      return `${info.webBase}/commits/${sha}`;
    case 'azure-devops':
    case 'gitlab':
    case 'github':
    default:
      return `${info.webBase}/commit/${sha}`;
  }
}

/** PR / MR / Pull Request web URL for a given number. */
export function pullRequestWebUrl(info: HostInfo, number: number): string {
  switch (info.host) {
    case 'azure-devops':
      return `${info.webBase}/pullrequest/${number}`;
    case 'gitlab':
      return `${info.webBase}/-/merge_requests/${number}`;
    case 'bitbucket':
      return `${info.webBase}/pull-requests/${number}`;
    case 'github':
    default:
      return `${info.webBase}/pull/${number}`;
  }
}

/**
 * Human label for a host, for tooltips/menus ("Open on GitHub"). Returns
 * 'remote' for an unknown host so the web "Open on remote" action still
 * reads naturally.
 */
export function hostLabel(host: GitHost): string {
  switch (host) {
    case 'github':
      return 'GitHub';
    case 'azure-devops':
      return 'Azure DevOps';
    case 'gitlab':
      return 'GitLab';
    case 'bitbucket':
      return 'Bitbucket';
    default:
      return 'remote';
  }
}

/**
 * Convenience for the web app (W28): given a snapshot's origin remote URL
 * (or undefined when there is no origin) and a commit sha, return the
 * commit's web URL + a host label, or null when the remote can't be mapped.
 */
export interface CommitWebTarget {
  url: string;
  host: GitHost;
  label: string;
}

export function commitWebUrl(remoteUrl: string | undefined, sha: string): CommitWebTarget | null {
  if (!remoteUrl || !sha) return null;
  const info = parseRemote(remoteUrl);
  if (!info) return null;
  const url = remoteWebUrl(remoteUrl, sha);
  if (!url) return null;
  return { url, host: info.host, label: hostLabel(info.host) };
}
