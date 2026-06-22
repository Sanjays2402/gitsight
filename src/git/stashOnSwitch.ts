/**
 * Pure helpers for the Stash-on-Branch-Switch picker (F80).
 *
 * After a successful branch checkout, scan the stash list for entries
 * that were created WHILE ON the destination branch. Git records the
 * source branch in the stash subject:
 *
 *   "WIP on feature/x: 3a97b28 some message"
 *   "On feature/x: a typed message"
 *   "WIP on (no branch): ..."  ← detached HEAD; skipped
 *
 * The F31 stashSort module already has `extractStashBranch` that pulls
 * the branch fragment from a subject. We layer two pieces of behaviour
 * on top:
 *
 *   1. matchStashesForBranch — return only stashes whose source matches
 *      the just-checked-out branch, newest-first by stash index (lower
 *      index = more recent in git's stash stack).
 *
 *   2. classifyStashAge — bucket each match into 'fresh' / 'aging' /
 *      'old' so the picker tooltip can hint at staleness. Mirrors the
 *      F25 branchAge tiering.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/stashOnSwitch.test.ts.
 */

import { Stash } from './git';
import { cleanStashSubject, extractStashBranch } from './stashSort';

export type StashAge = 'fresh' | 'aging' | 'old';

export interface StashMatch {
  index: number;
  ref: string;
  /** Human-friendly subject (WIP-prefix stripped). */
  cleanSubject: string;
  /** Source branch as recorded in the stash subject; never undefined here
   *  because the matcher filters that out. */
  branch: string;
  date: Date | undefined;
  age: StashAge;
  /** How many days old the stash is, rounded down. Useful for picker
   *  descriptions. Undefined when the stash has no parseable date. */
  ageDays?: number;
  isNamed: boolean;
}

export interface MatchOptions {
  /** Days after which a stash is 'aging' rather than 'fresh'. Default 3. */
  freshDays?: number;
  /** Days after which a stash is 'old' rather than 'aging'. Default 14. */
  agingDays?: number;
  /** Optional clock for testability; defaults to Date.now(). */
  now?: () => Date;
}

/**
 * Return stashes that were created while on `branch`, sorted newest-first
 * (by stash index — git's stack semantics put the most recent at index 0).
 * Detached-HEAD stashes are excluded because they have no usable source
 * branch.
 */
export function matchStashesForBranch(
  stashes: Stash[],
  branch: string,
  opts: MatchOptions = {},
): StashMatch[] {
  if (!branch) return [];
  const target = normaliseBranch(branch);
  const freshDays = opts.freshDays ?? 3;
  const agingDays = opts.agingDays ?? 14;
  const now = opts.now?.() ?? new Date();

  const matches: StashMatch[] = [];
  for (const s of stashes) {
    const recorded = extractStashBranch(s.subject) ?? s.branch ?? undefined;
    if (!recorded) continue;
    if (normaliseBranch(recorded) !== target) continue;
    const usableDate = s.date && !Number.isNaN(s.date.getTime()) ? s.date : undefined;
    const ageDays = computeAgeDays(usableDate, now);
    matches.push({
      index: s.index,
      ref: s.ref,
      cleanSubject: cleanStashSubject(s.subject),
      branch: recorded,
      date: usableDate,
      ageDays,
      age: classifyStashAge(ageDays, freshDays, agingDays),
      isNamed: /^On\s+[^:]+:/.test(s.subject.trim()),
    });
  }
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Normalise a branch name for comparison: lower-case, strip a leading
 * "refs/heads/" or "origin/" prefix (so a stash created on `feature/x`
 * matches a checkout of `origin/feature/x`).
 */
function normaliseBranch(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const noRefs = trimmed.replace(/^refs\/heads\//, '');
  const noOrigin = noRefs.replace(/^origin\//, '');
  return noOrigin.toLowerCase();
}

function computeAgeDays(date: Date | undefined, now: Date): number | undefined {
  if (!date || Number.isNaN(date.getTime())) return undefined;
  const delta = now.getTime() - date.getTime();
  if (delta < 0) return 0;
  return Math.floor(delta / (24 * 60 * 60 * 1000));
}

/** Bucket a stash's age in days into a coarse staleness tier. */
export function classifyStashAge(
  ageDays: number | undefined,
  freshDays: number,
  agingDays: number,
): StashAge {
  if (ageDays == null) return 'aging';
  if (ageDays <= freshDays) return 'fresh';
  if (ageDays <= agingDays) return 'aging';
  return 'old';
}

/** Codicon name for the age tier — used by the picker `$(...)` glyph. */
export function glyphForAge(age: StashAge): string {
  switch (age) {
    case 'fresh': return 'sparkle';
    case 'aging': return 'archive';
    case 'old':   return 'history';
  }
}

/** Render a one-line picker description for a match. */
export function describeStashMatch(m: StashMatch): string {
  const ageLabel = m.ageDays == null
    ? 'unknown age'
    : m.ageDays === 0 ? 'today'
    : m.ageDays === 1 ? '1 day ago'
    : `${m.ageDays} days ago`;
  const namedHint = m.isNamed ? '' : '  \u00b7  WIP';
  return `${m.ref}  \u00b7  ${ageLabel}${namedHint}`;
}

/** Headline used by the toast banner. Stable shape for tests. */
export function describeToastHeadline(matches: StashMatch[], branch: string): string {
  if (matches.length === 0) return `No stashes on \`${branch}\`.`;
  const noun = matches.length === 1 ? 'stash' : 'stashes';
  return `GitSight: ${matches.length} ${noun} previously made on \`${branch}\`.`;
}
