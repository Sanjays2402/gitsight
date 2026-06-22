/**
 * Pure helpers for the GitHub Default-Reviewers Picker (F57).
 *
 * Given a set of changed paths + a CODEOWNERS rule set + the author's own
 * identity, build the list of GitHub handles + teams that would naturally
 * own a review of those files. The picker UI pre-ticks all of them and
 * lets the user trim before invoking `gh pr edit --add-reviewer`.
 *
 * The matching rules mirror the F47 "Files I own" semantics but inverted:
 * here we want owners EXCLUDING the author (you can't review your own PR),
 * and we want both individual handles AND team handles (GitHub will expand
 * teams server-side).
 *
 * Reviewer extraction:
 *   - Last-matching CODEOWNERS rule wins (GitHub semantics).
 *   - Owners are recorded with their source paths so the picker can show
 *     "owns 3 of 5 changed files".
 *   - Email-shape owners are dropped — `gh pr edit --add-reviewer` only
 *     accepts handles and team slugs.
 *   - The author's own handle/email is dropped from suggestions.
 *
 * Pure — no vscode, no child_process. Tests in test/git/defaultReviewers.test.ts.
 */
import { CodeownersRuleLike, resolveOwners } from './filesIOwn';

export type ReviewerKind = 'user' | 'team';

export interface ReviewerSuggestion {
  /** GitHub handle WITHOUT the leading `@`. e.g. "sanjays2402" or "myorg/core". */
  handle: string;
  /** Display form WITH `@` for picker labels. */
  displayHandle: string;
  kind: ReviewerKind;
  /** Sorted set of repo-relative paths this reviewer owns within the PR diff. */
  ownedPaths: string[];
  /** ownedPaths.length / totalChangedFiles — 0..1. */
  coverage: number;
}

export interface AuthorIdentity {
  /** git user.email — used to filter the author out of the suggestion list. */
  email: string;
  /** git user.name. */
  name: string;
  /** GitHub handle WITHOUT `@`, optional. When present, suggestions matching
   *  this handle are dropped. */
  handle?: string;
}

/** Normalise a CODEOWNERS owner into something we can pass to `gh pr edit`. */
export interface NormalisedOwner {
  raw: string;
  kind: ReviewerKind | 'email' | 'invalid';
  /** Handle without `@`, valid only when kind is user|team. */
  handle?: string;
}

const HANDLE_RE = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM_RE = /^@?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9-_.]{0,38}))$/;

export function normaliseOwner(owner: string): NormalisedOwner {
  const raw = (owner ?? '').trim();
  if (!raw) return { raw: '', kind: 'invalid' };
  // Emails (`bob@example.com`) — never valid for gh's --add-reviewer.
  if (raw.includes('@') && raw.indexOf('@') > 0) return { raw, kind: 'email' };
  const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
  // Teams ("@org/core" / "org/core").
  const teamMatch = TEAM_RE.exec(raw);
  if (teamMatch) {
    return { raw, kind: 'team', handle: `${teamMatch[1]}/${teamMatch[2]}` };
  }
  // Single-segment handles.
  if (HANDLE_RE.test(stripped)) {
    return { raw, kind: 'user', handle: stripped };
  }
  return { raw, kind: 'invalid' };
}

export interface BuildReviewersArgs {
  rules: CodeownersRuleLike[];
  /** Paths changed by the PR (repo-relative). */
  changedPaths: string[];
  /** Author identity — these are dropped from the suggestion list. */
  author: AuthorIdentity;
  /** Extra handles the user wants permanently excluded (config). */
  extraExcluded?: string[];
  /** When true, include team handles in the output (default true). */
  includeTeams?: boolean;
}

/**
 * Build a deduplicated, ranked list of reviewer suggestions.
 *
 * Ordering:
 *   1. Reviewers with the highest coverage (most changed files owned) first.
 *   2. Within the same coverage, individual users before teams (users get
 *      notified directly; teams fan-out via @-mention).
 *   3. Alphabetical handle as the final tiebreaker.
 */
