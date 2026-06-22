/**
 * Pure helpers for the PR Comment Composer (F93).
 *
 * Pairs with F88 (PR Comments Inbox). Where F88 surfaces existing
 * comments, F93 composes new ones from the editor's current selection
 * and posts via:
 *
 *   gh pr comment <num> --body-file -
 *
 * Inline review comments require the gh API directly (`gh api repos/...
 * /pulls/<num>/comments`) since `gh pr review` only accepts a single
 * body+state per call. For the v1 slice we ship the top-level comment
 * path (most common, no API plumbing) and leave inline as a future
 * extension when the user asks for it.
 *
 * The composer's job (pure):
 *   1. Build a code-fenced quote block from the selection (or a plain
 *      block when there's no selection / current file isn't suitable).
 *   2. Attach a permalink line: `[<repo>/<branch>/<path>:<line>](url)`
 *      when the host detector can resolve one. Falls back to a relative
 *      path when no remote URL is available.
 *   3. Optional user prefix: "I think this should..." — the body is
 *      composed AROUND the quote so the user's prose reads naturally.
 *
 * Pure — no vscode, no child_process, no fs. Tests in
 * test/git/prCommentCompose.test.ts.
 */

export interface ComposeArgs {
  /** Selected text from the editor. Empty / whitespace-only treated as no-selection. */
  selectionText: string;
  /** Optional prose the user typed in the input box. */
  userPrefix?: string;
  /** Repo-relative path of the file (used in the permalink). */
  path?: string;
  /** 1-based start line of the selection. */
  startLine?: number;
  /** 1-based end line of the selection. */
  endLine?: number;
  /** Fenced-code language tag (from the editor's languageId). */
  language?: string;
  /** Permalink URL (host-specific, built by remoteWebUrl + line ranges). */
  permalink?: string;
  /** Branch the comment refers to (for the permalink label). */
  branch?: string;
}

/**
 * Compose the markdown body. Layout:
 *
 *   <user prefix prose>
 *
 *   > [src/foo/bar.ts:12-18 @ feat/widget](https://github.com/...)
 *
 *   ```ts
 *   <quoted selection>
 *   ```
 *
 * Each section is conditional:
 *   - No userPrefix -> drop the prose.
 *   - No path -> drop the permalink line.
 *   - No selection -> drop the code-fence (user is making a general comment).
 *
 * Always normalises trailing whitespace so the body is clean when
 * piped through `gh pr comment --body-file -`.
 */
