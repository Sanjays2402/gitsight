/**
 * Pure helpers for F118 - PR Description from Active Diff Selection.
 *
 * Extends F87 (PR description from editor selection) with multi-file
 * gather. Where F87 sees only the active editor's selection, F118
 * walks a list of changed files (typically `<base>..HEAD` numstat
 * + optional file-list filter) and stitches them into a single AI
 * prompt that focuses on the WHOLE PR, not just one editor.
 *
 * Useful when:
 *   - F87's "select your change" UX is awkward (the change spans 8
 *     files in 4 directories).
 *   - The user wants an AI draft that mirrors what a reviewer would
 *     see in `gh pr view --diff` (multi-file, cross-cutting).
 *
 * Pure - no vscode, no fs, no AI side effects. Tests in
 * test/git/prFromDiff.test.ts.
 */

import { languageFenceTag } from './prFromSelection';

export interface DiffFileEntry {
  /** Repo-relative path of the changed file. */
  relPath: string;
  /** Programming language id / extension (for fence tagging). */
  language: string;
  /** The unified-diff snippet for THIS file (output of `git diff <base>..HEAD -- <file>`). */
  diffSnippet: string;
  /** Lines added in this file (numstat +). */
  added: number;
  /** Lines removed in this file (numstat -). */
  removed: number;
  /** True when the file is binary (numstat reports `-` for both). */
  binary?: boolean;
}

export interface RepoMeta {
  branch: string;
  base: string;
  /** Optional one-line commit summary of HEAD - used as a fallback title. */
  recentSubject?: string;
}

/**
 * Decide whether the PR shape is reasonable for an AI summary.
 *
 *   - empty            -> no files in the diff
 *   - too-small        -> fewer than minFiles AND fewer than minLines lines
 *   - too-large-files  -> over maxFiles file count
 *   - too-large-lines  -> over maxLines total line churn
 *   - binary-heavy     -> >50% of files binary (numstat dashes)
 *   - ok               -> proceed
 *
 * The picker calls this BEFORE building the prompt so the user gets
 * a friendly explanation instead of a malformed AI request.
 */
export type DiffVerdict =
  | 'ok'
  | 'empty'
  | 'too-small'
  | 'too-large-files'
  | 'too-large-lines'
  | 'binary-heavy';

export interface ClassifyDiffArgs {
  files: DiffFileEntry[];
  /** Default 1 - any diff with at least one file is worth describing. */
  minFiles?: number;
  /** Default 5 - tiny one-liner PRs better described by F87 selection. */
  minLines?: number;
  /** Default 40 - guard against monorepo-wide refactors blowing context. */
  maxFiles?: number;
  /** Default 4000 - guard against huge churn blowing the prompt. */
  maxLines?: number;
}

export function classifyDiff(args: ClassifyDiffArgs): DiffVerdict {
  const files = args.files ?? [];
  const minFiles = args.minFiles ?? 1;
  const minLines = args.minLines ?? 5;
  const maxFiles = args.maxFiles ?? 40;
  const maxLines = args.maxLines ?? 4000;
  if (files.length === 0) return 'empty';
  if (files.length > maxFiles) return 'too-large-files';
  const binaryCount = files.filter(f => f.binary).length;
  if (binaryCount / files.length > 0.5) return 'binary-heavy';
  const totalLines = files.reduce((acc, f) => acc + Math.max(0, f.added) + Math.max(0, f.removed), 0);
  if (totalLines > maxLines) return 'too-large-lines';
  if (files.length < minFiles) return 'too-small';
  if (totalLines < minLines && files.length < 2) return 'too-small';
  return 'ok';
}

/**
 * Summarise the file changes into a one-paragraph header. Useful for
 * the prompt preamble + for the picker description.
 *
 *   "12 files changed: +480/-126 lines across `src/api/`, `src/web/`,
 *    `test/api/` (1 binary file ignored)."
 */