export function buildReviewerSuggestions(args: BuildReviewersArgs): ReviewerSuggestion[] {
  const { rules, changedPaths, author, extraExcluded = [], includeTeams = true } = args;
  if (!changedPaths.length) return [];

  const excluded = new Set<string>();
  if (author.handle) excluded.add(author.handle.toLowerCase().replace(/^@/, ''));
  for (const e of extraExcluded) {
    const norm = normaliseOwner(e);
    if (norm.handle) excluded.add(norm.handle.toLowerCase());
  }

  const byHandle = new Map<string, { kind: ReviewerKind; paths: Set<string> }>();
  for (const p of changedPaths) {
    const owners = resolveOwners(rules, p);
    for (const o of owners) {
      const norm = normaliseOwner(o);
      if (norm.kind !== 'user' && norm.kind !== 'team') continue;
      if (!norm.handle) continue;
      if (norm.kind === 'team' && !includeTeams) continue;
      const key = norm.handle.toLowerCase();
      if (excluded.has(key)) continue;
      const slot = byHandle.get(key);
      if (slot) {
        slot.paths.add(p);
      } else {
        byHandle.set(key, { kind: norm.kind, paths: new Set([p]) });
      }
    }
  }

  const total = changedPaths.length;
  const out: ReviewerSuggestion[] = [];
  for (const [handleLower, slot] of byHandle) {
    const ownedPaths = [...slot.paths].sort();
    out.push({
      handle: handleLower,
      displayHandle: `@${handleLower}`,
      kind: slot.kind,
      ownedPaths,
      coverage: ownedPaths.length / total,
    });
  }
  out.sort((a, b) => {
    if (a.ownedPaths.length !== b.ownedPaths.length) {
      return b.ownedPaths.length - a.ownedPaths.length;
    }
    if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
    return a.handle.localeCompare(b.handle);
  });
  return out;
}

/** Render a one-line summary for a suggestion's picker `description`. */
export function describeSuggestion(s: ReviewerSuggestion, totalFiles: number): string {
  const pct = totalFiles > 0 ? Math.round((s.ownedPaths.length / totalFiles) * 100) : 0;
  const kindLabel = s.kind === 'team' ? 'team' : 'user';
  return `${kindLabel} \u00b7 owns ${s.ownedPaths.length}/${totalFiles} (${pct}%)`;
}

/** Detail line — first 3 owned paths, with an ellipsis when truncated. */
export function describeSuggestionDetail(s: ReviewerSuggestion): string | undefined {
  if (!s.ownedPaths.length) return undefined;
  const head = s.ownedPaths.slice(0, 3).join(', ');
  if (s.ownedPaths.length <= 3) return head;
  return `${head} \u00b7 \u2026 +${s.ownedPaths.length - 3} more`;
}

/**
 * Format the `gh pr edit` command(s) for the picked reviewer set. We split
 * users from teams because `gh` uses different flags (`--add-reviewer`
 * accepts both, but team handles must be passed as "<org>/<team>" without
 * the `@`). The picker already strips the `@` via the normalised handle.
 */
export function buildGhAddReviewerArgs(
  prNumber: number,
  picked: ReviewerSuggestion[],
): { args: string[]; users: string[]; teams: string[] } | undefined {
  if (!picked.length) return undefined;
  const users = picked.filter(p => p.kind === 'user').map(p => p.handle);
  const teams = picked.filter(p => p.kind === 'team').map(p => p.handle);
  const args: string[] = ['pr', 'edit', String(prNumber)];
  for (const u of users) args.push('--add-reviewer', u);
  for (const t of teams) args.push('--add-reviewer', t);
  return { args, users, teams };
}

/** Parse the output of `git diff --name-only <base>...HEAD` into a sorted set. */
export function parseChangedPaths(raw: string): string[] {
  if (!raw) return [];
  const set = new Set<string>();
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  return [...set].sort();
}

/**
 * F85 — Reviewer round-robin re-ranker.
 *
 * Within each coverage tier, prefer reviewers who have been requested LEAST
 * across the recent PR window. This stops a small set of "always-on" owners
 * from getting hammered every PR while teammates with equal coverage sit
 * idle. The base coverage ranking from `buildReviewerSuggestions` is
 * preserved (we never demote a high-coverage owner under a low-coverage
 * one), but inside a tier we sort by load asc, then by team/user kind,
 * then by handle.
 *
 * Inputs:
 *   - suggestions: output of buildReviewerSuggestions (already coverage-sorted)
 *   - loadByHandle: handle (lower-case, no @) → number of recent requests.
 *                   Handles not present default to 0 (interpreted as
 *                   "never requested in the window" → top of the tier).
 *
 * Returns a new array; does not mutate the input.
 */
