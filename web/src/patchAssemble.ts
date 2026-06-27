/**
 * Pure unified-diff / patch assembler (W52).
 *
 * DOM-free + framework-free, so it's unit-tested under node --test. The
 * compare view fetches each changed file's parsed FileDiff (shared
 * diffParse) lazily; this module reassembles a set of FileDiffs back into a
 * git-style unified-diff patch text the user can copy and `git apply` /
 * paste into a review. It's the inverse of parseUnifiedDiff: emit the
 * `diff --git` stanza, the status/rename lines, the `---`/`+++` headers, and
 * each hunk's `@@` header + prefixed lines.
 *
 * Imports the shared FileDiff type via a relative .ts path so Node resolves
 * it without the @shared Vite alias (mirrors compareFormat.ts).
 *
 * Tests: web/src/patchAssemble.test.mjs
 */

import type { FileDiff, DiffHunk, DiffLine } from '../../src/shared/diffParse.ts';

/** The `a/`-prefixed old path for a file's patch header. */
function aPath(file: FileDiff): string {
  return file.status === 'added' ? '/dev/null' : `a/${file.oldPath}`;
}

/** The `b/`-prefixed new path for a file's patch header. */
function bPath(file: FileDiff): string {
  return file.status === 'deleted' ? '/dev/null' : `b/${file.path}`;
}

/** The `@@ -a,b +c,d @@ section` header line for a hunk. */
export function formatHunkHeader(hunk: DiffHunk): string {
  const left = `-${hunk.oldStart},${hunk.oldLines}`;
  const right = `+${hunk.newStart},${hunk.newLines}`;
  const head = `@@ ${left} ${right} @@`;
  return hunk.section ? `${head} ${hunk.section}` : head;
}

/** The single prefixed line ('+'/'-'/' ') for a diff line. */
export function formatDiffLine(line: DiffLine): string {
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  return `${sign}${line.text}`;
}

/**
 * Assemble one FileDiff into its patch stanza lines (no trailing newline).
 * Binary files emit a short marker stanza instead of hunks, matching git's
 * `Binary files a/x and b/y differ` shape so the patch stays well-formed.
 */
export function assembleFilePatch(file: FileDiff): string {
  const out: string[] = [];
  out.push(`diff --git a/${file.oldPath} b/${file.path}`);

  // Status / rename hints, mirroring what parseUnifiedDiff consumes.
  if (file.status === 'added') out.push('new file mode 100644');
  else if (file.status === 'deleted') out.push('deleted file mode 100644');
  else if (file.status === 'renamed') {
    out.push(`rename from ${file.oldPath}`, `rename to ${file.path}`);
  } else if (file.status === 'copied') {
    out.push(`copy from ${file.oldPath}`, `copy to ${file.path}`);
  }

  if (file.binary) {
    out.push(`Binary files ${aPath(file)} and ${bPath(file)} differ`);
    return out.join('\n');
  }

  // A rename/copy with no content change has no hunks — the rename lines
  // above are the whole stanza.
  if (file.hunks.length === 0) return out.join('\n');

  out.push(`--- ${aPath(file)}`, `+++ ${bPath(file)}`);
  for (const hunk of file.hunks) {
    out.push(formatHunkHeader(hunk));
    for (const line of hunk.lines) {
      out.push(formatDiffLine(line));
      if (line.noNewline) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n');
}

/**
 * Assemble a list of FileDiffs into a single patch blob (W52). Each file's
 * stanza is separated by a newline; the whole thing ends with one trailing
 * newline so it's a valid `git apply` target. Files with a null diff (binary
 * skipped, fetch failed) are dropped by the caller before this point.
 */
export function assemblePatch(files: FileDiff[]): string {
  if (files.length === 0) return '';
  return files.map(assembleFilePatch).join('\n') + '\n';
}

/**
 * A short headline for the copied-patch toast, e.g. "3 files, +40 -12".
 * Sums additions/deletions across the assembled files.
 */
export function patchSummary(files: FileDiff[]): string {
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.additions;
    del += f.deletions;
  }
  const fileWord = files.length === 1 ? 'file' : 'files';
  return `${files.length} ${fileWord}, +${add} -${del}`;
}
