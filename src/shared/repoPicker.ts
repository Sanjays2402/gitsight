/**
 * GitSight shared repo-picker logic (W8).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. Pure path +
 * list helpers for the multi-repo switcher: deciding whether a requested
 * repo path is ALLOWED (the security gate — a browser must not be able to
 * read an arbitrary git repo on the host), deriving display names, and
 * ordering the picker list. The filesystem scan itself lives in the
 * companion server (it needs fs); everything decidable from strings lives
 * here so it's covered by the extension's node:test suite.
 *
 * Paths are expected pre-resolved to absolute POSIX form (the server uses
 * node:path.resolve, which yields `/`-separated absolutes on the cron
 * host). No cross-file runtime import (Node type-stripping).
 *
 * Tests: test/git/repoPicker.test.ts
 */

export interface RepoEntry {
  /** Display name (basename of the repo path). */
  name: string;
  /** Absolute repo path. */
  path: string;
  /** True for the repo currently being served. */
  current: boolean;
}

/** Drop trailing slashes (but keep a bare root `/`). */
export function stripTrailingSlash(p: string): string {
  if (p.length <= 1) return p;
  return p.replace(/\/+$/, '') || '/';
}

/** Basename of a POSIX path, robust to trailing slashes. */
export function repoName(p: string): string {
  const trimmed = stripTrailingSlash(p);
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

/**
 * Boundary-safe containment: is `candidate` the root itself or strictly
 * inside it? Guards against the `/foo/bar` vs `/foo/bar-baz` prefix trap
 * by requiring a separator after the root.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const r = stripTrailingSlash(root);
  const c = stripTrailingSlash(candidate);
  if (c === r) return true;
  return c.startsWith(r === '/' ? '/' : r + '/');
}

/**
 * The security gate for `?repo=` overrides. A requested repo is allowed
 * only when it is the default served repo OR lives within the configured
 * scan root. Without a root, only the default repo is reachable.
 */
export function isRepoAllowed(
  candidate: string,
  opts: { repo: string; root?: string },
): boolean {
  if (!candidate) return false;
  if (stripTrailingSlash(candidate) === stripTrailingSlash(opts.repo)) return true;
  if (opts.root && isWithinRoot(opts.root, candidate)) return true;
  return false;
}

/**
 * Build the ordered, de-duplicated picker list from discovered repo paths
 * plus the current path. The current repo sorts first; the rest follow
 * alphabetically by display name (case-insensitive), ties broken by path.
 */
export function buildRepoEntries(paths: string[], currentPath: string): RepoEntry[] {
  const current = stripTrailingSlash(currentPath);
  const seen = new Set<string>();
  const entries: RepoEntry[] = [];
  for (const raw of [currentPath, ...paths]) {
    const p = stripTrailingSlash(raw);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    entries.push({ name: repoName(p), path: p, current: p === current });
  }
  entries.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return byName !== 0 ? byName : a.path.localeCompare(b.path);
  });
  return entries;
}
