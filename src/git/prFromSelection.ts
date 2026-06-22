/**
 * Pure helpers for "PR Description from Selection" (F87).
 *
 * Given an editor selection (file path + selected text + surrounding
 * context) and basic git metadata, build a tightly-scoped prompt that
 * asks the AI to write a *micro-PR* description focused on just that
 * change — useful for splitting a sprawling branch into small,
 * reviewable units, or for documenting a single-file refactor.
 *
 * Pure — no vscode, no child_process. Tests in test/git/prFromSelection.test.ts.
 */

export interface SelectionContext {
  /** Repo-relative path to the file the user is editing. */
  relPath: string;
  /** Programming language id (or extension); used to fence the selection. */
  language: string;
  /** 1-indexed start line of the selection (inclusive). */
  startLine: number;
  /** 1-indexed end line of the selection (inclusive). */
  endLine: number;
  /** Selected text exactly as it appears in the editor. */
  selectionText: string;
  /**
   * Optional surrounding-lines context — N lines before + after the
   * selection. Used to ground the description ("in the parser, the
   * tokenisation step now…"). Truncated to a sensible window upstream.
   */
  contextBefore?: string;
  contextAfter?: string;
}

export interface RepoContext {
  /** Current branch name. */
  branch: string;
  /** Detected default base branch (e.g. 'main' / 'origin/main'). */
  base: string;
}

/**
 * Detect whether the selection is "interesting enough" to warrant a PR
 * draft. The threshold is intentionally loose — we just want to catch
 * the case where the user accidentally invoked the command on a 1-line
 * selection (which would just be noise as a PR).
 *
 *   - Empty / pure-whitespace selection      → 'empty'
 *   - Fewer than `minLines` lines (default 2) → 'too-small'
 *   - More than `maxLines` lines (default 400) → 'too-large'
 *   - otherwise                              → 'ok'
 *
 * The view layer surfaces the error so the user gets a friendly
 * explanation instead of a malformed prompt being sent to the AI.
 */
export type SelectionVerdict = 'ok' | 'empty' | 'too-small' | 'too-large';

export function classifySelection(
  sel: SelectionContext,
  opts: { minLines?: number; maxLines?: number } = {},
): SelectionVerdict {
  const minLines = opts.minLines ?? 2;
  const maxLines = opts.maxLines ?? 400;
  const text = (sel.selectionText ?? '').trim();
  if (!text) return 'empty';
  const lineCount = (sel.endLine - sel.startLine) + 1;
  if (lineCount < minLines) return 'too-small';
  if (lineCount > maxLines) return 'too-large';
  return 'ok';
}

/**
 * Render the selection into a fenced markdown code block with the
 * file path + line range as a header. Trailing whitespace on each
 * line is trimmed; leading whitespace is preserved (indentation
 * matters for context).
 *
 *   ### src/git/parser.ts:42-67
 *   ```typescript
 *   ...selection...
 *   ```
 */
export function formatSelectionBlock(sel: SelectionContext): string {
  const fenceLang = languageFenceTag(sel.language);
  const header = `### ${sel.relPath}:${sel.startLine}-${sel.endLine}`;
  const lines = (sel.selectionText ?? '')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''));
  return `${header}\n\`\`\`${fenceLang}\n${lines.join('\n')}\n\`\`\``;
}

/** Map a VS Code language id to a markdown fence hint. Strip anything weird. */
export function languageFenceTag(language: string): string {
  if (!language) return '';
  // Common aliases the editor returns vs. what GitHub markdown recognises.
  const map: Record<string, string> = {
    typescriptreact: 'tsx',
    javascriptreact: 'jsx',
    'plaintext': '',
  };
  if (map[language] !== undefined) return map[language];
  // Otherwise keep alphanumeric + dot only — guards against weird ids.
  return language.replace(/[^A-Za-z0-9+.-]/g, '').toLowerCase();
}

/**
 * Compose the full user-prompt body that gets sent to the AI. The
 * caller pairs this with a SYSTEM prompt that explains the desired
 * output shape (title + summary + change notes + test plan).
 */
export interface BuildPromptArgs {
  selection: SelectionContext;
  repo: RepoContext;
  /** Optional one-line commit summary if the user has the file staged. */
  recentSubject?: string;
  /** Cap on context-before/after lines included in the prompt. */
  maxContextLines?: number;
}

export function buildSelectionPrompt(args: BuildPromptArgs): string {
  const { selection, repo, recentSubject, maxContextLines = 60 } = args;
  const parts: string[] = [];
  parts.push(`Source branch: ${repo.branch}`);
  parts.push(`Target branch: ${repo.base}`);
  parts.push(`File: ${selection.relPath}`);
  parts.push(`Lines: ${selection.startLine}-${selection.endLine}`);
  if (recentSubject) {
    parts.push(`Most recent commit touching this area: ${recentSubject}`);
  }
  parts.push('');
  parts.push('## Selection');
  parts.push(formatSelectionBlock(selection));
  const before = truncateContext(selection.contextBefore, maxContextLines);
  const after = truncateContext(selection.contextAfter, maxContextLines);
  if (before) {
    parts.push('');
    parts.push('## Context before the selection');
    parts.push(fenceContext(selection.language, before));
  }
  if (after) {
    parts.push('');
    parts.push('## Context after the selection');
    parts.push(fenceContext(selection.language, after));
  }
  parts.push('');
  parts.push(
    'Write a tightly-scoped PR description for ONLY the selected change. ' +
    'Treat surrounding context as orientation, not as part of the diff. ' +
    'The output should be a single small PR a reviewer can land in under five minutes.',
  );
  return parts.join('\n');
}

function fenceContext(language: string, text: string): string {
  return `\`\`\`${languageFenceTag(language)}\n${text}\n\`\`\``;
}

function truncateContext(text: string | undefined, maxLines: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(lines.length - Math.floor(maxLines / 2));
  return [...head, `// ...${lines.length - maxLines} lines omitted...`, ...tail].join('\n');
}

/**
 * Suggest a PR title from a selection. The view layer feeds this to a
 * follow-up input box as a default so the user only has to edit.
 *
 *   - If recentSubject is set and conventional-shaped, return it.
 *   - Otherwise, build "<verb> <file>:<lines>" using a verb that hints
 *     at the change kind (add/refactor/fix), with file basename.
 *
 * Always returns a non-empty string under 80 chars.
 */
export function suggestPrTitle(args: {
  selection: SelectionContext;
  recentSubject?: string;
}): string {
  const recent = (args.recentSubject ?? '').trim();
  if (recent) {
    return recent.length > 80 ? recent.slice(0, 77) + '\u2026' : recent;
  }
  const base = args.selection.relPath.split('/').pop() ?? args.selection.relPath;
  const verb = inferVerb(args.selection);
  const title = `${verb} in ${base}:${args.selection.startLine}-${args.selection.endLine}`;
  return title.length > 80 ? title.slice(0, 77) + '\u2026' : title;
}

function inferVerb(sel: SelectionContext): string {
  const text = (sel.selectionText ?? '').toLowerCase();
  // Very rough heuristic — the user can rewrite the title anyway.
  if (/\bfunction\s+\w+|\bclass\s+\w+|\bexport\s+/i.test(sel.selectionText)) return 'Add';
  if (/\bfix|\bbug\b|\bcrash\b|\berror\b/.test(text)) return 'Fix';
  if (/\bremove|\bdelete\b|\bdrop\b/.test(text)) return 'Remove';
  if (/\brefactor|\brename|\bextract\b/.test(text)) return 'Refactor';
  return 'Update';
}
