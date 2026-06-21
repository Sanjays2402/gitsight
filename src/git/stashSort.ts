/**
 * Pure helpers for the Stash Quick-Switcher (F31).
 *
 * Each stash carries a porcelain entry (`%gd\t%gs\t%aI`) that's already parsed
 * by Git.stashes() into { index, ref, subject, branch, date }. The picker UI
 * needs three things this module provides:
 *
 *   1. A clean human label — the raw subject Git stores looks like
 *      'WIP on feature/x: 3a97b28 some message'. Strip the leading
 *      'WIP on <branch>:' bookkeeping and any trailing SHA fragment so the user
 *      sees the actual message they typed (or, for unnamed stashes, the
 *      subject of the underlying commit).
 *
 *   2. A relevance/recency rank — most-recent-first by date, with named
 *      stashes (`git stash push -m ...`) floating above bare WIPs of the same
 *      age (rare but happens during long-running rebases).
 *
 *   3. A scrubbed branch fragment — `stash` records `WIP on <branch>:` which
 *      is the branch the user was on when they stashed. Useful in the picker
 *      detail so they can tell apart stashes from different branches.
 *
 * Pure — no vscode / no child_process. The picker UI lives in
 * src/views/stashSwitcher.ts.
 */

import { Stash } from './git';

/** Strip the `WIP on <branch>: <sha> ` prefix Git writes for unnamed stashes. */
export function cleanStashSubject(subject: string): string {
  // Forms:
  //   'WIP on feature/x: 3a97b28 actual subject'
  //   'On feature/x: a message the user typed'  ← named stash
  //   'WIP on (no branch): 3a97b28 ...'         ← detached HEAD
  const wip = /^WIP on [^:]+:\s*(?:[0-9a-f]{6,40}\s+)?(.+)$/.exec(subject.trim());
  if (wip) return wip[1].trim();
  const named = /^On [^:]+:\s*(.+)$/.exec(subject.trim());
  if (named) return named[1].trim();
  return subject.trim();
}

/** True when the stash was created with `git stash push -m <msg>` (vs bare WIP). */
export function isNamedStash(subject: string): boolean {
  return /^On [^:]+:/.test(subject.trim());
}

/** Best-effort extract of the branch fragment Git records in the subject. */
export function extractStashBranch(subject: string): string | undefined {
  const m = /^(?:WIP )?[Oo]n\s+([^:]+):/.exec(subject.trim());
  if (!m) return undefined;
  const branch = m[1].trim();
  if (!branch || branch === '(no branch)') return undefined;
  return branch;
}

/**
 * Sort stashes for the picker:
 *  - newest-first by date
 *  - on tie: named stash (user-authored message) wins over bare WIP
 *  - on tie: lower reflog index (more recent in the reflog) wins
 */
export function sortStashesForPicker(stashes: Stash[]): Stash[] {
  return [...stashes].sort((a, b) => {
    const at = a.date?.getTime() ?? 0;
    const bt = b.date?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    const aNamed = isNamedStash(a.subject);
    const bNamed = isNamedStash(b.subject);
    if (aNamed !== bNamed) return aNamed ? -1 : 1;
    return a.index - b.index;
  });
}

/** Compact descriptor for picker `description` — branch + date hint. */
export function describeStash(s: Stash): { branch?: string; date?: string; isNamed: boolean } {
  return {
    branch: extractStashBranch(s.subject) ?? s.branch ?? undefined,
    date: s.date && !Number.isNaN(s.date.getTime()) ? s.date.toISOString().slice(0, 10) : undefined,
    isNamed: isNamedStash(s.subject),
  };
}
