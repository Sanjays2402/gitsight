/**
 * Pure helpers for F131 - Stash Patch Import (companion to F127 export).
 *
 * Reads a `.patch` file and prepares to apply it via `git apply --3way`,
 * with structured error classification so the view layer can route to
 * the F107 conflict-coach on conflict failures rather than just dumping
 * stderr.
 *
 * Pure - no fs, no vscode, no child_process. The view layer owns the
 * filesystem reads + git command invocation; this module owns:
 *   - Patch payload validation (is this a real patch?)
 *   - GitSight-stamped filename recognition (read the metadata header
 *     so we can pre-fill confidence about which branch this came from)
 *   - `git apply` error classification (5-state verdict)
 *   - Picker label / detail formatting
 *
 * Tests in test/git/stashPatchImport.test.ts.
 */

export interface PatchPayloadInfo {
  /** True when the body looks like a `git format-patch` / `git diff`
   *  output. We're lenient about exact shape - GitHub-style raw diffs,
   *  format-patch with mailbox header, gitsight-stamped exports all
   *  count. */
  looksValid: boolean;
  /** Number of `diff --git` markers in the body (file count). */
  fileCount: number;
  /** True when the patch carries any binary-file markers (`Binary files
   *  ... differ`). The view layer surfaces a hint that `--3way` may
   *  not behave as expected on binaries. */
  hasBinary: boolean;
  /** Trimmed first non-empty subject line if found (e.g. "From: ..."
   *  or "Subject: ..." or a comment line). Used for the preview detail. */
  firstLine: string;
  /** GitSight stamp data if the file was originally exported via F127. */
  gitsightMeta?: GitSightPatchMeta;
}

export interface GitSightPatchMeta {
  /** Branch the patch was taken on (from the F127 filename or a
   *  GitSight-stamped header). */
  sourceBranch?: string;
  /** Subject extracted from the F127 stamp. */
  subject?: string;
  /** Date string from the F127 stamp. */
  date?: string;
}

const DIFF_MARKER_RX = /^diff --git /m;
const FILE_DIFF_RX = /^diff --git /gm;
const BINARY_FILE_RX = /^Binary files .* differ$/m;
const GITSIGHT_FILENAME_RX = /^gitsight-stash__(\d{4}-\d{2}-\d{2}-\d{4})__on-([\w\-/.]+?)__(.+?)__([0-9a-f]{6})\.patch$/i;
const FROM_HEADER_RX = /^From\s.+/m;
const SUBJECT_HEADER_RX = /^Subject:\s*(.+)$/m;

/**
 * Inspect a patch body and produce a structured report. The view layer
 * uses this to gate the "Apply" picker - a body that doesn't look
 * like a patch shouldn't reach `git apply --3way` at all.
 */
export function inspectPatchPayload(body: string, filename?: string): PatchPayloadInfo {
  const safe = (body ?? '').replace(/\r\n/g, '\n');
  const looksValid = DIFF_MARKER_RX.test(safe) || FROM_HEADER_RX.test(safe);
  const fileCount = (safe.match(FILE_DIFF_RX) || []).length;
  const hasBinary = BINARY_FILE_RX.test(safe);

  let firstLine = '';
  const subjectMatch = SUBJECT_HEADER_RX.exec(safe);
  if (subjectMatch) {
    firstLine = subjectMatch[1].trim();
  } else {
    for (const raw of safe.split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      firstLine = trimmed.slice(0, 200);
      break;
    }
  }

  const gitsightMeta = filename ? parseGitSightFilename(filename) : undefined;

  return {
    looksValid,
    fileCount,
    hasBinary,
    firstLine,
    gitsightMeta,
  };
}

/**
 * Parse a GitSight-stamped filename of the shape (F127):
 *   gitsight-stash__2026-06-23-1100__on-main__some-subject__abcdef.patch
 *
 * Returns the breadcrumbs for the preview. Unknown / non-conforming
 * filenames return undefined so the view falls back to plain inspection.
 */
export function parseGitSightFilename(filename: string): GitSightPatchMeta | undefined {
  if (!filename) return undefined;
  // Strip directory prefix - we only care about the basename.
  const base = filename.split('/').pop() ?? filename;
  const m = GITSIGHT_FILENAME_RX.exec(base);
  if (!m) return undefined;
  return {
    date: m[1],
    sourceBranch: m[2],
    subject: m[3].replace(/-/g, ' '),
  };
}

/**
 * Classify the outcome of `git apply --3way <patch>`. Maps stderr
 * + exit code into a 5-state verdict so the view layer can choose
 * the right recovery surface.
 *
 *   - 'applied'        -> success, no further action needed
 *   - 'applied-with-conflicts' -> 3-way applied but left conflict
 *                                 markers - hook the F107 conflict coach
 *   - 'rejected'       -> `git apply` couldn't even attempt because
 *                         hunks don't match (no 3-way recovery available)
 *   - 'already-applied'-> the patch's changes are already present
 *   - 'failed'         -> any other failure (corrupt patch, IO error)
 */
export type ApplyOutcome =
  | 'applied'
  | 'applied-with-conflicts'
  | 'rejected'
  | 'already-applied'
  | 'failed';

