/**
 * Pure helpers for the "Files I own" picker (F47).
 *
 * Two signals combine into an "I own this" score:
 *
 *   1. CODEOWNERS  — does a rule mention me directly (by handle or email)?
 *                    Last-matching rule wins, GitHub semantics.
 *   2. Shortlog    — am I the dominant author by commit count on this file?
 *                    Threshold: > 50% of the per-file shortlog AND >= 2
 *                    commits, to avoid claiming files I touched once.
 *
 * The combined score lets us rank: CODEOWNERS-only files first (canonical
 * ownership), then dual-signal (CODEOWNERS + dominant author), then
 * shortlog-only (de-facto ownership). The picker can paginate.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/filesIOwn.test.ts.
 */

export type OwnershipSource = 'codeowners' | 'shortlog' | 'both';

export interface FileOwnership {
  /** Repo-relative path. */
  path: string;
  source: OwnershipSource;
  /**
   * The CODEOWNERS owners associated with this path (so the picker can
   * render "ABC team" alongside the path). Empty when source = shortlog.
   */
  codeownersOwners: string[];
  /**
   * Number of commits the user made on this file in the scanned window.
   * 0 when we have no shortlog signal (CODEOWNERS-only files outside the
   * commit window).
   */
  myCommits: number;
  /** Total commits to this file in the scanned window across all authors. */
  totalCommits: number;
  /** myCommits / totalCommits — 0..1. */
  ownershipShare: number;
}

export interface CodeownersRuleLike {
  /** Glob pattern as it appeared in CODEOWNERS. */
  pattern: string;
  /** Owners listed for this pattern (handles, emails, teams). */
  owners: string[];
  /** Pre-compiled regex; see `globToCodeownersRegex` below. */
  regex: RegExp;
}

export interface ShortlogEntry {
  path: string;
  /** Author identity → number of commits. */
  byAuthor: Record<string, number>;
}

export interface UserIdentity {
  /** git config user.email — primary key. */
  email: string;
  /** git config user.name — also matched. */
  name: string;
  /** Optional GitHub handle (`@sanjays2402`); matched in CODEOWNERS. */
  handle?: string;
  /** Extra aliases the user wants treated as themselves. */
  aliases?: string[];
}

/**
 * Does this CODEOWNERS rule include the current user?
 *
 *   - `@handle`              matches when args.handle === handle (case-insensitive)
 *   - `email@example.com`    matches against args.email and args.aliases
 *   - `@team` (a team)       NEVER matches a single user (we don't have the
 *                            team→members mapping locally). Caller can pass
 *                            handles in args.aliases to opt-in.
 */
export function ownerMatchesUser(owner: string, user: UserIdentity): boolean {
  const normalised = (owner ?? '').trim();
  if (!normalised) return false;
  const handles = [user.handle, ...(user.aliases ?? [])].filter(Boolean).map(s => s!.toLowerCase());
  const emails = [user.email, ...(user.aliases ?? [])].filter(Boolean).map(s => s!.toLowerCase());
  const lc = normalised.toLowerCase();

  if (lc.includes('@') && !lc.startsWith('@')) {
    // Looks like an email.
    return emails.includes(lc);
  }
  if (lc.startsWith('@')) {
    const stripped = lc.slice(1);
    // Team handles are `org/team`; reject them — we can't expand here.
    if (stripped.includes('/')) return false;
    return handles.includes(`@${stripped}`) || handles.includes(stripped);
  }
  return false;
}

/**
 * Walk the rules in order, return the owners of the LAST one that matches.
 * GitHub CODEOWNERS semantics: later rules override earlier ones.
 */
export function resolveOwners(rules: CodeownersRuleLike[], path: string): string[] {
  let owners: string[] = [];
  for (const r of rules) {
    if (r.regex.test('/' + path) || r.regex.test(path)) owners = r.owners;
  }
  return owners;
}

/**
 * From a per-file shortlog, decide whether the user is the dominant author.
 * Returns { myCommits, totalCommits, share, dominant } for ranking.
 */
export function shortlogDominance(entry: ShortlogEntry, user: UserIdentity): {
  myCommits: number;
  totalCommits: number;
  share: number;
  dominant: boolean;
} {
  const total = Object.values(entry.byAuthor).reduce((a, b) => a + b, 0);
  // Match by name (most common) OR email (when shortlog is keyed by email).
  const userKeys = new Set(
    [user.email, user.name, ...(user.aliases ?? [])]
      .filter(Boolean)
      .map(s => s!.toLowerCase()),
  );
  let mine = 0;
  for (const [author, count] of Object.entries(entry.byAuthor)) {
    if (userKeys.has(author.toLowerCase())) mine += count;
  }
  const share = total > 0 ? mine / total : 0;
  return {
    myCommits: mine,
    totalCommits: total,
    share,
    // Threshold: > 50% AND >= 2 commits. The double-gate avoids claiming
    // a one-shot fixup as ownership.
    dominant: share > 0.5 && mine >= 2,
  };
}

