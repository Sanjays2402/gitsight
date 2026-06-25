/**
 * Pure presentation helpers for the compare view (W18).
 *
 * DOM-free + vscode-free so they're unit-tested under node --test. The
 * compare view (compareView.ts) owns the DOM; the pure string/number
 * transforms live here. Imports the shared CompareFile type via a relative
 * .ts path so Node resolves it without the @shared Vite alias.
 *
 * Tests: web/src/compareFormat.test.mjs
 */

import type { CompareFile, CompareFileStatus } from '../../src/shared/rangeCompare.ts';

/** Single-letter glyph for a compare file status (monochrome chrome). */
export function compareGlyph(status: CompareFileStatus): string {
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
    default:
      return '?';
  }
}

/** Human label for a compare file status (tooltip / aria). */
export function compareLabel(status: CompareFileStatus): string {
  return status === 'typechange' ? 'type change' : status;
}

/** Churn cell parts for one compare file: `+N -M`, `binary`, or `0`. */
export interface CompareChurn {
  binary: boolean;
  insertions: number;
  deletions: number;
  text: string;
}

export function compareChurn(file: CompareFile): CompareChurn {
  if (file.binary) return { binary: true, insertions: 0, deletions: 0, text: 'binary' };
  const ins = Math.max(0, file.insertions);
  const del = Math.max(0, file.deletions);
  const segs: string[] = [];
  if (ins > 0) segs.push(`+${ins}`);
  if (del > 0) segs.push(`-${del}`);
  return { binary: false, insertions: ins, deletions: del, text: segs.length ? segs.join(' ') : '0' };
}

/** Split a path into directory + filename (dim dir, emphasise base). */
export function splitComparePath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * Normalise + validate a user-entered ref so a stray flag/space can't be
 * smuggled toward the companion (which also guards via isSafeRev, but a
 * client-side check gives instant feedback). Returns the trimmed ref or
 * null when it's empty / obviously unsafe.
 */
export function sanitizeRef(ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  if (/[\s]/.test(r)) return null;
  if (r.startsWith('-')) return null;
  if (r.length > 200) return null;
  return r;
}
