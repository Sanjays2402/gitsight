/**
 * Pure helpers for F127 - Stale Stash Patch Export.
 *
 * Companion to F67 (Stash Trash Bin) and F120 (What's Stale dashboard).
 * Before letting the user drop a batch of stashes, this module derives
 * a safe, descriptive filename for each stash's patch + builds the
 * combined report.
 *
 * Filename shape:
 *
 *   gitsight-stash-2026-06-23-1342__on-feature-x__WIP-on-feature-x__a3f2.patch
 *   |-prefix-|---timestamp---|--branch--|--cleansubject--|sha|
 *
 *   - 8-character index-of-stash prefix is dropped in favour of a SHA-
 *     stable salt so two stashes with the same subject + branch get
 *     unique files.
 *   - Subjects are slug-normalised (lowercase, [a-z0-9-], 30-char cap)
 *     so a stash named "Refactor: extract user fetch (#42)" becomes
 *     `refactor-extract-user-fetch-42`.
 *   - Branch is sanitised the same way (e.g. `release/2026.q2` ->
 *     `release-2026-q2`).
 *   - Total filename length capped at 200 chars to leave headroom for
 *     long OS paths.
 *
 * Pure - no fs, no child_process, no vscode. Tests in
 * test/git/stashPatchExport.test.ts.
 */

import { Stash } from './git';
import { StashCandidate } from './stashTrash';

const FILENAME_PREFIX = 'gitsight-stash';
const FILENAME_EXT = '.patch';
const MAX_FILENAME_LENGTH = 200;

/**
 * Compute a stable salt for the filename: the first 6 chars of a
 * cheap hash over (stash.ref + subject). NOT a security hash - just a
 * fingerprint that survives a reflog renumber so two patches in the
 * same export dir don't accidentally collide.
 */
