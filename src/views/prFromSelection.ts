/**
 * F87 — PR Description from Selection.
 *
 * Takes the active editor's selection + a small window of surrounding
 * context, builds a tightly-scoped prompt with `buildSelectionPrompt`,
 * and asks Copilot to write a *micro-PR* description focused on JUST
 * that change. Output opens in a markdown editor with copy + gh-CLI
 * follow-up actions.
 *
 * Why a separate command from F2 (full-branch PR description)? F2
 * summarises the whole branch; F87 summarises a single selected change.
 * Useful when:
 *
 *   - You're carving a sprawling branch into reviewable slices.
 *   - You're writing a documentation PR around one function.
 *   - You want a draft to feed into `gh pr create --body-file -`
 *     for a single-commit branch.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from '../git/git';
import { runCopilotPrompt } from '../ai/copilot';
import {
  buildSelectionPrompt,
  classifySelection,
  formatSelectionBlock,
  suggestPrTitle,
  SelectionContext,
} from '../git/prFromSelection';

const SYSTEM_PROMPT = `You write tight, single-purpose Pull Request descriptions.
Output format (markdown, no fences around the whole thing):

## Summary
<2-3 sentences: WHY of the change. No marketing.>

## Change
- <1-3 bullets describing what changed in the selection>

## Reviewer notes
- <decisions, edge cases, or context the reviewer needs to land this fast>

## Test plan
- [ ] <how the reviewer should verify locally>

Rules:
- Stay scoped to the SELECTED change. Do not describe the surrounding context
  as if it were also changing.
- Be concrete. Reference function names and file paths only where they help.
- No emoji. No marketing speak. No "this PR introduces..." filler.
- Total length under 200 words.`;

const CONTEXT_WINDOW = 30;

export async function generatePrDescriptionFromSelection(
  ctx: vscode.ExtensionContext,
  git: Git,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('GitSight: open a file and select the change you want to describe.');
    return;
  }
  const sel = editor.selection;
  if (sel.isEmpty) {
    vscode.window.showWarningMessage('GitSight: select the change first — then run "PR description from selection".');
    return;
  }
  const doc = editor.document;
  const selectionText = doc.getText(sel);
  const relPath = path.relative(git.cwd, doc.uri.fsPath);

  // Context window — N lines before/after the selection, clamped to doc bounds.
  const startLine = sel.start.line; // 0-indexed
  const endLine = sel.end.line;     // 0-indexed
  const contextStartLine = Math.max(0, startLine - CONTEXT_WINDOW);
  const contextEndLine = Math.min(doc.lineCount - 1, endLine + CONTEXT_WINDOW);
  const contextBefore = sliceLines(doc, contextStartLine, startLine - 1);
  const contextAfter = sliceLines(doc, endLine + 1, contextEndLine);

  const selectionCtx: SelectionContext = {
    relPath,
    language: doc.languageId,
    startLine: startLine + 1,
    endLine: endLine + 1,
    selectionText,
    contextBefore: contextBefore || undefined,
    contextAfter: contextAfter || undefined,
  };

  const verdict = classifySelection(selectionCtx);
  if (verdict === 'empty') {
    vscode.window.showWarningMessage('GitSight: selection is empty after trimming whitespace.');
    return;
  }
  if (verdict === 'too-small') {
    vscode.window.showWarningMessage('GitSight: select at least 2 lines so the AI has something to describe.');
    return;
  }
  if (verdict === 'too-large') {
    vscode.window.showWarningMessage(
      'GitSight: selection is over 400 lines. Use `gitsight.aiPullRequest` for whole-branch summaries instead.',
    );
    return;
  }

  const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  const base = await detectDefaultBranch(git);
  const recentSubject = (await safe(git, [
    'log', '-1', '--format=%s', '--', relPath,
  ])).trim() || undefined;

  const userPrompt = buildSelectionPrompt({
    selection: selectionCtx,
    repo: { branch, base },
    recentSubject,
    maxContextLines: CONTEXT_WINDOW,
  });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: drafting micro-PR for ${relPath}:${selectionCtx.startLine}-${selectionCtx.endLine}\u2026`,
      cancellable: true,
    },
    async (_p, token) => {
      const tokenSource = new vscode.CancellationTokenSource();
      token.onCancellationRequested(() => tokenSource.cancel());

      let body: string;
      try {
        body = await runCopilotPrompt(ctx, SYSTEM_PROMPT, userPrompt, { tokenSource });
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`);
        return;
      }

      const titleDefault = suggestPrTitle({ selection: selectionCtx, recentSubject });
      const headerLine = `# ${titleDefault}`;
      const preview = `${headerLine}\n\n${body.trim()}\n\n---\n\n${formatSelectionBlock(selectionCtx)}\n`;
      const md = await vscode.workspace.openTextDocument({ language: 'markdown', content: preview });
      await vscode.window.showTextDocument(md, vscode.ViewColumn.Beside);

      const action = await vscode.window.showInformationMessage(
        'GitSight: micro-PR description drafted from selection.',
        'Copy to clipboard',
        'Open in gh CLI',
      );
      if (action === 'Copy to clipboard') {
        await vscode.env.clipboard.writeText(preview);
        vscode.window.setStatusBarMessage('PR description copied', 2000);
      } else if (action === 'Open in gh CLI') {
        const term = vscode.window.createTerminal({ name: 'GitSight: gh pr create', cwd: git.cwd });
        term.show();
        const safeBase = base.replace(/^[^/]+\//, '');
        const escaped = preview.replace(/'/g, `'\\''`);
        term.sendText(
          `printf '%s' '${escaped}' | gh pr create --base ${safeBase} --title ${JSON.stringify(titleDefault)} --body-file -`,
        );
      }
    },
  );
}

function sliceLines(doc: vscode.TextDocument, fromLine: number, toLine: number): string {
  if (toLine < fromLine) return '';
  const lines: string[] = [];
  for (let i = fromLine; i <= toLine; i++) {
    lines.push(doc.lineAt(i).text);
  }
  return lines.join('\n');
}

async function detectDefaultBranch(git: Git): Promise<string> {
  try {
    const out = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out;
  } catch { /* not set */ }
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    try { await git.raw(['rev-parse', '--verify', cand]); return cand; } catch { /* skip */ }
  }
  return 'main';
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
