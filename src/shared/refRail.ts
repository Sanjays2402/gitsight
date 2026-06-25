/**
 * GitSight shared ref-rail logic (W9).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node, no DOM. Collects the decoration
 * refs carried by a snapshot's commits into a grouped, ordered list for
 * the web app's left filter rail: local branches, remote branches, and
 * tags, each with the commit count that carries them and the tip sha.
 *
 * The snapshot's `%D` refs look like `HEAD -> main`, `origin/main`,
 * `tag: v1.0.0`, `feature/x`. This module normalises and buckets them so
 * the rail can render branch/tag/remote sections that, when clicked,
 * drive the shared commit-query `ref:` term.
 *
 * No cross-file runtime import (Node type-strip compatible).
 *
 * Tests: test/git/refRail.test.ts
 */

export type RefGroup = 'branch' | 'remote' | 'tag';

export interface RailRef {
  /** The clean ref name (no `tag: ` prefix, no `HEAD -> `). */
  name: string;
  group: RefGroup;
  /** True when HEAD points at this ref. */
  isHead: boolean;
  /** Sha of the (first) commit carrying this ref — the tip. */
  tipSha: string;
}

export interface RailCommit {
  sha: string;
  refs: string[];
}

/** Normalise one raw `%D` decoration entry to a name + group + head flag. */
export function classifyRailRef(raw: string): { name: string; group: RefGroup; isHead: boolean } | null {
  const ref = raw.trim();
  if (!ref) return null;

  // `HEAD -> main` : HEAD pointer plus the branch it points to.
  const headArrow = /^HEAD -> (.+)$/.exec(ref);
  if (headArrow) {
    return { name: headArrow[1].trim(), group: 'branch', isHead: true };
  }
  // Bare detached HEAD — not a nameable rail entry.
  if (ref === 'HEAD') return null;

  // `tag: v1.0.0`
  if (ref.startsWith('tag:')) {
    return { name: ref.slice(4).trim(), group: 'tag', isHead: false };
  }

  // `origin/main`, `upstream/feature/x` : a `/` means a remote-tracking ref.
  // `origin/HEAD` is a symbolic alias we don't want in the rail.
  if (ref.includes('/')) {
    if (/\/HEAD$/.test(ref)) return null;
    return { name: ref, group: 'remote', isHead: false };
  }

  // Plain local branch.
  return { name: ref, group: 'branch', isHead: false };
}

/**
 * Build the grouped rail from a snapshot's commits (newest-first order).
 * The first commit carrying a ref is its tip, so iterating in log order
 * and keeping the first occurrence gives the correct tip sha. Each ref
 * appears once; HEAD-ness is preserved.
 */
export function buildRefRail(commits: RailCommit[]): RailRef[] {
  const byName = new Map<string, RailRef>();
  for (const c of commits) {
    for (const raw of c.refs) {
      const cls = classifyRailRef(raw);
      if (!cls) continue;
      const key = `${cls.group}:${cls.name}`;
      const existing = byName.get(key);
      if (existing) {
        // Keep the head flag if any occurrence is HEAD.
        if (cls.isHead) existing.isHead = true;
        continue;
      }
      byName.set(key, { name: cls.name, group: cls.group, isHead: cls.isHead, tipSha: c.sha });
    }
  }
  return Array.from(byName.values());
}

const GROUP_ORDER: Record<RefGroup, number> = { branch: 0, remote: 1, tag: 2 };

/** Sort refs: group order, then HEAD first within branches, then name. */
export function sortRailRefs(refs: RailRef[]): RailRef[] {
  return [...refs].sort((a, b) => {
    if (a.group !== b.group) return GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export interface RailSection {
  group: RefGroup;
  label: string;
  refs: RailRef[];
}

const GROUP_LABELS: Record<RefGroup, string> = {
  branch: 'Branches',
  remote: 'Remotes',
  tag: 'Tags',
};

/** Group the sorted refs into labelled sections for rendering. */
export function buildRailSections(commits: RailCommit[]): RailSection[] {
  const sorted = sortRailRefs(buildRefRail(commits));
  const sections: RailSection[] = [];
  for (const group of ['branch', 'remote', 'tag'] as RefGroup[]) {
    const refs = sorted.filter(r => r.group === group);
    if (refs.length) sections.push({ group, label: GROUP_LABELS[group], refs });
  }
  return sections;
}

/**
 * The query string a rail ref click produces. Exact match on the ref
 * name via the shared `ref:` term; quoted when it contains characters
 * that would otherwise tokenize oddly (slash is fine, spaces are not, but
 * git refs can't contain spaces — still, quote defensively for `:`).
 */
export function refQuery(ref: RailRef): string {
  const needsQuote = /[\s"]/.test(ref.name);
  return needsQuote ? `ref:"${ref.name}"` : `ref:${ref.name}`;
}