export function summariseDiff(files: DiffFileEntry[]): string {
  if (!files.length) return 'No files changed.';
  const filesWithChurn = files.filter(f => !f.binary);
  const binary = files.length - filesWithChurn.length;
  const added = filesWithChurn.reduce((a, f) => a + Math.max(0, f.added), 0);
  const removed = filesWithChurn.reduce((a, f) => a + Math.max(0, f.removed), 0);
  const topDirs = topLevelDirs(filesWithChurn).slice(0, 3);
  const dirList = topDirs.length
    ? ` across ${topDirs.map(d => `\`${d || '/'}\``).join(', ')}`
    : '';
  const binSuffix = binary > 0 ? ` (${binary} binary file${binary === 1 ? '' : 's'} ignored)` : '';
  return `${files.length} file${files.length === 1 ? '' : 's'} changed: +${added}/-${removed} lines${dirList}${binSuffix}.`;
}

function topLevelDirs(files: DiffFileEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const idx = f.relPath.indexOf('/');
    const dir = idx > 0 ? f.relPath.slice(0, idx) : '';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir]) => dir);
}

/**
 * Format a single file as a markdown fenced diff block. Trims very
 * long snippets via head+tail split with an explicit omission marker
 * (matches the F87 truncateContext shape) so the model still sees
 * the start AND end of the file's change.
 */
export interface FormatFileArgs {
  file: DiffFileEntry;
  /** Cap on lines retained per file (default 200). */
  maxLinesPerFile?: number;
}

export function formatFileBlock(args: FormatFileArgs): string {
  const { file } = args;
  const cap = args.maxLinesPerFile ?? 200;
  const header = `### \`${file.relPath}\` (+${Math.max(0, file.added)}/-${Math.max(0, file.removed)})`;
  if (file.binary) {
    return `${header}\n\n_Binary file - diff omitted._`;
  }
  const snippet = (file.diffSnippet ?? '').replace(/\r\n/g, '\n').replace(/\s+$/g, '');
  if (!snippet) {
    return `${header}\n\n_No diff payload available._`;
  }
  const lines = snippet.split('\n');
  let body = snippet;
  if (lines.length > cap) {
    const half = Math.floor(cap / 2);
    const head = lines.slice(0, half);
    const tail = lines.slice(lines.length - half);
    body = [...head, `// ...${lines.length - cap} lines omitted...`, ...tail].join('\n');
  }
  const fenceLang = pickDiffFence(file.language);
  return `${header}\n\`\`\`${fenceLang}\n${body}\n\`\`\``;
}

/**
 * Choose a markdown fence tag for a unified-diff snippet. Most snippets
 * benefit from `diff` highlighting; we fall back to the language id
 * when the file is small enough that the diff syntax obscures rather
 * than helps.
 */
export function pickDiffFence(_language: string): string {
  // Always use `diff` - GitHub markdown highlights +/- lines correctly,
  // and most reviewers expect that shape inside a "what changed" block.
  return 'diff';
}

/**
 * Build the full prompt body fed to the AI. Composes a header (repo
 * meta + summary), the per-file blocks (after capping), and a closing
 * instruction.
 */
export interface BuildDiffPromptArgs {
  files: DiffFileEntry[];
  repo: RepoMeta;
  /** Cap on files included in the prompt (default 12). Extras are listed by name only. */
  maxFiles?: number;
  /** Cap on lines per file (default 200). Falls through to formatFileBlock. */
  maxLinesPerFile?: number;
}

