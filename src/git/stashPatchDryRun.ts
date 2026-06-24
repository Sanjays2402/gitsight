/**
 * Pure helpers for F141 - Stash patch import dry-run preview.
 *
 * Composes with F131 (stashPatchImport). Before running the real
 * `git apply --3way <patch>` that mutates the working tree, this
 * module formalises the output of two probe commands:
 *
 *   1. `git apply --check <patch>`  ->  pure verdict whether the
 *      patch would apply cleanly without conflicts.
 *   2. `git apply --stat <patch>`   ->  per-file line counts (the
 *      classic +/-/= visualisation rendered by git itself).
 *
 * Why bother with a dry-run separate from the F131 confirm step?
 * Because F131's confirm only shows the metadata pulled from the
 * patch HEADER (file count, source branch, subject). The dry-run
 * tells you whether the working tree is actually in a state to
 * accept the patch -- a stash from 6 weeks ago against a branch
 * that's since had heavy edits will fail --check + give the user a
 * heads-up that they're heading for conflicts.
 *
 * Pure - no fs, no vscode, no child_process. The view layer owns
 * spawning the probes and feeding the outputs into these helpers.
 *
 * Tests in test/git/stashPatchDryRun.test.ts.
 */

export type DryRunVerdict =
  | 'clean'           // --check returned 0, no conflicts expected
  | 'conflicts'       // --check failed but the failure looks recoverable via --3way
  | 'rejected'        // --check failed and there's no obvious 3-way base
  | 'invalid'         // patch body is malformed (--check parse error)
  | 'unknown';        // probes didn't run / output unreadable

export interface DryRunCheckArgs {
  /** Exit code from `git apply --check <patch>`. */
  exitCode: number;
  /** Stderr from `git apply --check <patch>`. */
  stderr: string;
}

export interface DryRunCheckResult {
  verdict: DryRunVerdict;
  /** Per-file conflict hints when present. */
  conflictedFiles: string[];
  /** First non-empty stderr line, useful for the picker subtitle. */
  reason: string;
}

const CHECK_HUNK_FAIL_RX = /(?:error:\s*)?patch failed:\s*(.+?):(\d+)/g;
const CHECK_INVALID_RX = /(?:fatal|error):\s*(?:corrupt patch|unrecognized input|garbage at|invalid line)/i;
const CHECK_NO_3WAY_RX = /(?:repository lacks the necessary blob|sha1 information is lacking|cannot apply binary patch)/i;
const CHECK_DOES_NOT_APPLY_RX = /patch does not apply/i;
const CHECK_FILE_FAIL_RX = /^(?:error|patch).*?(?:in|on)\s+(?:file\s+)?([^\s:]+)/gim;

/**
 * Classify the output of `git apply --check <patch>` into a verdict
 * + per-file conflict hints. The view layer can use the verdict to
 * gate the confirm dialog (clean -> default-pick Apply; conflicts ->
 * default-pick Cancel + warning copy).
 */
export function classifyDryRunCheck(args: DryRunCheckArgs): DryRunCheckResult {
  const stderr = (args.stderr ?? '').toString();
  if (args.exitCode === 0) {
    return {
      verdict: 'clean',
      conflictedFiles: [],
      reason: 'patch applies cleanly',
    };
  }
  if (CHECK_INVALID_RX.test(stderr)) {
    return {
      verdict: 'invalid',
      conflictedFiles: [],
      reason: firstStderrLine(stderr) ?? 'patch body looks corrupt',
    };
  }
  const conflictedFiles = extractConflictedFiles(stderr);
  if (CHECK_NO_3WAY_RX.test(stderr)) {
    return {
      verdict: 'rejected',
      conflictedFiles,
      reason: firstStderrLine(stderr) ?? 'no 3-way base available',
    };
  }
  if (conflictedFiles.length > 0 || CHECK_DOES_NOT_APPLY_RX.test(stderr)) {
    return {
      verdict: 'conflicts',
      conflictedFiles,
      reason: conflictedFiles.length > 0
        ? `${conflictedFiles.length} file${conflictedFiles.length === 1 ? '' : 's'} would conflict`
        : (firstStderrLine(stderr) ?? 'patch hunks would not apply cleanly'),
    };
  }
  return {
    verdict: 'unknown',
    conflictedFiles: [],
    reason: firstStderrLine(stderr) ?? 'unable to classify dry-run output',
  };
}

function extractConflictedFiles(stderr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const hunkRx = new RegExp(CHECK_HUNK_FAIL_RX.source, CHECK_HUNK_FAIL_RX.flags);
  while ((m = hunkRx.exec(stderr)) !== null) {
    const file = (m[1] ?? '').trim();
    if (!file) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
  }
  // Secondary: catch `error: ... in <file>` style lines that don't
  // include a hunk number. Only used when the hunk regex found nothing.
  if (out.length === 0) {
    const fileRx = new RegExp(CHECK_FILE_FAIL_RX.source, CHECK_FILE_FAIL_RX.flags);
    while ((m = fileRx.exec(stderr)) !== null) {
      const file = (m[1] ?? '').trim();
      if (!file) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
      if (out.length >= 20) break; // bound for the picker
    }
  }
  return out;
}

