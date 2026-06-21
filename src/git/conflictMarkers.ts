/**
 * Pure helpers for detecting unresolved Git conflict markers in a text buffer.
 * gitsight-disable-conflict-marker (this file legitimately contains marker
 * strings in comments + regex literals).
 *
 * Git writes three line types into a conflicted file:
 *
 *   <<<<<<< HEAD               (or any ref name after the `<<<<<<< `)
 *   ours content here
 *   |||||||  merge-base        (only present with --diff3 style)
 *   base content
 *   =======                    (separator, exactly seven `=` to the line)
 *   theirs content here
 *   >>>>>>> feature/x          (or any ref name after the `>>>>>>> `)
 *
 * The classic "I forgot to resolve a conflict" symptom is shipping a file
 * with one of those markers still in place. This module finds them so the
 * controller can raise diagnostics + jump-to-next-conflict commands.
 *
 * Strictly pure — no vscode, no fs, no child_process.
 */

export type ConflictMarkerKind = 'start' | 'base' | 'separator' | 'end';

export interface ConflictMarker {
  /** Zero-based line number of the marker. */
  line: number;
  kind: ConflictMarkerKind;
  /** The ref-name written after the marker (HEAD, branch, etc.); empty for `=======`. */
  refName: string;
}

export interface ConflictBlock {
  /** Line of the `<<<<<<<` marker (zero-based). */
  startLine: number;
  /** Line of the `=======` separator, or `-1` when the block is malformed. */
  separatorLine: number;
  /** Line of the `>>>>>>>` marker, or `-1` when missing. */
  endLine: number;
  /** Line of the `|||||||` marker for diff3-style merges, or `-1` when absent. */
  baseLine: number;
  /** Ref name after `<<<<<<<` (e.g. 'HEAD'). */
  oursRef: string;
  /** Ref name after `>>>>>>>`, or empty when missing. */
  theirsRef: string;
}

// Anchored to start-of-line. We require the marker to be exactly seven of the
// glyph followed by whitespace OR end-of-line; this lets us ignore documentation
// pages that quote `<<<<<<< HEAD` in prose without actually being conflicts —
// most prose quoting renders these inside code fences, which we don't see here,
// but we still want to avoid matching strings like `<<<<<<<<<<` (10 angle
// brackets) which is sometimes used as a visual separator.
const START_RE = /^<{7}(?:[ \t]+(.*))?$/;
const BASE_RE = /^\|{7}(?:[ \t]+(.*))?$/;
const SEP_RE = /^={7}$/;
const END_RE = /^>{7}(?:[ \t]+(.*))?$/;

export function findMarkers(text: string): ConflictMarker[] {
  const out: ConflictMarker[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = stripTrailingCR(lines[i]);
    let m: RegExpExecArray | null;
    if ((m = START_RE.exec(l))) out.push({ line: i, kind: 'start', refName: (m[1] ?? '').trim() });
    else if ((m = BASE_RE.exec(l))) out.push({ line: i, kind: 'base', refName: (m[1] ?? '').trim() });
    else if (SEP_RE.test(l)) out.push({ line: i, kind: 'separator', refName: '' });
    else if ((m = END_RE.exec(l))) out.push({ line: i, kind: 'end', refName: (m[1] ?? '').trim() });
  }
  return out;
}

function stripTrailingCR(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/**
 * Group markers into well-formed (or malformed-but-recognisable) conflict
 * blocks. A block starts at `<<<<<<<`, optionally has a `|||||||` base, then
 * `=======`, then `>>>>>>>`. Markers between a start and the next start are
 * attributed to that block; markers that don't fit are dropped.
 */
export function groupBlocks(markers: ConflictMarker[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let current: ConflictBlock | undefined;
  for (const m of markers) {
    if (m.kind === 'start') {
      if (current) blocks.push(current); // close previous (malformed) block
      current = {
        startLine: m.line,
        separatorLine: -1,
        endLine: -1,
        baseLine: -1,
        oursRef: m.refName,
        theirsRef: '',
      };
    } else if (!current) {
      continue; // stray separator/end before any start — ignore
    } else if (m.kind === 'base' && current.baseLine === -1) {
      current.baseLine = m.line;
    } else if (m.kind === 'separator' && current.separatorLine === -1) {
      current.separatorLine = m.line;
    } else if (m.kind === 'end') {
      current.endLine = m.line;
      current.theirsRef = m.refName;
      blocks.push(current);
      current = undefined;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Convenience: full pipeline in one call. */
export function findConflicts(text: string): ConflictBlock[] {
  return groupBlocks(findMarkers(text));
}

/** True when the block is well-formed (start + separator + end, in order). */
export function isWellFormed(b: ConflictBlock): boolean {
  return b.startLine >= 0
    && b.separatorLine > b.startLine
    && b.endLine > b.separatorLine;
}

/**
 * Given the current zero-based caret line and a list of conflict blocks
 * sorted by `startLine`, return the start line of the next conflict to jump
 * to. When the caret is past the last block, wrap to the first. Returns
 * `undefined` when there are no blocks.
 */
export function nextBlockLine(caretLine: number, blocks: ConflictBlock[]): number | undefined {
  if (!blocks.length) return undefined;
  for (const b of blocks) {
    if (b.startLine > caretLine) return b.startLine;
  }
  return blocks[0].startLine;
}

/** Mirror of `nextBlockLine` for backwards traversal. */
export function previousBlockLine(caretLine: number, blocks: ConflictBlock[]): number | undefined {
  if (!blocks.length) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].startLine < caretLine) return blocks[i].startLine;
  }
  return blocks[blocks.length - 1].startLine;
}