export function buildDiffPrompt(args: BuildDiffPromptArgs): string {
  const cap = args.maxFiles ?? 12;
  const linesCap = args.maxLinesPerFile ?? 200;
  const sorted = [...args.files].sort(byChurnDesc);
  const included = sorted.slice(0, cap);
  const omitted = sorted.slice(cap);

  const lines: string[] = [];
  lines.push(`Source branch: ${args.repo.branch}`);
  lines.push(`Target branch: ${args.repo.base}`);
  if (args.repo.recentSubject) {
    lines.push(`Most recent commit subject: ${args.repo.recentSubject}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push(summariseDiff(args.files));
  lines.push('');
  for (const f of included) {
    lines.push(formatFileBlock({ file: f, maxLinesPerFile: linesCap }));
    lines.push('');
  }
  if (omitted.length > 0) {
    lines.push(`## ${omitted.length} additional file${omitted.length === 1 ? '' : 's'} not shown`);
    for (const f of omitted) {
      const churn = f.binary ? '(binary)' : `(+${Math.max(0, f.added)}/-${Math.max(0, f.removed)})`;
      lines.push(`- \`${f.relPath}\` ${churn}`);
    }
    lines.push('');
  }
  lines.push(
    'Write a Pull Request description for this full multi-file change. ' +
    'Focus on the user-visible behaviour shift, then call out structural ' +
    'changes (refactors, renames, deletions). Reviewer notes should call ' +
    'out cross-file invariants the reviewer needs to verify.',
  );
  return lines.join('\n');
}

function byChurnDesc(a: DiffFileEntry, b: DiffFileEntry): number {
  const ca = Math.max(0, a.added) + Math.max(0, a.removed);
  const cb = Math.max(0, b.added) + Math.max(0, b.removed);
  if (ca !== cb) return cb - ca;
  return a.relPath.localeCompare(b.relPath);
}

/**
 * Suggest a PR title from the diff. Falls back through:
 *
 *   1. The recent commit subject (when present, cleaned).
 *   2. A constructed "Update <top-dir> (N files)" string when the
 *      change spans a single top-level dir.
 *   3. "Multi-area changes across N files" otherwise.
 */
export interface SuggestTitleArgs {
  files: DiffFileEntry[];
  recentSubject?: string;
}

export function suggestDiffPrTitle(args: SuggestTitleArgs): string {
  const recent = (args.recentSubject ?? '').trim();
  if (recent) {
    return recent.length > 80 ? recent.slice(0, 77) + '\u2026' : recent;
  }
  const files = args.files ?? [];
  if (!files.length) return 'Update';
  const dirs = topLevelDirs(files);
  if (dirs.length === 1) {
    const dir = dirs[0] || 'root';
    const t = `Update ${dir} (${files.length} file${files.length === 1 ? '' : 's'})`;
    return t.length > 80 ? t.slice(0, 77) + '\u2026' : t;
  }
  return `Multi-area changes across ${files.length} files`;
}

/**
 * Parse `git diff <base>..HEAD --numstat -z` output into a list of
 * DiffFileEntry stubs with added/removed/binary populated.
 * The diff snippet remains empty; the caller fills it via per-file
 * `git diff <base>..HEAD -- <path>` calls.
 *
 * NUL-separated to handle paths with newlines. Rename rows
 * (`R<percent>\t<old>\t<new>`) are NOT supported here - they don't
 * appear in numstat without `-M`. If the caller passes `-M` output
 * the renamed rows will be skipped (we only care about the new
 * path, which appears in the next non-NUL field).
 */
export function parseNumstatNul(raw: string): Array<Pick<DiffFileEntry, 'relPath' | 'added' | 'removed' | 'binary'>> {
  const out: Array<Pick<DiffFileEntry, 'relPath' | 'added' | 'removed' | 'binary'>> = [];
  if (!raw) return out;
  const fields = raw.split('\0').filter(s => s.length > 0);
  for (const f of fields) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(f);
    if (!m) continue;
    const addedRaw = m[1];
    const removedRaw = m[2];
    const relPath = m[3];
    const binary = addedRaw === '-' || removedRaw === '-';
    const added = binary ? 0 : (Number.parseInt(addedRaw, 10) || 0);
    const removed = binary ? 0 : (Number.parseInt(removedRaw, 10) || 0);
    out.push({ relPath, added, removed, binary });
  }
  return out;
}
