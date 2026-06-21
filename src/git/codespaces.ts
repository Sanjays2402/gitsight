/**
 * Pure helpers for the "Open in GitHub Codespaces" feature (F56).
 *
 * Given a remote URL (or a parsed owner/name) plus an optional ref or
 * devcontainer path, build the URL that GitHub uses to launch a new
 * Codespace. Includes both the user-facing redirect URL and the (more
 * precise) advanced-create URL.
 *
 * Reference:
 *   - Quick create:    https://github.com/codespaces/new?repo=<numeric_id>
 *                      OR
 *                      https://github.com/codespaces/new/<owner>/<repo>?ref=<branch>
 *   - Advanced create: https://github.com/codespaces/new?repo=<owner>%2F<repo>&ref=<branch>&devcontainer_path=.devcontainer%2Fdevcontainer.json&machine=basicLinux32gb&location=UsWest
 *
 * Pure — no vscode, no child_process. Tests in test/git/codespaces.test.ts.
 */

export interface GhRepoRef {
  owner: string;
  name: string;
  /** Branch / commit / tag to launch from. Omit for the repo default. */
  ref?: string;
  /** Path to a devcontainer.json relative to repo root. Omit for the repo default. */
  devcontainerPath?: string;
  /** Machine SKU id (e.g. basicLinux32gb, premiumLinux). Omit for the user default. */
  machine?: string;
  /** Region preference (UsEast, UsWest, EuropeWest, SoutheastAsia). Omit for the user default. */
  location?: string;
}

/**
 * Parse a git remote URL into an owner/repo. Accepts the common shapes:
 *   - SSH SCP-style:    git@github.com:owner/repo.git
 *   - SSH proto:        ssh://git@github.com/owner/repo.git
 *   - HTTPS:            https://github.com/owner/repo(.git)?
 *   - HTTPS with token: https://x-access-token:...@github.com/owner/repo.git
 *
 * Returns undefined when the URL isn't a GitHub remote (Codespaces only
 * launches from github.com — we don't try to be clever with Enterprise
 * hostnames here).
 */
export function parseGitHubRemote(url: string): { owner: string; name: string } | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();

  // URL-style: ssh://, https://, http://, git:// — strip any embedded creds first.
  // Check this BEFORE the SCP shape so `ssh://git@github.com:22/owner/repo` doesn't
  // get matched as SCP "ssh:..." (which would treat "ssh" as the user, "//git@github.com" etc).
  const u = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([a-z0-9.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (u && isGitHubHost(u[1])) {
    const parts = u[2].split('/').filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0], name: parts[parts.length - 1].replace(/\.git$/i, '') };
  }
  // SCP-style: [user@]host:path  (must NOT begin with a scheme://).
  if (!/^[a-z]+:\/\//i.test(trimmed)) {
    const scp = /^(?:[^@]+@)?([a-z0-9.-]+):([^/].*?)(?:\.git)?$/i.exec(trimmed);
    if (scp && isGitHubHost(scp[1])) {
      const parts = scp[2].split('/').filter(Boolean);
      if (parts.length >= 2) return { owner: parts[0], name: parts[parts.length - 1].replace(/\.git$/i, '') };
    }
  }
  return undefined;
}

function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h === 'www.github.com';
}

/**
 * Build the "Create codespace" URL for the given repo + ref.
 *
 * Uses the path-based form when only owner/repo/ref are present (cleanest
 * and matches the GitHub UI's "Open in Codespaces" button); falls back
 * to the advanced query form when devcontainer/machine/location are
 * pinned (the path form silently ignores those).
 */
export function buildCodespacesUrl(ref: GhRepoRef): string {
  const wantAdvanced = !!(ref.devcontainerPath || ref.machine || ref.location);
  if (!wantAdvanced) {
    const base = `https://github.com/codespaces/new/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
    if (!ref.ref) return base;
    return `${base}?ref=${encodeRefForQuery(ref.ref)}`;
  }
  const params = new URLSearchParams();
  params.set('repo_owner', ref.owner);
  params.set('repo', `${ref.owner}/${ref.name}`);
  if (ref.ref) params.set('ref', ref.ref);
  if (ref.devcontainerPath) params.set('devcontainer_path', ref.devcontainerPath);
  if (ref.machine) params.set('machine', ref.machine);
  if (ref.location) params.set('location', ref.location);
  return `https://github.com/codespaces/new?${params.toString()}`;
}

/**
 * Build the "Manage codespaces" URL for the repo. Useful for the
 * second QuickPick row ("see my existing codespaces for this repo").
 */
export function buildManageCodespacesUrl(ref: { owner: string; name: string }): string {
  const owner = encodeURIComponent(ref.owner);
  const name = encodeURIComponent(ref.name);
  return `https://github.com/codespaces?repository_id=&q=repo%3A${owner}%2F${name}`;
}

/**
 * Encode a ref for the `?ref=` query string. URLSearchParams encodes
 * `/` as `%2F` which is fine but ugly; we keep it raw so `feature/x`
 * looks like `feature/x` in the address bar. GitHub accepts either form.
 */
function encodeRefForQuery(ref: string): string {
  return encodeURIComponent(ref).replace(/%2F/gi, '/');
}

/**
 * Pretty-print a CodespaceTarget for QuickPick rows. Keeps the label
 * short (\u2022 separator) and lists the ref and any pinned overrides
 * in the description.
 */
export function describeCodespaceTarget(ref: GhRepoRef): string {
  const bits: string[] = [];
  bits.push(ref.ref ? `ref ${ref.ref}` : 'default branch');
  if (ref.devcontainerPath) bits.push(`devcontainer ${ref.devcontainerPath}`);
  if (ref.machine) bits.push(`machine ${ref.machine}`);
  if (ref.location) bits.push(`location ${ref.location}`);
  return bits.join(' \u00b7 ');
}
