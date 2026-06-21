/**
 * Pure helpers for the Last-Shown-Tag status-bar pill.
 *
 * Picks the "most relevant" tag from a list and renders a stable summary
 * with the tag name, age, and commits-since (when given). UI code lives in
 * src/views/lastTagPill.ts; this module is intentionally vscode-free so
 * the picker logic can be unit-tested.
 */

import { Tag } from './git';
import { sortTagsForPicker } from './tagSort';

export interface LatestTagPick {
  tag: Tag;
  /** True if the tag name parsed as semver. */
  isSemver: boolean;
  /** True if the parsed semver has pre-release identifiers (rc/beta/etc.). */
  isPre: boolean;
}

/**
 * Choose the most relevant tag for the pill.
 *
 * Strategy:
 *   1. If `preferStable` is true and any stable semver tag exists, prefer
 *      the newest stable semver tag — so a release branch doesn't show
 *      `v2.0.0-rc.1` while `v1.9.4` is sitting right there.
 *   2. Otherwise use the existing `sortTagsForPicker` order (semver newest
 *      first, non-semver by creator date desc) and pick the head.
 *
 * Returns undefined when the input is empty.
 */
export function pickLatestTag(
  tags: Tag[],
  opts: { preferStable?: boolean } = {},
): LatestTagPick | undefined {
  if (!tags.length) return undefined;
  const sorted = sortTagsForPicker(tags);
  if (opts.preferStable) {
    const stable = sorted.find(t => {
      const sem = parseSemverNamePart(t.name);
      return sem !== undefined && !sem.hasPre;
    });
    if (stable) {
      return { tag: stable, isSemver: true, isPre: false };
    }
  }
  const head = sorted[0];
  const sem = parseSemverNamePart(head.name);
  return {
    tag: head,
    isSemver: sem !== undefined,
    isPre: sem?.hasPre ?? false,
  };
}

/**
 * Tiny duplicate of the semver detector in tagSort.ts, focused on a single
 * yes/no question (semver? pre-release?). Kept local so this module doesn't
 * leak the full SemverParts type or its parser.
 */
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseSemverNamePart(name: string): { hasPre: boolean } | undefined {
  const m = SEMVER_RE.exec(name.trim());
  if (!m) return undefined;
  return { hasPre: !!m[4] };
}

/**
 * Render the short pill text. Output is monochrome and emoji-free.
 *
 * Examples:
 *   "v1.2.3"
 *   "v1.2.3 +5"          (5 commits since)
 *   "v1.2.3-rc.1"        (pre-release, no decoration)
 *
 * `commitsSince` is omitted when undefined or zero.
 */
export function formatTagPill(pick: LatestTagPick, commitsSince?: number): string {
  const since = (commitsSince && commitsSince > 0) ? ` +${commitsSince}` : '';
  return `${pick.tag.name}${since}`;
}

/**
 * Render the tooltip markdown shown on hover. Always includes the tag name
 * + subject when known; appends age, commits-since, and a hint about the
 * actions menu.
 */
export interface TooltipBits {
  ageLabel: string;          // empty string when no date
  commitsSince?: number;     // undefined when not computed
}
export function formatTagTooltip(pick: LatestTagPick, bits: TooltipBits): string {
  const lines: string[] = [];
  lines.push(`**Latest tag: ${pick.tag.name}**`);
  if (pick.tag.subject) lines.push(pick.tag.subject);
  const meta: string[] = [];
  if (bits.ageLabel) meta.push(`${bits.ageLabel} ago`);
  if (typeof bits.commitsSince === 'number') {
    meta.push(bits.commitsSince === 0 ? 'HEAD is on the tag' : `${bits.commitsSince} commits since`);
  }
  if (pick.isPre) meta.push('pre-release');
  if (meta.length) lines.push(`_${meta.join('  ·  ')}_`);
  lines.push('Click for tag actions.');
  return lines.join('  \n');
}
