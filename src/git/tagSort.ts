/**
 * Pure helpers for tag ranking — semver-aware sort, label/description rendering.
 *
 * The picker UI lives in src/views/tagSwitcher.ts; this module is intentionally
 * free of vscode / child_process so it can be unit-tested in isolation.
 */

import { Tag } from './git';

/**
 * Parse a semver-like tag name into a comparable tuple.
 *
 * Accepts: 'v1.2.3', '1.2.3', '1.2.3-rc.4', '1.2.3+build.7'. Returns undefined
 * when the tag is not even close to semver, so callers can fall back to date /
 * lexicographic ordering.
 */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers (`['rc', '4']` for `1.2.3-rc.4`). Empty = stable. */
  pre: (string | number)[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(name: string): SemverParts | undefined {
  const m = SEMVER_RE.exec(name.trim());
  if (!m) return undefined;
  const pre = m[4]
    ? m[4].split('.').map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : p))
    : [];
  return { major: +m[1], minor: +m[2], patch: +m[3], pre };
}

/**
 * Compare two semver tuples per the spec:
 *   1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0
 *   precedence: major.minor.patch, then pre-release (absent > present),
 *   then identifier-wise (numeric < alphanumeric).
 * Returns negative when `a < b`, positive when `a > b`, 0 when equal.
 */
export function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Pre-release: absent (stable) > present.
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (typeof x === 'number') {
      return -1; // numeric < alphanumeric
    } else if (typeof y === 'number') {
      return 1;
    } else {
      if (x !== y) return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Sort tags newest-first by semver when possible, falling back to creator date,
 * with non-semver / undated tags landing at the bottom (most-recent-first within
 * each bucket).
 */
export function sortTagsForPicker(tags: Tag[]): Tag[] {
  const decorated = tags.map(t => ({ tag: t, sem: parseSemver(t.name) }));
  return decorated
    .sort((a, b) => {
      const aSem = a.sem, bSem = b.sem;
      if (aSem && bSem) return -compareSemver(aSem, bSem); // newest first
      if (aSem) return -1; // semver wins over non-semver
      if (bSem) return 1;
      const aDate = a.tag.date?.getTime() ?? 0;
      const bDate = b.tag.date?.getTime() ?? 0;
      if (aDate !== bDate) return bDate - aDate;
      return a.tag.name < b.tag.name ? -1 : a.tag.name > b.tag.name ? 1 : 0;
    })
    .map(d => d.tag);
}

/** Short description rendered in the picker (right-aligned bits). */
export interface TagDescription {
  /** 'v1.2.3' or 'commit dead123' truncation. */
  label: string;
  /** ISO-strict date when available, otherwise empty. */
  date: string;
  /** Subject excerpt, truncated to N chars. */
  subject: string;
  /** Set when the parsed name has a pre-release tag (rc/beta/alpha/etc.). */
  isPre: boolean;
}

export function describeTag(t: Tag, subjectMax = 80): TagDescription {
  const sem = parseSemver(t.name);
  return {
    label: t.name,
    date: t.date ? t.date.toISOString().slice(0, 10) : '',
    subject: t.subject.length > subjectMax ? `${t.subject.slice(0, subjectMax - 1)}…` : t.subject,
    isPre: !!(sem && sem.pre.length > 0),
  };
}
