/**
 * Pure helpers for the conflict resolution coach (F107).
 *
 * Composes with F78 stagedConflictGate (which flags conflict markers
 * in staged diffs) and F34 conflictMarkers (which finds markers in
 * arbitrary buffers). This module:
 *
 *   1. Takes a working-tree file body containing one or more conflict
 *      blocks.
 *   2. Extracts the OURS / BASE / THEIRS content for each block. (Base
 *      only present when the merge.conflictStyle is `diff3`.)
 *   3. Returns a structured ConflictExtraction[] that the view layer
 *      maps to three virtual documents for a 3-pane side-by-side view.
 *
 * It also exposes:
 *
 *   - mergeContent(extraction, choice): apply one of the four common
 *     resolutions (take ours / take theirs / take both ours-then-theirs /
 *     take both theirs-then-ours). Returns the new file body.
 *
 *   - classifyResolutionDifficulty(extraction): heuristic indicator
 *     (trivial / small / moderate / large) so the view can offer a
 *     "quick-resolve" path for trivial blocks (whitespace-only,
 *     identical sides, etc.).
 *
 * Pure - no fs, no vscode. Tests in test/git/conflictCoach.test.ts.
 */

import { findMarkers, groupBlocks, ConflictBlock } from './conflictMarkers';

export interface ConflictExtraction {
  block: ConflictBlock;
  /** OURS content (between `<<<<<<<` and `|||||||` or `=======`). */
  oursContent: string;
  /** BASE content (between `|||||||` and `=======`), empty when diff2 style. */
  baseContent: string;
  /** THEIRS content (between `=======` and `>>>>>>>`). */
  theirsContent: string;
  /** True when the block has a `|||||||` base (diff3 style). */
  hasBase: boolean;
  /** True when the conflict markers are well-formed (start + sep + end all present). */
  wellFormed: boolean;
}

/**
 * Walk every conflict block and slice the file body into the three
 * sides. Caller passes the WORKING-TREE file content (the conflicted
 * version git wrote to disk).
 */
export function extractConflicts(body: string): ConflictExtraction[] {
  if (!body) return [];
  const lines = body.split('\n');
  const markers = findMarkers(body);
  const blocks = groupBlocks(markers);
  const out: ConflictExtraction[] = [];
  for (const b of blocks) {
    const wellFormed = b.startLine >= 0 && b.separatorLine > b.startLine && b.endLine > b.separatorLine;
    const oursEnd = b.baseLine !== -1 ? b.baseLine : b.separatorLine;
    const oursContent = sliceLines(lines, b.startLine + 1, oursEnd);
    const baseContent = b.baseLine !== -1 ? sliceLines(lines, b.baseLine + 1, b.separatorLine) : '';
    const theirsContent = sliceLines(lines, b.separatorLine + 1, b.endLine !== -1 ? b.endLine : lines.length);
    out.push({
      block: b,
      oursContent,
      baseContent,
      theirsContent,
      hasBase: b.baseLine !== -1,
      wellFormed,
    });
  }
  return out;
}

function sliceLines(lines: string[], start: number, end: number): string {
  // start inclusive, end exclusive (end is the marker LINE, content is above it)
  if (end <= 0 || start < 0) return '';
  const s = Math.max(0, start);
  const e = Math.max(s, end);
  if (e === 0 || s >= lines.length) return '';
  return lines.slice(s, e).join('\n');
}

/**
 * The four canonical resolutions. We don't try to be clever about
 * merging hunks — the view's "Resolve" picker offers these four +
 * a "Edit manually" escape hatch.
 */
export type ResolutionChoice = 'ours' | 'theirs' | 'both-ours-theirs' | 'both-theirs-ours';

/**
 * Apply a resolution to ONE block. Returns the new file body with
 * THAT block's `<<<<<<< ... >>>>>>>` span replaced by the chosen content.
 * Other blocks are left intact.
 *
 * The function uses lineBlockIndex (0-based among conflict blocks in
 * order of appearance) so the caller can target specific blocks even
 * when their line numbers shift after another block is resolved.
 *
 * Throws if blockIndex is out of range. Returns body verbatim if the
 * targeted block is malformed (missing separator or end).
 */
export function applyResolution(body: string, blockIndex: number, choice: ResolutionChoice): string {
  const extractions = extractConflicts(body);
  if (blockIndex < 0 || blockIndex >= extractions.length) {
    throw new RangeError(`blockIndex ${blockIndex} out of range (0..${extractions.length - 1})`);
  }
  const ex = extractions[blockIndex];
  if (!ex.wellFormed) return body;
  const lines = body.split('\n');
  const before = lines.slice(0, ex.block.startLine).join('\n');
  const after = lines.slice(ex.block.endLine + 1).join('\n');
  const replacement = replacementFor(ex, choice);

  // Use \n joins carefully when the body had a trailing newline.
  const parts: string[] = [];
  if (before) parts.push(before);
  if (replacement) parts.push(replacement);
  if (after) parts.push(after);
  return parts.join('\n');
}