function firstStderrLine(stderr: string): string | undefined {
  return stderr.split('\n').map(s => s.trim()).find(Boolean);
}

// ── --stat parsing ─────────────────────────────────────────────────────

export interface DryRunStatRow {
  /** File path as it appears in the --stat output. */
  path: string;
  /** Total change lines (insertions + deletions). */
  totalLines: number;
  /** Inserted lines (the `+` count). */
  insertions: number;
  /** Deleted lines (the `-` count). */
  deletions: number;
  /** True when --stat reported a binary file ("Bin 0 -> 12 bytes"). */
  binary: boolean;
}

export interface DryRunStatSummary {
  rows: DryRunStatRow[];
  totalInsertions: number;
  totalDeletions: number;
  /** True when at least one row had binary=true. */
  hasBinary: boolean;
  /** Summary footer line as git reports it
   *  ("3 files changed, 12 insertions(+), 4 deletions(-)") when found. */
  footer?: string;
}

const STAT_BINARY_RX = /^\s*(.+?)\s+\|\s*Bin\s+(\d+)\s*->\s*(\d+)\s+bytes\s*$/;
const STAT_TEXT_RX = /^\s*(.+?)\s+\|\s*(\d+)\s+([+\-]*)\s*$/;
const STAT_FOOTER_RX = /^\s*\d+\s+files?\s+changed/;

/**
 * Parse the output of `git apply --stat <patch>` into structured rows.
 *
 * The --stat shape mirrors `git diff --stat` so we get e.g.:
 *
 *   src/foo.ts | 12 ++++++++++--
 *   docs/x.md  |  4 ++--
 *   img/x.png  | Bin 0 -> 1234 bytes
 *    3 files changed, 14 insertions(+), 4 deletions(-)
 *
 * Robust to:
 *   - leading whitespace / variable column padding
 *   - binary file marker
 *   - both `+--` and `--++` order in the bar (matches `git diff -M`)
 *   - file paths that contain spaces (rare but possible)
 */
export function parseDryRunStat(output: string): DryRunStatSummary {
  const rows: DryRunStatRow[] = [];
  let footer: string | undefined;
  let totalInsertions = 0;
  let totalDeletions = 0;
  let hasBinary = false;
  for (const rawLine of (output ?? '').split('\n')) {
    if (!rawLine.trim()) continue;
    if (STAT_FOOTER_RX.test(rawLine)) {
      footer = rawLine.trim();
      continue;
    }
    const binMatch = STAT_BINARY_RX.exec(rawLine);
    if (binMatch) {
      const path = binMatch[1].trim();
      if (!path) continue;
      rows.push({
        path,
        totalLines: 0,
        insertions: 0,
        deletions: 0,
        binary: true,
      });
      hasBinary = true;
      continue;
    }
    const textMatch = STAT_TEXT_RX.exec(rawLine);
    if (textMatch) {
      const path = textMatch[1].trim();
      if (!path) continue;
      const totalLines = Number.parseInt(textMatch[2], 10) || 0;
      const bar = textMatch[3] ?? '';
      // The bar is a visual; count +/- chars proportionally.
      const plusCount = (bar.match(/\+/g) || []).length;
      const minusCount = (bar.match(/-/g) || []).length;
      const charTotal = plusCount + minusCount;
      let insertions = 0;
      let deletions = 0;
      if (charTotal === 0) {
        // No bar visible (git scales the bar so very small changes
        // can render as empty); fall back to "all insertions".
        insertions = totalLines;
      } else {
        insertions = Math.round((plusCount / charTotal) * totalLines);
        deletions = totalLines - insertions;
      }
      totalInsertions += insertions;
      totalDeletions += deletions;
      rows.push({
        path,
        totalLines,
        insertions,
        deletions,
        binary: false,
      });
      continue;
    }
    // Unknown line: ignore - probably a git progress noise.
  }
  return {
    rows,
    totalInsertions,
    totalDeletions,
    hasBinary,
    footer,
  };
}

// ── Composite report ───────────────────────────────────────────────────

export interface DryRunReportArgs {
  filename: string;
  check: DryRunCheckResult;
  stat: DryRunStatSummary;
  /** Optional GitSight stamp data from the F131 parseGitSightFilename helper. */
  meta?: { sourceBranch?: string; subject?: string; date?: string };
}

/**
 * One-line summary used as the picker subtitle. Example outputs:
 *
 *   "Dry-run: clean - 3 files, +12 -4"
 *   "Dry-run: 2 files would conflict (src/foo.ts, src/bar.ts)"
 *   "Dry-run: rejected - no 3-way base available"
 */