function fingerprint(stash: Stash): string {
  // FNV-1a 32-bit - same trick as the F61 commitGraphExport salt.
  let h = 0x811c9dc5;
  const s = `${stash.ref}|${stash.subject}|${stash.date instanceof Date ? stash.date.toISOString() : ''}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

export interface DeriveFilenameArgs {
  stash: Stash;
  /** Subject after F67's cleanStashSubject (no "WIP on branch:" prefix). */
  cleanSubject?: string;
  /** Source branch as extracted by F67 (may be empty). */
  sourceBranch?: string;
  /** Caller-provided now() for timestamping. */
  now?: Date;
}

export function deriveStashPatchFilename(args: DeriveFilenameArgs): string {
  const now = args.now ?? new Date();
  const ts = formatTimestamp(now);
  const subjectSlug = sanitiseFilenameComponent(args.cleanSubject || args.stash.subject || 'stash', 30);
  const branchSlug = args.sourceBranch
    ? sanitiseFilenameComponent(args.sourceBranch, 30)
    : '';
  const fp = fingerprint(args.stash);
  let parts: string[] = [FILENAME_PREFIX, ts];
  if (branchSlug) parts.push(`on-${branchSlug}`);
  if (subjectSlug && subjectSlug !== branchSlug) parts.push(subjectSlug);
  parts.push(fp);
  let name = parts.join('__') + FILENAME_EXT;
  if (name.length > MAX_FILENAME_LENGTH) {
    // Trim the subject component first (highest variance), then fall
    // back to a minimal name with just timestamp + fingerprint.
    parts = [FILENAME_PREFIX, ts];
    if (branchSlug) parts.push(`on-${branchSlug}`);
    parts.push(fp);
    name = parts.join('__') + FILENAME_EXT;
    if (name.length > MAX_FILENAME_LENGTH) {
      name = `${FILENAME_PREFIX}__${ts}__${fp}${FILENAME_EXT}`;
    }
  }
  return name;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Slug-normalise a free-form string for filesystem safety.
 *   - lowercase
 *   - replace any non [a-z0-9] with `-`
 *   - collapse runs of `-`
 *   - strip leading/trailing `-`
 *   - cap at `maxLen` chars (no trailing dash after the cut)
 */
export function sanitiseFilenameComponent(input: string, maxLen: number): string {
  if (!input) return '';
  let s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/-+$/, '');
  return s;
}

/**
 * Validate that a derived filename is safe across all common
 * filesystems (FAT32-conservative: no <, >, :, ", /, \, |, ?, *,
 * reserved Windows names, no trailing dot/space).
 *
 * Returns the issue when unsafe; undefined when safe.
 */
export function validateFilename(name: string): string | undefined {
  if (!name) return 'empty filename';
  if (name.length > MAX_FILENAME_LENGTH) return `filename exceeds ${MAX_FILENAME_LENGTH} chars`;
  if (/[\x00-\x1f<>:"/\\|?*]/.test(name)) return 'filename contains illegal characters';
  if (/[. ]$/.test(name)) return 'filename ends with a dot or space';
  // Windows reserved names (case-insensitive, with or without extension).
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) return 'filename is a Windows reserved name';
  return undefined;
}

/**
 * Decide which stashes should be patch-exported before dropping. A
 * stash is worth exporting when its patch carries information that
 * would otherwise be lost - heuristics:
 *
 *   - Named stashes (created with `git stash push -m`) - the user
 *     attached intent, so the patch is more likely to be meaningful.
 *   - Stashes >= 30 days old - if it's been sitting that long, you
 *     might come back to it weeks later wondering "what was that?".
 *   - Stashes from a branch that's now gone - if the source branch
 *     was deleted, this is the only artefact of the work.
 *
 * Returns ranked candidates with a hint per stash explaining WHY it
 * was flagged. The caller decides whether to default-pick the whole
 * set or just the "high-value" sub-set.
 */
export type ExportRationale = 'named' | 'branch-gone' | 'ancient' | 'stale' | 'low-value';

export interface PatchExportCandidate {
  candidate: StashCandidate;
  rationale: ExportRationale;
  rationaleNote: string;
  /** Suggested filename for this stash's patch. */
  filename: string;
  /** Heuristic priority: 'export' (pre-tick) vs 'optional' (let the user choose). */
  priority: 'export' | 'optional';
}

export function buildExportPlan(
  candidates: StashCandidate[],
  now: Date,
): PatchExportCandidate[] {
  return candidates.map(c => {
    const filename = deriveStashPatchFilename({
      stash: c.stash,
      cleanSubject: c.cleanSubject,
      sourceBranch: c.sourceBranch,
      now,
    });
    let rationale: ExportRationale;
    let rationaleNote: string;
    let priority: 'export' | 'optional';
    if (c.named) {
      rationale = 'named';
      rationaleNote = 'created with `git stash push -m`, intent attached';
      priority = 'export';
    } else if (c.sourceBranchGone) {
      rationale = 'branch-gone';
      rationaleNote = 'source branch is no longer in local refs';
      priority = 'export';
    } else if (c.ageBucket === 'ancient') {
      rationale = 'ancient';
      rationaleNote = '>= 180 days old, context likely lost';
      priority = 'export';
    } else if (c.ageBucket === 'stale') {
      rationale = 'stale';
      rationaleNote = 'past staleAfterDays threshold';
      priority = 'optional';
    } else {
      rationale = 'low-value';
      rationaleNote = 'fresh + unnamed - patch is probably noise';
      priority = 'optional';
    }
    return { candidate: c, rationale, rationaleNote, filename, priority };
  });
}

/**
 * Format the export-plan summary for the picker placeholder.
 *
 *   "5 stashes - 3 to export, 2 optional"
 *   "no stashes selected"
 */
export interface ExportPlanSummary {
  total: number;
  exportPriority: number;
  optionalPriority: number;
}

export function summariseExportPlan(plan: PatchExportCandidate[]): ExportPlanSummary {
  const total = plan.length;
  let exp = 0, opt = 0;
  for (const p of plan) {
    if (p.priority === 'export') exp++;
    else opt++;
  }
  return { total, exportPriority: exp, optionalPriority: opt };
}

export function describeExportPlan(s: ExportPlanSummary): string {
  if (s.total === 0) return 'no stashes to export';
  const word = s.total === 1 ? 'stash' : 'stashes';
  return `${s.total} ${word} - ${s.exportPriority} to export, ${s.optionalPriority} optional`;
}

/**
 * Build the markdown report listing the exported patches + their
 * source stash + a per-row "why" column. Written alongside the patch
 * files as an index so a future you can ungrep `grep -l <subject>
 * *.patch` to find the right one.
 */
export function buildExportReport(args: {
  plan: PatchExportCandidate[];
  exportedFilenames: string[];
  failures: Array<{ filename: string; error: string }>;
  now: Date;
  exportDir: string;
}): string {
  const lines: string[] = [];
  lines.push('# Stash Patch Export Report');
  lines.push('');
  lines.push(`_Generated ${formatTimestamp(args.now)} - ${args.exportDir}_`);
  lines.push('');
  const exported = new Set(args.exportedFilenames);
  if (args.plan.length === 0) {
    lines.push('_No stashes processed._');
    return lines.join('\n');
  }
  lines.push('| Stash | Subject | Branch | Reason | File |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of args.plan) {
    const file = exported.has(p.filename)
      ? `\`${escapePipe(p.filename)}\``
      : args.failures.find(f => f.filename === p.filename)
        ? `_failed: ${escapePipe(args.failures.find(f => f.filename === p.filename)!.error)}_`
        : '_skipped_';
    lines.push(
      `| \`${escapePipe(p.candidate.stash.ref)}\` | ${escapePipe(p.candidate.cleanSubject || '-')} | ${escapePipe(p.candidate.sourceBranch ?? '-')} | ${p.rationale} | ${file} |`,
    );
  }
  return lines.join('\n');
}

function escapePipe(s: string): string { return (s ?? '').replace(/\|/g, '\\|'); }