export interface ApplyClassification {
  outcome: ApplyOutcome;
  /** Short user-facing reason - the picker shows this as the result line. */
  reason: string;
  /** Conflicted file paths extracted from stderr when present. The view
   *  feeds these to the conflict-coach so the user lands on the right
   *  file. */
  conflictedFiles: string[];
}

export interface ClassifyApplyArgs {
  exitCode: number;
  stderr: string;
}

const CONFLICT_RX = /(?:Applied patch .+ with conflicts|U\s+([^\s]+)|<<<<<<<|fell back on 3-way merge)/i;
const ALREADY_APPLIED_RX = /(?:patch does not apply|patch.*already applied|reverse|skipping patch)/i;
const REJECTED_RX = /(?:patch failed|patch does not apply|hunk #?\d+ failed|trailing whitespace)/i;
const APPLY_TO_FILE_RX = /^(?:U|CONFLICT \([^)]+\):)\s+(.+)$/gm;
// `git apply -3way` lists conflicting files with `U <path>` in stdout/stderr.

export function classifyApplyResult(args: ClassifyApplyArgs): ApplyClassification {
  const stderr = (args.stderr ?? '').toString();
  const conflictedFiles = extractConflictedFiles(stderr);

  if (args.exitCode === 0) {
    if (conflictedFiles.length > 0 || /with conflicts|fell back on 3-way/i.test(stderr)) {
      return {
        outcome: 'applied-with-conflicts',
        reason: `applied with conflicts in ${conflictedFiles.length} file${conflictedFiles.length === 1 ? '' : 's'}`,
        conflictedFiles,
      };
    }
    return {
      outcome: 'applied',
      reason: 'applied cleanly',
      conflictedFiles: [],
    };
  }

  // Non-zero exit code paths.
  if (CONFLICT_RX.test(stderr) && conflictedFiles.length > 0) {
    return {
      outcome: 'applied-with-conflicts',
      reason: `applied with conflicts in ${conflictedFiles.length} file${conflictedFiles.length === 1 ? '' : 's'}`,
      conflictedFiles,
    };
  }
  if (ALREADY_APPLIED_RX.test(stderr) && !REJECTED_RX.test(stderr)) {
    return {
      outcome: 'already-applied',
      reason: 'patch contents already present in worktree',
      conflictedFiles: [],
    };
  }
  if (REJECTED_RX.test(stderr)) {
    return {
      outcome: 'rejected',
      reason: 'patch hunks do not match - no 3-way base available',
      conflictedFiles: [],
    };
  }
  // Generic failure - dump the first stderr line.
  const firstLine = stderr.split('\n').map(s => s.trim()).find(Boolean) ?? 'unknown error';
  return {
    outcome: 'failed',
    reason: firstLine.slice(0, 200),
    conflictedFiles: [],
  };
}

function extractConflictedFiles(stderr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const rx = new RegExp(APPLY_TO_FILE_RX.source, APPLY_TO_FILE_RX.flags);
  while ((m = rx.exec(stderr)) !== null) {
    const file = m[1].trim();
    if (!file) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  return out;
}

/**
 * Build the picker label for a candidate patch file. The view layer
 * scans a directory and feeds each `.patch` filename through this
 * helper to produce consistent labels.
 *
 * Shape (for a GitSight-stamped file):
 *   "gitsight-stash · 2026-06-23 · on main · 4 files"
 *
 * Shape (for a foreign patch file):
 *   "foo.patch · 3 files"
 */
export function buildPatchPickerLabel(filename: string, info: PatchPayloadInfo): string {
  const base = (filename.split('/').pop() ?? filename) || 'patch';
  const meta = info.gitsightMeta;
  const parts: string[] = [];
  if (meta) {
    parts.push('gitsight-stash');
    if (meta.date) parts.push(meta.date);
    if (meta.sourceBranch) parts.push(`on ${meta.sourceBranch}`);
  } else {
    parts.push(base);
  }
  if (info.fileCount > 0) {
    parts.push(`${info.fileCount} file${info.fileCount === 1 ? '' : 's'}`);
  }
  if (info.hasBinary) parts.push('contains binary');
  return parts.join(' \u00b7 ');
}

/**
 * One-line detail string for the picker (the second row under each
 * pickable). Combines the meta-extracted subject (when present) with
 * the first non-empty line of the payload.
 */
export function buildPatchPickerDetail(info: PatchPayloadInfo): string {
  const meta = info.gitsightMeta;
  if (meta?.subject) {
    return meta.subject.slice(0, 200);
  }
  return info.firstLine.slice(0, 200) || 'no subject';
}

/**
 * Sort patches in priority order:
 *   1. GitSight-stamped first (we know more about them).
 *   2. More files first (likely more important changes).
 *   3. Alphabetical fallback (stable order).
 *
 * Pure: takes the list of (filename, info) tuples + returns a sorted copy.
 */
export interface PatchCandidate {
  filename: string;
  info: PatchPayloadInfo;
}

export function sortPatchCandidates(candidates: PatchCandidate[]): PatchCandidate[] {
  return [...candidates].sort((a, b) => {
    const ga = a.info.gitsightMeta ? 1 : 0;
    const gb = b.info.gitsightMeta ? 1 : 0;
    if (ga !== gb) return gb - ga;
    if (a.info.fileCount !== b.info.fileCount) return b.info.fileCount - a.info.fileCount;
    return a.filename.localeCompare(b.filename);
  });
}
