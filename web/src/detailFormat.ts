/**
 * Pure presentation helpers for the commit-detail panel (W6).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The
 * panel module (detailPanel.ts) owns the DOM; everything that can be a
 * pure string/number transform lives here. Imports the shared
 * CommitDetail type via a relative .ts path so Node resolves it at test
 * time without the @shared Vite alias.
 *
 * Tests: web/src/detailFormat.test.mjs
 */

import type { FileChangeStatus, CommitFileChange } from '../../src/shared/commitDetail.ts';

/** Single-letter glyph for a file-change status (monochrome chrome). */
export function statusGlyph(status: FileChangeStatus): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typechange':
      return 'T';
    case 'unmerged':
      return 'U';
    default:
      return '?';
  }
}

/** Human label for a file-change status (tooltip / aria). */
export function statusLabel(status: FileChangeStatus): string {
  switch (status) {
    case 'typechange':
      return 'type change';
    case 'unmerged':
      return 'unmerged';
    default:
      return status;
  }
}

/**
 * Format the churn cell for one file: `+N -M`, `binary`, or `0` when a
 * file changed mode only. Returns the parts so the renderer can colour
 * the `+` and `-` independently.
 */
export interface ChurnParts {
  binary: boolean;
  insertions: number;
  deletions: number;
  /** Pre-rendered plain-text form for tooltips / tests. */
  text: string;
}

export function churnParts(file: CommitFileChange): ChurnParts {
  if (file.binary) {
    return { binary: true, insertions: 0, deletions: 0, text: 'binary' };
  }
  const ins = Math.max(0, file.insertions);
  const del = Math.max(0, file.deletions);
  const segs: string[] = [];
  if (ins > 0) segs.push(`+${ins}`);
  if (del > 0) segs.push(`-${del}`);
  return { binary: false, insertions: ins, deletions: del, text: segs.length ? segs.join(' ') : '0' };
}

/**
 * Split a path into directory + filename so the panel can dim the
 * directory and emphasise the basename (the Linear/Vercel file-row look).
 */
export function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/** One-line headline for the diffstat footer, e.g. "5 files +12 -3". */
export function diffstatSummary(
  filesChanged: number,
  insertions: number,
  deletions: number,
): string {
  const files = `${filesChanged} ${filesChanged === 1 ? 'file' : 'files'}`;
  const parts = [files];
  if (insertions > 0) parts.push(`+${insertions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join('  ');
}

/**
 * Compute a 0..1 fraction of insertions for a per-file split bar. Pure so
 * the bar geometry is testable. Binary / empty files return 0.5 (neutral).
 */
export function insertionRatio(file: CommitFileChange): number {
  if (file.binary) return 0.5;
  const ins = Math.max(0, file.insertions);
  const del = Math.max(0, file.deletions);
  const total = ins + del;
  if (total === 0) return 0.5;
  return ins / total;
}