export function composeCommentBody(args: ComposeArgs): string {
  const {
    selectionText = '',
    userPrefix,
    path,
    startLine,
    endLine,
    language,
    permalink,
    branch,
  } = args;
  const selection = (selectionText ?? '').replace(/\r\n/g, '\n');
  const lines: string[] = [];

  const prefix = (userPrefix ?? '').trim();
  if (prefix) {
    lines.push(prefix);
    lines.push('');
  }

  if (path) {
    const label = buildPermalinkLabel(path, startLine, endLine, branch);
    if (permalink) {
      lines.push(`> [${label}](${permalink})`);
    } else {
      lines.push(`> ${label}`);
    }
    lines.push('');
  }

  const hasSelection = !!selection.trim();
  if (hasSelection) {
    const fence = fenceLanguage(language);
    lines.push('```' + fence);
    // Trim a single trailing newline so the fence-close doesn't end up on
    // a doubled blank line — but preserve internal blank lines.
    lines.push(selection.replace(/\n+$/, ''));
    lines.push('```');
  }

  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

function buildPermalinkLabel(
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
  branch: string | undefined,
): string {
  let label = path;
  if (startLine && endLine && startLine !== endLine) {
    label += `:${startLine}-${endLine}`;
  } else if (startLine) {
    label += `:${startLine}`;
  }
  if (branch) label += ` @ ${branch}`;
  return label;
}

/**
 * Map a VS Code languageId to the markdown fence label.
 *
 * Mirrors the F87 (PR description from selection) fence-tag heuristic so
 * the two AI-adjacent + manual-compose paths render code blocks
 * identically. Unknown ids strip to alphanumerics + lowercase.
 */
export function fenceLanguage(languageId: string | undefined): string {
  if (!languageId) return '';
  const lower = languageId.toLowerCase();
  switch (lower) {
    case 'typescriptreact': return 'tsx';
    case 'javascriptreact': return 'jsx';
    case 'plaintext': return '';
    case 'shellscript': return 'bash';
    case 'objective-c': return 'objc';
    case 'objective-cpp': return 'objcpp';
    default:
      return lower.replace(/[^a-z0-9]/g, '');
  }
}

/**
 * Build the GitHub permalink fragment for a selection.
 *
 *   github.com:  /blob/<branch>/<path>#L12-L18
 *   gitlab.com:  /-/blob/<branch>/<path>#L12-L18
 *
 * Returns just the path-and-anchor portion (the host-prefixed base is
 * fed in separately so we can short-circuit when no remote is found).
 */
export function buildPermalinkPath(
  hostBase: string,
  branch: string,
  path: string,
  startLine?: number,
  endLine?: number,
): string {
  const lower = hostBase.toLowerCase();
  let pathPart: string;
  if (lower.includes('gitlab.com') || lower.includes('/-/')) {
    pathPart = `/-/blob/${encodeURIComponent(branch)}/${path}`;
  } else if (lower.includes('bitbucket.org')) {
    pathPart = `/src/${encodeURIComponent(branch)}/${path}`;
  } else if (lower.includes('dev.azure.com') || lower.includes('visualstudio.com')) {
    // Azure DevOps uses a path query-param + line param.
    pathPart = `?path=${encodeURIComponent('/' + path)}&version=GB${encodeURIComponent(branch)}`;
    if (startLine && endLine) pathPart += `&line=${startLine}&lineEnd=${endLine}&lineStartColumn=1&lineEndColumn=1`;
    return pathPart;
  } else {
    pathPart = `/blob/${encodeURIComponent(branch)}/${path}`;
  }
  if (startLine && endLine && startLine !== endLine) {
    pathPart += `#L${startLine}-L${endLine}`;
  } else if (startLine) {
    pathPart += `#L${startLine}`;
  }
  return pathPart;
}

/**
 * Build the full URL by composing the host base with the permalink path.
 * Strips a trailing slash from the host base so we don't end up with
 * `github.com//blob/...`.
 */
export function buildPermalinkUrl(
  hostBase: string,
  branch: string,
  path: string,
  startLine?: number,
  endLine?: number,
): string {
  const base = hostBase.replace(/\/+$/, '');
  return base + buildPermalinkPath(base, branch, path, startLine, endLine);
}

/**
 * Sanity classifier for the composer.
 *
 *   - `empty`: nothing to compose (no prefix, no selection, no path).
 *   - `prefix-only`: user typed prose but no code anchor.
 *   - `selection-only`: code-fence with no prose.
 *   - `full`: prose + selection (with or without a permalink).
 *   - `too-large`: selection > 200 lines (we still let it through but
 *     warn the user — long quotes are noise on a PR comment).
 *
 * Returned shape lets the view decide whether to surface a "preview
 * looks light, are you sure?" confirm before posting.
 */
export type ComposeShape = 'empty' | 'prefix-only' | 'selection-only' | 'full' | 'too-large';

export function classifyComposeShape(args: ComposeArgs): ComposeShape {
  const prefix = (args.userPrefix ?? '').trim();
  const selection = (args.selectionText ?? '').trim();
  const lineCount = selection ? selection.split('\n').length : 0;
  if (!prefix && !selection) return 'empty';
  if (lineCount > 200) return 'too-large';
  if (prefix && selection) return 'full';
  if (selection) return 'selection-only';
  return 'prefix-only';
}
