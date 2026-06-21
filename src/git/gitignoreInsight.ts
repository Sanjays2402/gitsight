/**
 * Pure helper: parse `git check-ignore --verbose` output.
 *
 * Format per line (per git docs):
 *
 *   <source>:<linenum>:<pattern>\t<pathname>
 *
 *   - source   absolute path to the gitignore file (or "" for built-in)
 *   - linenum  the 1-based line number of the matching pattern
 *   - pattern  the literal pattern
 *   - pathname the file that was checked
 *
 * If the source path is blank or `<command line>`, we leave `sourceFile`
 * as the raw value so callers can decide how to surface it.
 *
 * No vscode / no fs / no child_process imports — pure parsing.
 */

import * as path from 'path';

export interface AttributedFile {
  /** Repo-relative path of the ignored file. */
  relPath: string;
  /** Absolute path of the .gitignore (or '' / '<command line>' for built-ins). */
  sourceFile: string;
  /** 1-based line in the source file (or undefined for built-ins / no match). */
  lineNumber?: number;
  /** The matching pattern (e.g. `node_modules/`). */
  pattern?: string;
}

export function attributeIgnoredFiles(verboseOut: string, repoRoot: string): AttributedFile[] {
  const lines = verboseOut.split('\n').filter(Boolean);
  const out: AttributedFile[] = [];
  for (const raw of lines) {
    const tabIdx = raw.indexOf('\t');
    if (tabIdx < 0) continue;
    const head = raw.slice(0, tabIdx);
    const file = raw.slice(tabIdx + 1);

    // Source / line / pattern split. Source path may contain colons on Windows;
    // the line number is always a sequence of digits between two colons, so we
    // anchor on that. Built-in / command-line rules render as `::` with no
    // digits — keep sourceFile blank for those.
    if (head === '::') {
      out.push({
        relPath: normaliseRelPath(file, repoRoot),
        sourceFile: '',
      });
      continue;
    }
    const m = /^(.*?):(\d+):(.*)$/.exec(head);
    let sourceFile = '', lineNumber: number | undefined, pattern: string | undefined;
    if (m) {
      sourceFile = m[1];
      lineNumber = parseInt(m[2], 10);
      pattern = m[3];
    } else {
      sourceFile = head;
    }

    out.push({
      relPath: normaliseRelPath(file, repoRoot),
      sourceFile,
      lineNumber,
      pattern,
    });
  }
  return out;
}

function normaliseRelPath(file: string, repoRoot: string): string {
  if (path.isAbsolute(file)) return path.relative(repoRoot, file);
  return file;
}

/** Count ignored files grouped by source .gitignore. */
export function countBySource(files: AttributedFile[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    const key = f.sourceFile || '<built-in>';
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
