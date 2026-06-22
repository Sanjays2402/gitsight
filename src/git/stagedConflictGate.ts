/**
 * Pure helpers for the Staged Conflict Marker Gate (F78).
 *
 * The F34 ConflictMarkerController + F14 prePushLint already catch
 * conflict markers — but at the wrong time. F34 only diagnoses the
 * currently-open editor; F14 fires at push time, by which point the
 * marker is already in committed history.
 *
 * This module sits in between: scan the STAGED diff for `<<<<<<<` /
 * `=======` / `>>>>>>>` markers in added/modified hunks, returning the
 * exact line numbers + ref-names so the controller can:
 *
 *   1. Surface a status-bar pill ("3 conflicts in 2 staged files")
 *   2. Populate a picker with "open + jump to first marker" actions
 *   3. Add VS Code diagnostics so the markers show up in the Problems
 *      panel and the editor gutter
 *
 * The scanner consumes `git diff --cached -U0 --no-color` output rather
 * than reading files from disk: staged content can differ from working-
 * tree content (you staged a clean version then re-introduced a
 * conflict while editing), and the COMMIT will use the staged version.
 *
 * Pure — no vscode, no fs, no child_process. Tests in
 * test/git/stagedConflictGate.test.ts.
 */

export type StagedMarkerKind = 'start' | 'separator' | 'end' | 'base';

export interface StagedMarker {
  /** Repo-relative path the marker appears in. */
  path: string;
  /** One-based line number in the STAGED version of the file. */
  line: number;
  kind: StagedMarkerKind;
  /** Ref-name written after the marker (e.g. 'HEAD', 'feature/x'); '' for '======='. */
  refName: string;
}

export interface StagedFileFinding {
  path: string;
  markers: StagedMarker[];
  /** Quick-look count by kind for the pill summary. */
  byKind: Record<StagedMarkerKind, number>;
}

/**
 * Parse the output of `git diff --cached -U0 --no-color`. We only flag
 * markers that appear in the `+` lines of added/modified hunks — markers
 * that exist on the `-` side are "the user is staging the RESOLUTION of
 * a conflict", which is exactly the user's job and definitely NOT a bug.
 *
 * The hunk header tells us which line in the destination (the +N,M part)
 * the changes apply to, so we can map back from "first added line in
 * hunk" to "line in the staged file".
 */
export function findStagedMarkers(diff: string): StagedMarker[] {
  if (!diff) return [];
  const out: StagedMarker[] = [];
  const lines = diff.split('\n');
  let currentPath: string | undefined;
  // hunkLine = the next line number IN the staged (+) version a `+` row
  // would land at. Bumped by 1 for every '+' or ' ' (context) line, but
  // `git diff -U0` only ever produces ' ' (context) at hunk boundaries,
  // so in practice we only need to bump on '+'.
  let hunkLine = 0;
  for (const raw of lines) {
    if (raw.startsWith('+++ b/')) {
      currentPath = raw.slice(6).trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      // /dev/null or no-path; clear.
      currentPath = undefined;
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('diff --git')) {
      // Reset hunkLine when a new file starts so a previous hunk doesn't
      // bleed counters into the next file.
      hunkLine = 0;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
      if (m) hunkLine = parseInt(m[1], 10);
      continue;
    }
    if (!currentPath) continue;
    if (raw.startsWith('+')) {
      const content = raw.slice(1);
      const m = classifyMarkerLine(content);
      if (m) {
        out.push({ path: currentPath, line: hunkLine, kind: m.kind, refName: m.refName });
      }
      hunkLine++;
    }
    // We deliberately skip '-' lines (no advance) and ' ' lines (would
    // advance hunkLine too — but `-U0` strips context, so contexts are
    // empty in practice).
  }
  return out;
}

/**
 * Classify a SINGLE line (without the leading `+` from a diff row). Mirrors
 * the F34 conflictMarkers parser but exported separately so this module
 * doesn't pull conflictMarkers into the test compile graph (and to keep
 * the rules tweakable here for the staged-diff context, e.g. we may want
 * to be stricter about whitespace tolerance).
 */
export function classifyMarkerLine(content: string): { kind: StagedMarkerKind; refName: string } | undefined {
  const trimmed = content.replace(/\r$/, '');
  // Exactly seven of the glyph, optionally followed by whitespace + ref.
  let m: RegExpExecArray | null;
  if ((m = /^<{7}(?:[ \t]+(.*))?$/.exec(trimmed))) return { kind: 'start', refName: (m[1] ?? '').trim() };
  if ((m = /^\|{7}(?:[ \t]+(.*))?$/.exec(trimmed))) return { kind: 'base',  refName: (m[1] ?? '').trim() };
  if (/^={7}$/.test(trimmed)) return { kind: 'separator', refName: '' };
  if ((m = /^>{7}(?:[ \t]+(.*))?$/.exec(trimmed))) return { kind: 'end', refName: (m[1] ?? '').trim() };
  return undefined;
}

/**
 * Group the flat marker list into per-file findings, keeping the natural
 * line-order. The byKind tally is useful for the status-bar pill which
 * wants to show "3 conflicts" (start-count) rather than "12 markers"
 * (the marker count for the same conflicts).
 */
export function groupByFile(markers: StagedMarker[]): StagedFileFinding[] {
  const byPath = new Map<string, StagedMarker[]>();
  for (const m of markers) {
    const list = byPath.get(m.path);
    if (list) list.push(m);
    else byPath.set(m.path, [m]);
  }
  const out: StagedFileFinding[] = [];
  for (const [path, list] of byPath) {
    list.sort((a, b) => a.line - b.line);
    out.push({
      path,
      markers: list,
      byKind: {
        start: list.filter(m => m.kind === 'start').length,
        separator: list.filter(m => m.kind === 'separator').length,
        end: list.filter(m => m.kind === 'end').length,
        base: list.filter(m => m.kind === 'base').length,
      },
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * One-line summary suitable for the status-bar pill text. Uses the start
 * count as the "number of conflicts" since every well-formed conflict has
 * exactly one `<<<<<<<` marker; the separator/end counts are diagnostic
 * detail in the tooltip.
 */
export function summarisePill(findings: StagedFileFinding[]): string {
  const totalConflicts = findings.reduce((acc, f) => acc + Math.max(f.byKind.start, 1), 0);
  const fileLabel = `${findings.length} staged file${findings.length === 1 ? '' : 's'}`;
  const conflictLabel = `${totalConflicts} conflict${totalConflicts === 1 ? '' : 's'}`;
  return `${conflictLabel} in ${fileLabel}`;
}

/**
 * Tooltip markdown — per-file conflict count + first ref-name hint. Stable
 * shape so the tests can assert on it.
 */
export function tooltipLines(findings: StagedFileFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    const refs = uniqueRefs(f.markers);
    const refsHint = refs.length ? `  \u00b7  ${refs.join(' / ')}` : '';
    const conflicts = Math.max(f.byKind.start, 1);
    out.push(`- \`${f.path}\` — ${conflicts} conflict${conflicts === 1 ? '' : 's'}${refsHint}`);
  }
  return out;
}

function uniqueRefs(markers: StagedMarker[]): string[] {
  const set = new Set<string>();
  for (const m of markers) {
    if (m.refName) set.add(m.refName);
  }
  return [...set];
}

/**
 * The "first marker line per file" lookup — for the picker's
 * "Open + jump to first conflict" action.
 */
export function firstMarkerLine(finding: StagedFileFinding): number | undefined {
  if (!finding.markers.length) return undefined;
  return finding.markers[0].line;
}