export interface BuildOwnershipArgs {
  user: UserIdentity;
  rules: CodeownersRuleLike[];
  /** Files known to git (from `git ls-files`). */
  trackedFiles: string[];
  /** Per-file shortlog over a scan window. */
  shortlog: ShortlogEntry[];
}

/**
 * Build the ranked ownership list. Output is sorted:
 *
 *   1. `both` (CODEOWNERS match AND dominant author) — descending myCommits
 *   2. `codeowners` (CODEOWNERS match only) — alphabetical path
 *   3. `shortlog` (dominant author only) — descending myCommits, then path
 *
 * Paths that appear in neither signal are dropped.
 */
export function buildFilesIOwn(args: BuildOwnershipArgs): FileOwnership[] {
  const { user, rules, trackedFiles, shortlog } = args;
  const shortlogIdx = new Map(shortlog.map(s => [s.path, s] as const));
  const seenPaths = new Set<string>();
  const out: FileOwnership[] = [];

  // Iterate tracked files (the canonical list).
  for (const path of trackedFiles) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    const owners = resolveOwners(rules, path);
    const ownsViaRule = owners.some(o => ownerMatchesUser(o, user));
    const entry = shortlogIdx.get(path);
    let dominantShare = 0;
    let myCommits = 0;
    let totalCommits = 0;
    let dominant = false;
    if (entry) {
      const d = shortlogDominance(entry, user);
      myCommits = d.myCommits;
      totalCommits = d.totalCommits;
      dominantShare = d.share;
      dominant = d.dominant;
    }
    if (!ownsViaRule && !dominant) continue;
    let source: OwnershipSource;
    if (ownsViaRule && dominant) source = 'both';
    else if (ownsViaRule) source = 'codeowners';
    else source = 'shortlog';
    out.push({
      path,
      source,
      codeownersOwners: ownsViaRule ? owners : [],
      myCommits,
      totalCommits,
      ownershipShare: dominantShare,
    });
  }

  // Stable sort by ownership bucket then by descending commits.
  const bucketRank = (s: OwnershipSource): number =>
    s === 'both' ? 0 : s === 'codeowners' ? 1 : 2;
  out.sort((a, b) => {
    const r = bucketRank(a.source) - bucketRank(b.source);
    if (r !== 0) return r;
    if (a.source === 'codeowners' && b.source === 'codeowners') {
      return a.path.localeCompare(b.path);
    }
    if (b.myCommits !== a.myCommits) return b.myCommits - a.myCommits;
    return a.path.localeCompare(b.path);
  });

  return out;
}

/**
 * Parse the output of:
 *
 *   git log --since=Nd --no-merges --pretty=format:'%aE|%aN' --name-only
 *
 * into per-file author counts. Each block is "header line(s) -- blank --
 * file paths -- blank". We pair every path with the latest header seen.
 */
export function parseShortlog(raw: string): ShortlogEntry[] {
  const idx = new Map<string, Record<string, number>>();
  let currentAuthor = '';
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    if (line.includes('|') && !line.includes('/')) {
      const parts = line.split('|');
      if (parts.length === 2) {
        const [email, name] = parts;
        // Prefer email key when present, fallback to name. Lowercased so
        // joins with user identity are case-insensitive.
        currentAuthor = (email || name || '').toLowerCase();
        continue;
      }
    }
    // Looks like a file path.
    if (!currentAuthor) continue;
    const path = line.trim();
    if (!path) continue;
    if (!idx.has(path)) idx.set(path, {});
    const row = idx.get(path)!;
    row[currentAuthor] = (row[currentAuthor] ?? 0) + 1;
  }
  const out: ShortlogEntry[] = [];
  for (const [path, byAuthor] of idx) out.push({ path, byAuthor });
  return out;
}

/**
 * Convert a CODEOWNERS-style glob into a path regex. Mirror of the helper
 * in codeownersOverlay.ts but exposed here so this pure module is
 * self-contained and unit-testable.
 *
 *   /docs/         → ^/docs(/|$)
 *   *.ts           → (^|/)[^/]*\.ts($|/)
 *   src/**         → (^|/)src/.*($|/)
 */
export function globToCodeownersRegex(glob: string): RegExp {
  let g = glob;
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i += 2; if (g[i] === '/') i++; }
    else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if ('.+^$()[]{}|\\'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  const prefix = anchored ? '^/' : '(^|/)';
  const suffix = dirOnly ? '(/|$)' : '($|/)';
  return new RegExp(prefix + re + suffix);
}

/** Parse a CODEOWNERS file body into rules suitable for resolveOwners. */
export function parseCodeownersBody(text: string): CodeownersRuleLike[] {
  const rules: CodeownersRuleLike[] = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1);
    rules.push({ pattern, owners, regex: globToCodeownersRegex(pattern) });
  }
  return rules;
}
