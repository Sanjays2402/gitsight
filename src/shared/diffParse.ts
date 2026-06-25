/**
 * GitSight shared unified-diff parser (W7).
 *
 * STACK-AGNOSTIC. No `vscode`, no Node built-ins, no DOM. Parses the
 * unified-diff text git emits (`git show -p` / `git diff`) into a typed
 * structure both the web diff view and any future extension surface can
 * render without re-implementing the hunk grammar.
 *
 * Handles: multi-file diffs, add/delete/rename/copy headers, binary
 * markers, `@@ -a,b +c,d @@` hunk headers with optional section text,
 * and `\ No newline at end of file`. Tracks old/new line numbers per
 * line so a split or unified view can label gutters accurately.
 *
 * No cross-file runtime import (the companion server loads it via Node
 * type-stripping, which only erases `import type`).
 *
 * Tests: test/git/diffParse.test.ts
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** Text content (without the leading +/-/space marker). */
  text: string;
  /** 1-based line number in the old file, or null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null for deleted lines. */
  newLine: number | null;
  /** True when this line had no trailing newline in the source. */
  noNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Optional section heading git appends after the `@@ ... @@`. */
  section: string;
  lines: DiffLine[];
}

export type FileDiffStatus = 'added' | 'deleted' | 'renamed' | 'copied' | 'modified';

export interface FileDiff {
  /** New path (the post-image path; same as oldPath for plain edits). */
  path: string;
  /** Old path for renames/copies, else equal to `path`. */
  oldPath: string;
  status: FileDiffStatus;
  binary: boolean;
  hunks: DiffHunk[];
  /** Total added lines across hunks. */
  additions: number;
  /** Total removed lines across hunks. */
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

/** Strip a single leading `a/` or `b/` prefix git uses in path lines. */
export function stripDiffPrefix(p: string): string {
  if (p === '/dev/null') return p;
  return p.replace(/^[ab]\//, '');
}

/** Parse a `@@ -a,b +c,d @@ section` header, or null if it isn't one. */
export function parseHunkHeader(line: string): Omit<DiffHunk, 'lines'> | null {
  const m = HUNK_RE.exec(line);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
    newStart: parseInt(m[3], 10),
    newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
    section: m[5] ?? '',
  };
}

/**
 * Parse a full unified-diff blob into one FileDiff per `diff --git`
 * stanza. Resilient to leading commit-message text (it only starts a file
 * on a `diff --git` line), so the caller can pass `git show -p` output
 * with `--format=` to keep it clean either way.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split('\n');
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const closeHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = (): void => {
    closeHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      closeFile();
      // `diff --git a/x b/y` — capture both sides as a fallback path.
      const m = /^diff --git (.+) (.+)$/.exec(raw);
      const a = m ? stripDiffPrefix(m[1]) : '';
      const b = m ? stripDiffPrefix(m[2]) : '';
      current = {
        path: b || a,
        oldPath: a || b,
        status: 'modified',
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from ')) {
      current.oldPath = raw.slice('rename from '.length);
      current.status = 'renamed';
      continue;
    }
    if (raw.startsWith('rename to ')) {
      current.path = raw.slice('rename to '.length);
      current.status = 'renamed';
      continue;
    }
    if (raw.startsWith('copy from ')) {
      current.oldPath = raw.slice('copy from '.length);
      current.status = 'copied';
      continue;
    }
    if (raw.startsWith('copy to ')) {
      current.path = raw.slice('copy to '.length);
      current.status = 'copied';
      continue;
    }
    if (raw.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = stripDiffPrefix(raw.slice(4));
      if (p !== '/dev/null') current.oldPath = p;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = stripDiffPrefix(raw.slice(4));
      if (p !== '/dev/null') current.path = p;
      continue;
    }
    if (raw.startsWith('index ') || raw.startsWith('old mode ') || raw.startsWith('new mode ') || raw.startsWith('similarity index ') || raw.startsWith('dissimilarity index ')) {
      continue;
    }

    const header = parseHunkHeader(raw);
    if (header) {
      closeHunk();
      hunk = { ...header, lines: [] };
      oldNo = header.oldStart;
      newNo = header.newStart;
      continue;
    }

    if (!hunk) continue;

    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" applies to the previous emitted line.
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: content, oldLine: null, newLine: newNo++ });
      current.additions++;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: content, oldLine: oldNo++, newLine: null });
      current.deletions++;
    } else if (marker === ' ' || raw === '') {
      // Context line (a bare empty string is an empty context line).
      hunk.lines.push({ kind: 'context', text: content, oldLine: oldNo++, newLine: newNo++ });
    }
    // Any other leading char is non-diff noise; ignore.
  }

  closeFile();
  return files;
}

/** Convenience: parse a diff known to contain a single file, or null. */
export function parseSingleFileDiff(text: string): FileDiff | null {
  const files = parseUnifiedDiff(text);
  return files[0] ?? null;
}