function replacementFor(ex: ConflictExtraction, choice: ResolutionChoice): string {
  switch (choice) {
    case 'ours':              return ex.oursContent;
    case 'theirs':            return ex.theirsContent;
    case 'both-ours-theirs':
      if (!ex.oursContent) return ex.theirsContent;
      if (!ex.theirsContent) return ex.oursContent;
      return `${ex.oursContent}\n${ex.theirsContent}`;
    case 'both-theirs-ours':
      if (!ex.theirsContent) return ex.oursContent;
      if (!ex.oursContent) return ex.theirsContent;
      return `${ex.theirsContent}\n${ex.oursContent}`;
  }
}

export type Difficulty = 'trivial' | 'small' | 'moderate' | 'large';

export interface DifficultyAssessment {
  level: Difficulty;
  reasons: string[];
  /** Suggested choice when difficulty === 'trivial' (otherwise undefined). */
  suggestion?: ResolutionChoice;
}

/**
 * Heuristic difficulty + a possible "auto-resolve" suggestion.
 *
 * `trivial` covers three patterns we can resolve without thinking:
 *   - Both sides identical (whitespace + content) -> take ours.
 *   - One side empty + base empty -> take the non-empty side.
 *   - Both sides differ only in trailing whitespace -> take ours
 *     (a common .gitattributes / editor-saved-trailing-spaces noise).
 *
 * `small` = both sides are < 10 lines AND no nested markers detected.
 * `moderate` = up to 50 lines per side OR > 5 lines diff between them.
 * `large` = anything else.
 */
export function classifyDifficulty(ex: ConflictExtraction): DifficultyAssessment {
  if (!ex.wellFormed) {
    return { level: 'large', reasons: ['malformed conflict block'] };
  }

  const oursTrim = ex.oursContent.replace(/[ \t]+$/gm, '');
  const theirsTrim = ex.theirsContent.replace(/[ \t]+$/gm, '');
  const baseTrim = ex.baseContent.replace(/[ \t]+$/gm, '');

  if (oursTrim === theirsTrim) {
    return { level: 'trivial', reasons: ['both sides identical'], suggestion: 'ours' };
  }
  if (!ex.oursContent.trim() && !ex.baseContent.trim()) {
    return { level: 'trivial', reasons: ['ours + base empty - they added; take theirs'], suggestion: 'theirs' };
  }
  if (!ex.theirsContent.trim() && !ex.baseContent.trim()) {
    return { level: 'trivial', reasons: ['theirs + base empty - we added; take ours'], suggestion: 'ours' };
  }
  if (oursTrim === theirsTrim && oursTrim !== ex.oursContent) {
    return { level: 'trivial', reasons: ['only trailing whitespace differs'], suggestion: 'ours' };
  }
  if (baseTrim && oursTrim === baseTrim) {
    return { level: 'trivial', reasons: ['ours matches base - take theirs'], suggestion: 'theirs' };
  }
  if (baseTrim && theirsTrim === baseTrim) {
    return { level: 'trivial', reasons: ['theirs matches base - take ours'], suggestion: 'ours' };
  }

  const oursLines = ex.oursContent.split('\n').length;
  const theirsLines = ex.theirsContent.split('\n').length;
  const maxLines = Math.max(oursLines, theirsLines);
  const diff = Math.abs(oursLines - theirsLines);

  if (maxLines < 10 && diff < 5) {
    return { level: 'small', reasons: [`${oursLines}/${theirsLines} lines per side`] };
  }
  if (maxLines < 50 && diff < 25) {
    return { level: 'moderate', reasons: [`${oursLines}/${theirsLines} lines per side`] };
  }
  return { level: 'large', reasons: [`${oursLines}/${theirsLines} lines per side`] };
}

/**
 * Build a short summary suitable for a picker row.
 *
 *   "Conflict 2 of 5  -  src/foo.ts  -  3/5 lines  -  trivial (take theirs)"
 */
export function describeBlockForPicker(
  ex: ConflictExtraction,
  index: number,
  total: number,
  relPath: string,
): string {
  const oursLines = ex.oursContent ? ex.oursContent.split('\n').length : 0;
  const theirsLines = ex.theirsContent ? ex.theirsContent.split('\n').length : 0;
  const diff = classifyDifficulty(ex);
  const sugg = diff.suggestion ? ` (take ${diff.suggestion.replace(/-/g, ' ')})` : '';
  return `Conflict ${index + 1}/${total}  -  ${relPath}  -  ${oursLines}/${theirsLines} lines  -  ${diff.level}${sugg}`;
}