export interface RoundRobinArgs {
  suggestions: ReviewerSuggestion[];
  loadByHandle: Map<string, number>;
}

export function rerankRoundRobin(args: RoundRobinArgs): ReviewerSuggestion[] {
  const { suggestions, loadByHandle } = args;
  if (!suggestions.length) return [];
  const tiers = new Map<number, ReviewerSuggestion[]>();
  for (const s of suggestions) {
    const tier = s.ownedPaths.length;
    let bucket = tiers.get(tier);
    if (!bucket) {
      bucket = [];
      tiers.set(tier, bucket);
    }
    bucket.push(s);
  }
  const tiersSorted = [...tiers.keys()].sort((a, b) => b - a);
  const out: ReviewerSuggestion[] = [];
  for (const tier of tiersSorted) {
    const bucket = tiers.get(tier)!;
    bucket.sort((a, b) => {
      const la = loadByHandle.get(a.handle.toLowerCase()) ?? 0;
      const lb = loadByHandle.get(b.handle.toLowerCase()) ?? 0;
      if (la !== lb) return la - lb;
      if (a.kind !== b.kind) return a.kind === 'user' ? -1 : 1;
      return a.handle.localeCompare(b.handle);
    });
    for (const s of bucket) out.push(s);
  }
  return out;
}

/**
 * Parse the `gh pr list --json reviewRequests,latestReviews` JSON blob and
 * count how many times each handle has been requested across the window.
 *
 *   { "reviewRequests": [ { "login": "alice" }, { "name": "core" } ], ... }
 *
 * Both `login` (user) and `name` (team) shapes are counted. Team names are
 * normalised to `org/team` only when an `organization` slot is present; bare
 * `name` lookups stay as `name` (we still match against the same key on the
 * suggestion side). Robust against missing fields and array entries with
 * unexpected shapes — older gh JSON versions emit slightly different keys.
 */
export interface GhPrLoadEntry {
  reviewRequests?: Array<{ login?: string; name?: string; organization?: { login?: string } | string }>;
  latestReviews?: Array<{ author?: { login?: string } }>;
}

export function countReviewerLoad(prs: GhPrLoadEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(prs)) return counts;
  for (const pr of prs) {
    if (!pr || typeof pr !== 'object') continue;
    const seen = new Set<string>();
    if (Array.isArray(pr.reviewRequests)) {
      for (const req of pr.reviewRequests) {
        const handle = normaliseRequestHandle(req);
        if (handle) seen.add(handle);
      }
    }
    if (Array.isArray(pr.latestReviews)) {
      for (const rev of pr.latestReviews) {
        const login = rev?.author?.login;
        if (typeof login === 'string' && login) {
          seen.add(login.toLowerCase());
        }
      }
    }
    for (const handle of seen) {
      counts.set(handle, (counts.get(handle) ?? 0) + 1);
    }
  }
  return counts;
}

function normaliseRequestHandle(req: any): string | undefined {
  if (!req || typeof req !== 'object') return undefined;
  if (typeof req.login === 'string' && req.login) return req.login.toLowerCase();
  if (typeof req.name === 'string' && req.name) {
    const orgLogin = typeof req.organization === 'string'
      ? req.organization
      : (req.organization?.login ?? '');
    if (orgLogin) return `${orgLogin}/${req.name}`.toLowerCase();
    return req.name.toLowerCase();
  }
  return undefined;
}

/**
 * Render a one-line load summary for a suggestion's picker `detail` line:
 *
 *   "owns 3/5 (60%) · 0 recent requests"
 *   "owns 1/5 (20%) · 7 recent requests"
 *
 * Pass the same loadByHandle that fed rerankRoundRobin. Zero load reads as
 * "0 recent requests" rather than being omitted — the goal is to make load
 * visible so the user understands WHY the order changed.
 */
export function describeSuggestionWithLoad(
  s: ReviewerSuggestion,
  totalFiles: number,
  loadByHandle: Map<string, number>,
): string {
  const base = describeSuggestion(s, totalFiles);
  const load = loadByHandle.get(s.handle.toLowerCase()) ?? 0;
  const word = load === 1 ? 'request' : 'requests';
  return `${base} \u00b7 ${load} recent ${word}`;
}
