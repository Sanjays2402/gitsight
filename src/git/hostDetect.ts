/**
 * Detect Git host (GitHub, Azure DevOps, GitLab, Bitbucket) from a remote URL,
 * and produce both the web URL for a commit and the canonical identifiers a
 * PR provider needs (e.g. org/project/repo for ADO, owner/repo for GH).
 */

export type GitHost = 'github' | 'azure-devops' | 'gitlab' | 'bitbucket' | 'unknown';

export interface HostInfo {
  host: GitHost;
  /** Hostname (dev.azure.com, github.com, ...) */
  hostname: string;
  /** Web base URL for the repo (https://github.com/owner/repo or https://dev.azure.com/org/project/_git/repo) */
  webBase: string;
  /** For GH: owner. For ADO: organization. */
  owner: string;
  /** For ADO only: project name. Undefined for GH. */
  project?: string;
  /** Repo name. */
  repo: string;
}

/**
 * Parse any remote URL into normalized parts.
 * Supports:
 *   GitHub:  git@github.com:owner/repo.git   https://github.com/owner/repo(.git)
 *   ADO new: git@ssh.dev.azure.com:v3/org/project/repo   https://dev.azure.com/org/project/_git/repo
 *   ADO old: https://org.visualstudio.com/project/_git/repo   org@vs-ssh.visualstudio.com:v3/org/project/repo
 *   GitLab:  git@gitlab.com:group/sub/repo.git   https://gitlab.com/group/sub/repo
 *   Bitbucket: git@bitbucket.org:owner/repo.git   https://bitbucket.org/owner/repo
 */
export function parseRemote(remoteUrl: string): HostInfo | undefined {
  if (!remoteUrl) return undefined;
  const url = remoteUrl.trim();

  // ── Azure DevOps (new dev.azure.com) ────────────────────────────
  let m = /^(?:https?:\/\/(?:[^@]+@)?dev\.azure\.com|git@ssh\.dev\.azure\.com:v3)\/([^/]+)\/([^/]+)\/(?:_git\/)?([^/.]+?)(?:\.git)?$/.exec(url);
  if (m) {
    const [, org, project, repo] = m;
    return {
      host: 'azure-devops',
      hostname: 'dev.azure.com',
      webBase: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
      owner: org, project, repo,
    };
  }
  // ── Azure DevOps (legacy *.visualstudio.com) ────────────────────
  m = /^(?:https?:\/\/([^.]+)\.visualstudio\.com|[^@]+@vs-ssh\.visualstudio\.com:v3\/([^/]+))\/([^/]+)\/(?:_git\/)?([^/.]+?)(?:\.git)?$/.exec(url);
  if (m) {
    const org = m[1] || m[2];
    const project = m[3];
    const repo = m[4];
    return {
      host: 'azure-devops',
      hostname: `${org}.visualstudio.com`,
      webBase: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
      owner: org, project, repo,
    };
  }

  // ── SSH form: git@host:path ─────────────────────────────────────
  m = /^[^@\s]+@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  let hostname: string, fullPath: string;
  if (m) {
    hostname = m[1]; fullPath = m[2];
  } else {
    // ── HTTPS form ────────────────────────────────────────────────
    m = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (!m) return undefined;
    hostname = m[1]; fullPath = m[2];
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

/** Translate origin URL → web URL for a commit (or just the repo). */
export function remoteWebUrl(remoteUrl: string, sha?: string): string | undefined {
  const info = parseRemote(remoteUrl);
  if (!info) return undefined;
  if (!sha) return info.webBase;
  switch (info.host) {
    case 'azure-devops':
      return `${info.webBase}/commit/${sha}`;
    case 'bitbucket':
      return `${info.webBase}/commits/${sha}`;
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
