/**
 * Pure diff-presentation helpers (W7).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The
 * DOM renderer (diffView.ts) imports these. Imports the shared FileDiff
 * types via a relative .ts path so Node resolves them at test time
 * without the @shared Vite alias.
 *
 * Tests: web/src/diffFormat.test.mjs
 */

import type { FileDiff, DiffLine } from '../../src/shared/diffParse.ts';

/** Gutter cell text for the old/new columns of a diff line. */
export function gutterFor(line: DiffLine): { old: string; new: string } {
  return {
    old: line.oldLine === null ? '' : String(line.oldLine),
    new: line.newLine === null ? '' : String(line.newLine),
  };
}

/** The +/-/space sign for a diff line's content column. */
export function signFor(line: DiffLine): string {
  return line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
}

/** A compact `+N -M` / `binary` summary for a file's diff header. */
export function diffHeaderStat(file: FileDiff): string {
  if (file.binary) return 'binary';
  const parts: string[] = [];
  if (file.additions > 0) parts.push(`+${file.additions}`);
  if (file.deletions > 0) parts.push(`-${file.deletions}`);
  return parts.join(' ') || 'no changes';
}