export function describeDryRun(args: { verdict: DryRunVerdict; stat: DryRunStatSummary; conflictedFiles: string[]; reason?: string }): string {
  const fileCount = args.stat.rows.length;
  const sizeBlurb = fileCount > 0
    ? `${fileCount} file${fileCount === 1 ? '' : 's'}, +${args.stat.totalInsertions} -${args.stat.totalDeletions}`
    : 'no file changes detected';
  switch (args.verdict) {
    case 'clean':
      return `Dry-run: clean - ${sizeBlurb}`;
    case 'conflicts': {
      const sample = args.conflictedFiles.slice(0, 2).join(', ');
      const more = args.conflictedFiles.length > 2 ? ` +${args.conflictedFiles.length - 2} more` : '';
      return args.conflictedFiles.length > 0
        ? `Dry-run: ${args.conflictedFiles.length} file${args.conflictedFiles.length === 1 ? '' : 's'} would conflict (${sample}${more})`
        : `Dry-run: hunks would not apply cleanly`;
    }
    case 'rejected':
      return `Dry-run: rejected - ${args.reason ?? 'no recovery available'}`;
    case 'invalid':
      return `Dry-run: invalid patch - ${args.reason ?? 'malformed body'}`;
    case 'unknown':
      return `Dry-run: ${args.reason ?? 'verdict unavailable'}`;
  }
}

/**
 * Full markdown rendering for the preview document.
 */
export function buildDryRunReport(args: DryRunReportArgs): string {
  const lines: string[] = [];
  const base = (args.filename.split('/').pop() ?? args.filename) || 'patch';
  lines.push(`# Dry-run: \`${base}\``);
  lines.push('');
  if (args.meta?.sourceBranch || args.meta?.date) {
    const bits: string[] = [];
    if (args.meta.date) bits.push(args.meta.date);
    if (args.meta.sourceBranch) bits.push(`on \`${args.meta.sourceBranch}\``);
    if (args.meta.subject) bits.push(`subject: ${args.meta.subject}`);
    lines.push(`_${bits.join(' \u00b7 ')}_`);
    lines.push('');
  }
  lines.push(`Verdict: **${verdictHeadline(args.check.verdict)}**`);
  if (args.check.reason) {
    lines.push('');
    lines.push(`> ${args.check.reason}`);
  }
  lines.push('');
  if (args.stat.rows.length > 0) {
    lines.push('## Files this patch touches');
    lines.push('');
    lines.push('| File | +/- | Lines |');
    lines.push('|------|-----|-------|');
    for (const r of args.stat.rows) {
      if (r.binary) {
        lines.push(`| \`${r.path}\` | binary | - |`);
      } else {
        lines.push(`| \`${r.path}\` | +${r.insertions} / -${r.deletions} | ${r.totalLines} |`);
      }
    }
    lines.push('');
    if (args.stat.footer) {
      lines.push(`_${args.stat.footer}_`);
      lines.push('');
    }
  } else {
    lines.push('_No file changes detected from --stat (patch may have been empty or only metadata)._');
    lines.push('');
  }
  if (args.check.conflictedFiles.length > 0) {
    lines.push('## Conflicted files (--check)');
    lines.push('');
    for (const f of args.check.conflictedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }
  lines.push('## Next step');
  lines.push('');
  switch (args.check.verdict) {
    case 'clean':
      lines.push('Patch applies cleanly. The Apply button runs `git apply --3way` for you.');
      break;
    case 'conflicts':
      lines.push('Patch hunks do not match the working tree exactly. Applying with `--3way` will leave conflict markers GitSight can route to the conflict coach.');
      break;
    case 'rejected':
      lines.push('Patch is unlikely to apply. Consider re-creating it against the current branch, or open it as a reference and re-author the changes manually.');
      break;
    case 'invalid':
      lines.push('Patch body looks malformed (`git apply --check` rejected it). Open the file in the editor to inspect.');
      break;
    case 'unknown':
      lines.push('Dry-run probes returned without a clear verdict. The Apply action will run `git apply --3way` regardless; review the output closely.');
      break;
  }
  return lines.join('\n');
}

function verdictHeadline(v: DryRunVerdict): string {
  switch (v) {
    case 'clean':     return 'CLEAN - safe to apply';
    case 'conflicts': return 'CONFLICTS - applying via --3way will leave markers';
    case 'rejected':  return 'REJECTED - patch will not apply';
    case 'invalid':   return 'INVALID - patch body looks corrupt';
    case 'unknown':   return 'UNKNOWN - verdict unavailable';
  }
}

/**
 * Should the confirm dialog default to "Apply" or "Cancel"?
 *
 *   - 'clean'              -> default Apply (safe)
 *   - 'conflicts'          -> default Cancel (warn explicitly)
 *   - 'rejected'/'invalid' -> default Cancel + hard warning copy
 *   - 'unknown'            -> default Cancel (be conservative)
 *
 * The view layer reads this verdict to pick the modal button order
 * + the warning severity (warning vs error message).
 */
export type ApplyDefaultButton = 'apply' | 'cancel';

export function defaultApplyButton(verdict: DryRunVerdict): ApplyDefaultButton {
  return verdict === 'clean' ? 'apply' : 'cancel';
}

/**
 * Should we even surface the Apply button on this dry-run verdict?
 * For 'invalid', the patch is corrupt enough that running --3way
 * could fail in unpredictable ways - we hide the Apply path to
 * push the user toward the editor-inspection escape hatch.
 */
export function shouldOfferApply(verdict: DryRunVerdict): boolean {
  return verdict !== 'invalid';
}
