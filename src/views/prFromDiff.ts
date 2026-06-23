/**
 * F118 - PR Description from Active Diff.
 *
 * Extends F87 (selection-scoped) with a multi-file gather. When the
 * user is composing a sprawling PR, they don't want to manually pick
 * a single selection - they want the AI to look at the WHOLE change
 * set and write something a reviewer can use.
 *
 * Flow:
 *   1. Resolve the current branch + base (origin/HEAD or fallback to
 *      main/master).
 *   2. Gather changed files via `git diff <base>..HEAD --numstat -z`.
 *   3. Classify (empty / too-small / too-large-files / too-large-lines
 *      / binary-heavy / ok).
 *   4. Per file, fetch a bounded diff snippet via `git diff
 *      <base>..HEAD -- <file>`.
 *   5. Build the multi-file prompt + send to Copilot.
 *   6. Open the result in a markdown editor with Copy + suggest-title
 *      input box + gh-CLI create-via-clipboard hook.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { runCopilotPrompt } from '../ai/copilot';
import {
  parseNumstatNul,
  classifyDiff,
  buildDiffPrompt,
  summariseDiff,
  suggestDiffPrTitle,
  DiffFileEntry,
} from '../git/prFromDiff';

const pexec = promisify(execFile);

const SYSTEM_PROMPT = `You write Pull Request descriptions for multi-file changes.
Output format (markdown):

## Summary
<2-3 sentences: WHY of the change.>

## What's in the PR
- <bullet per area touched (max 5)>

## Behaviour change
- <user-visible shifts or invariants>

## Reviewer notes
- <decisions, cross-file invariants, follow-ups>

## Test plan
- [ ] <reviewer verification steps>

Rules:
- Cover the WHOLE change set; do not focus on one file.
- Be concrete. Use file paths in backticks.
- No emoji. No "this PR introduces" filler.
- Total length under 300 words.`;

const FILE_DIFF_MAX_LINES = 200;
const FILES_IN_PROMPT = 12;

export async function generatePrDescriptionFromDiff(ctx: vscode.ExtensionContext, git: Git): Promise<void> {
  const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  const base = await detectDefaultBranch(git);

  const numstat = await safe(git, ['diff', `${base}..HEAD`, '--numstat', '-z']);
  const stubs = parseNumstatNul(numstat);
  if (stubs.length === 0) {
    vscode.window.showWarningMessage(
      `GitSight: no diff between \`${base}\` and HEAD. Either you haven't committed yet or base is wrong.`,
    );
    return;
  }

  // Populate language + per-file diff snippets.
  const files: DiffFileEntry[] = [];
  for (const s of stubs) {
    const language = inferLanguage(s.relPath);
    const snippet = s.binary ? '' : await fetchFileDiff(git, base, s.relPath);
    files.push({
      ...s,
      language,
      diffSnippet: snippet,
    });
  }

  const verdict = classifyDiff({ files });
  if (verdict === 'empty') {
    vscode.window.showWarningMessage(`GitSight: no files changed between \`${base}\` and HEAD.`);
    return;
  }
  if (verdict === 'too-small') {
    vscode.window.showWarningMessage(
      'GitSight: diff is tiny - use "PR description from selection" (F87) for single-line changes.',
    );
    return;
  }
  if (verdict === 'too-large-files') {
    vscode.window.showWarningMessage(
      `GitSight: ${files.length} files is too many to summarise in one prompt - narrow the range or run AI-PR with batching.`,
    );
    return;
  }
  if (verdict === 'too-large-lines') {
    vscode.window.showWarningMessage(
      'GitSight: total line churn exceeds the budget. Split the PR or use the per-file approach.',
    );
    return;
  }
  if (verdict === 'binary-heavy') {
    vscode.window.showWarningMessage(
      'GitSight: most of the changed files are binary - text diff is not useful for an AI summary.',
    );
    return;
  }

  const recentSubject = (await safe(git, ['log', '-1', '--format=%s'])).trim() || undefined;

  const userPrompt = buildDiffPrompt({
    files,
    repo: { branch, base, recentSubject },
    maxFiles: FILES_IN_PROMPT,
    maxLinesPerFile: FILE_DIFF_MAX_LINES,
  });

  const text = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: drafting PR description (${files.length} files)\u2026`,
      cancellable: true,
    },
    async (_progress, token) => {
      const tokenSource = new vscode.CancellationTokenSource();
      token.onCancellationRequested(() => tokenSource.cancel());
      try {
        return await runCopilotPrompt(ctx, SYSTEM_PROMPT, userPrompt, { tokenSource });
      } catch (e: any) {
        if (token.isCancellationRequested) return undefined;
        throw e;
      }
    },
  );
  if (!text) return;

  const titleSuggestion = suggestDiffPrTitle({ files, recentSubject });
  const summary = summariseDiff(files);
  const header = `# ${titleSuggestion}\n\n_${summary}_\n\n_Base: \`${base}\` \u2194 branch: \`${branch}\`_\n\n---\n\n`;
  const finalBody = header + text;

  const doc = await vscode.workspace.openTextDocument({ content: finalBody, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);

  const action = await vscode.window.showInformationMessage(
    'GitSight: PR description ready.',
    'Copy body', 'Copy title', 'Run gh pr create',
  );
  if (action === 'Copy body') {
    await vscode.env.clipboard.writeText(finalBody);
    vscode.window.setStatusBarMessage('Copied PR body to clipboard', 2000);
  } else if (action === 'Copy title') {
    await vscode.env.clipboard.writeText(titleSuggestion);
    vscode.window.setStatusBarMessage(`Copied title: ${titleSuggestion}`, 3000);
  } else if (action === 'Run gh pr create') {
    const term = vscode.window.createTerminal({ name: 'gh pr create', cwd: git.cwd });
    term.sendText(`gh pr create --title ${quote(titleSuggestion)} --body ${quote(finalBody)}`);
    term.show(true);
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

async function detectDefaultBranch(git: Git): Promise<string> {
  try {
    const sym = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (sym) return sym;
  } catch { /* may not be set */ }
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    try { await git.raw(['rev-parse', '--verify', cand]); return cand; } catch { /* skip */ }
  }
  return 'main';
}

async function fetchFileDiff(git: Git, base: string, file: string): Promise<string> {
  try {
    return await git.raw(['diff', `${base}..HEAD`, '--', file]);
  } catch { return ''; }
}

function inferLanguage(file: string): string {
  const ext = (file.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'ts': return 'typescript';
    case 'tsx': return 'typescriptreact';
    case 'js': return 'javascript';
    case 'jsx': return 'javascriptreact';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'cs': return 'csharp';
    case 'md': return 'markdown';
    case 'json': return 'json';
    case 'yaml':
    case 'yml': return 'yaml';
    case 'sh':
    case 'bash': return 'shellscript';
    case 'css': return 'css';
    case 'html': return 'html';
    default: return 'plaintext';
  }
}

function quote(s: string): string {
  // Single-quoted shell-safe quoting; embedded single quotes become '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
