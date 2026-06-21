/**
 * Pure helpers for the Stash Naming Helper (F43).
 *
 * When the user runs `git stash` from the GitSight UI, a good default name
 * makes the stash list ten times more useful three days later. This module
 * picks a name from:
 *
 *   - The current branch (always available, e.g. "feature/auth-refactor")
 *   - The set of dirty/staged file paths (their common path prefix or the
 *     standout file's basename)
 *   - The active editor's filename (last resort)
 *
 * Suggestions are short, lowercase, kebab-cased, and end in "-wip" so
 * they're trivially greppable later. The controller still lets the user
 * edit before saving — this just primes the input box.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/stashNaming.test.ts.
 */

import { parsePorcelain } from './forgottenFiles';

/** Pull all dirty / staged paths from porcelain output. */
export function dirtyPaths(porcelain: string): string[] {
  const rows = parsePorcelain(porcelain);
  return rows
    .filter(r => r.x !== '?' && r.y !== '?' && r.x !== '!' && r.y !== '!')
    .map(r => r.path);
}

/**
 * Longest common directory prefix of an array of repo-relative paths.
 * Returns '' when there's nothing meaningful (paths from different roots).
 *
 * "src/auth/login.ts" + "src/auth/logout.ts"     → "src/auth"
 * "src/auth/login.ts" + "src/billing/index.ts"   → "src"
 * "README.md" + "src/foo.ts"                     → ""
 */
export function commonPrefix(paths: string[]): string {
  if (!paths.length) return '';
  const segs = paths.map(p => p.split('/'));
  const first = segs[0];
  let prefixLen = 0;
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (segs.every(s => s.length > i && s[i] === seg)) prefixLen++;
    else break;
  }
  // Don't claim the full path as a "prefix" — we want a *directory*.
  if (prefixLen >= first.length) prefixLen = Math.max(0, prefixLen - 1);
  return first.slice(0, prefixLen).join('/');
}

/** Kebab-case a string: lowercase, anything non-alnum → '-', squash, trim. */
export function kebab(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Strip the conventional commit / branch prefix so we don't double up. */
export function shortenBranch(branch: string): string {
  if (!branch) return '';
  const noPrefix = branch.replace(/^(feature|feat|fix|bug|bugfix|chore|hotfix|release)\//i, '');
  // Some teams use TICKET-1234/short-desc — keep the descriptive half.
  const slash = noPrefix.split('/');
  return kebab(slash[slash.length - 1] || noPrefix);
}

export interface NameSuggestion {
  /** Final ready-to-use name. */
  name: string;
  /** Human-readable label explaining how we derived it. */
  source: string;
}

/**
 * Build the ordered list of suggestions. Newest = most specific first.
 * The controller shows them in a picker; the top one is also pre-filled
 * in the input box.
 */
export function suggestStashNames(args: {
  branch?: string;
  dirtyPaths?: string[];
  activeFile?: string;
  /** Repo basename, used as the absolute last fallback. */
  repoName?: string;
}): NameSuggestion[] {
  const out: NameSuggestion[] = [];
  const branch = args.branch ?? '';
  const dirty = args.dirtyPaths ?? [];

  const branchPart = shortenBranch(branch);

  // Suggestion 1: branch + common-prefix folder
  const prefix = commonPrefix(dirty);
  if (branchPart && prefix) {
    const tail = prefix.split('/').pop()!;
    out.push({
      name: `${branchPart}-${kebab(tail)}-wip`,
      source: `current branch + folder under ${prefix}`,
    });
  } else if (branchPart) {
    out.push({ name: `${branchPart}-wip`, source: 'current branch' });
  }

  // Suggestion 2: single standout file (when only one or two dirty files)
  if (dirty.length === 1) {
    const base = dirty[0].split('/').pop()!.replace(/\.[^.]+$/, '');
    if (base) out.push({ name: `${kebab(base)}-wip`, source: `single file ${dirty[0]}` });
  } else if (dirty.length === 2) {
    const a = dirty[0].split('/').pop()!.replace(/\.[^.]+$/, '');
    const b = dirty[1].split('/').pop()!.replace(/\.[^.]+$/, '');
    if (a && b) out.push({ name: `${kebab(a)}-${kebab(b)}-wip`, source: 'two-file pair' });
  }

  // Suggestion 3: common-prefix folder alone (no branch fallback)
  if (!branchPart && prefix) {
    const tail = prefix.split('/').pop()!;
    out.push({ name: `${kebab(tail)}-wip`, source: `folder under ${prefix}` });
  }

  // Suggestion 4: active editor's filename
  if (args.activeFile) {
    const base = args.activeFile.split('/').pop()!.replace(/\.[^.]+$/, '');
    if (base) out.push({ name: `${kebab(base)}-wip`, source: `active file ${args.activeFile}` });
  }

  // Suggestion 5: repo name (last resort)
  if (args.repoName) {
    out.push({ name: `${kebab(args.repoName)}-wip`, source: 'repo name (fallback)' });
  }

  // Dedupe by name preserving order.
  const seen = new Set<string>();
  const unique: NameSuggestion[] = [];
  for (const s of out) {
    if (!s.name) continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    unique.push(s);
  }
  return unique;
}

/** Pick the best single suggestion to prefill (top of the list). */
export function bestSuggestion(args: Parameters<typeof suggestStashNames>[0]): string {
  const all = suggestStashNames(args);
  if (all.length) return all[0].name;
  return 'wip';
}
