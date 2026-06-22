/**
 * F93 — PR Comment Composer.
 *
 * Pairs with F88 (PR Comments Inbox). Compose a top-level PR comment
 * from the editor's current selection + an optional prose prefix, then
 * post via `gh pr comment <num> --body-file -`.
 *
 * Flow:
 *   1. Locate the open PR for the current branch (`gh pr view --json number`)
 *      OR accept an explicit number from a PR tree-item arg.
 *   2. Capture the active editor's selection + path + language.
 *   3. Prompt for prose (optional) via showInputBox.
 *   4. Compose the markdown body via composeCommentBody().
 *   5. Show a preview modal with the body + "Post" / "Copy" / "Cancel".
 *   6. Post via gh, surfacing the comment URL on success.
 *
 * Inline review comments require the gh API directly and a different
 * payload shape; not in this slice. The placeHolder explains that the
 * comment is "top-level (conversation tab)" so the user has the right
 * mental model.
 *
 * Degrades:
 *   - gh missing / unauthed: warning toast.
 *   - No active editor + no prose prompt result: bail.
 *   - No open PR for branch + no explicit number: bail with hint.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { Git, remoteWebUrl } from '../git/git';
import {
  composeCommentBody,
  classifyComposeShape,
  buildPermalinkUrl,
  ComposeArgs,
} from '../git/prCommentCompose';

const pexec = promisify(execFile);

export async function composeAndPostPrComment(git: Git, prNumberArg?: number): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  const prNumber = await resolvePrNumber(git, prNumberArg);
  if (!prNumber) {
    vscode.window.showInformationMessage(
      'GitSight: no open PR for the current branch — open one first, or invoke from a PR tree item.',
    );
    return;
  }

  // Capture editor context.
  const editor = vscode.window.activeTextEditor;
  let composeInput: ComposeArgs = { selectionText: '' };
  if (editor) {
    const sel = editor.selection;
    const selText = !sel.isEmpty ? editor.document.getText(sel) : '';
    const repoRel = relPath(git.cwd, editor.document.uri.fsPath);
    const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined;
    const permalink = await buildPermalink(git, branch, repoRel, sel.start.line + 1, sel.end.line + 1);
    composeInput = {
      selectionText: selText,
      path: repoRel,
      startLine: !sel.isEmpty ? sel.start.line + 1 : undefined,
      endLine: !sel.isEmpty ? sel.end.line + 1 : undefined,
      language: editor.document.languageId,
      branch,
      permalink,
    };
  }

  // Prose prompt.
  const placeholderHint = composeInput.selectionText
    ? `Top-level comment on PR #${prNumber} (selection will be quoted)`
    : `Top-level comment on PR #${prNumber} (no selection — just prose)`;
  const userPrefix = await vscode.window.showInputBox({
    prompt: 'Your comment (markdown ok). Leave empty to just quote the selection.',
    placeHolder: placeholderHint,
    ignoreFocusOut: true,
  });
  // Distinguish "cancelled" (undefined) from "empty submission".
  if (userPrefix === undefined) return;
  composeInput.userPrefix = userPrefix;

  const shape = classifyComposeShape(composeInput);
  if (shape === 'empty') {
    vscode.window.showInformationMessage('GitSight: nothing to post (empty prose + no selection).');
    return;
  }
  if (shape === 'too-large') {
    const proceed = await vscode.window.showWarningMessage(
      'GitSight: your selection is larger than 200 lines — that\u2019s a lot for a single comment thread.',
      { modal: true },
      'Post anyway',
    );
    if (proceed !== 'Post anyway') return;
  }

  const body = composeCommentBody(composeInput);

  // Preview modal.
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: body });
  await vscode.window.showTextDocument(doc, { preview: true });

  const action = await vscode.window.showInformationMessage(
    `GitSight: post this comment to PR #${prNumber}?`,
    { modal: true, detail: `Mode: ${shape}` },
    'Post', 'Copy to clipboard',
  );
  if (action === 'Copy to clipboard') {
    await vscode.env.clipboard.writeText(body);
    vscode.window.setStatusBarMessage(`GitSight: copied comment body for PR #${prNumber}`, 3000);
    return;
  }
  if (action !== 'Post') return;

  await postComment(git, prNumber, body);
}

async function postComment(git: Git, prNumber: number, body: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: posting comment on PR #${prNumber}\u2026` },
    async () => {
      try {
        const url = await new Promise<string>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          const child = execFile(
            'gh',
            ['pr', 'comment', String(prNumber), '--body-file', '-'],
            { cwd: git.cwd, maxBuffer: 8 * 1024 * 1024 },
            (err) => {
              if (err) reject(Object.assign(err, { _stderr: stderr })); else resolve(stdout.trim());
            },
          );
          child.stdout?.on('data', (d) => { stdout += d.toString(); });
          child.stderr?.on('data', (d) => { stderr += d.toString(); });
          if (child.stdin) {
            child.stdin.write(body);
            child.stdin.end();
          }
        });
        const trimmed = url.split('\n').filter(l => l.trim()).pop() ?? '';
        if (/^https?:\/\//.test(trimmed)) {
          const openIt = await vscode.window.showInformationMessage(
            `GitSight: posted comment to PR #${prNumber}.`,
            'Open in browser', 'Copy URL',
          );
          if (openIt === 'Open in browser') await vscode.env.openExternal(vscode.Uri.parse(trimmed));
          if (openIt === 'Copy URL') await vscode.env.clipboard.writeText(trimmed);
        } else {
          vscode.window.setStatusBarMessage(`GitSight: posted comment to PR #${prNumber}.`, 4000);
        }
      } catch (e: any) {
        const stderr = String((e?._stderr ?? e?.stderr ?? e?.message ?? '')).split('\n')[0];
        vscode.window.showErrorMessage(`GitSight: gh pr comment failed \u2014 ${stderr || 'unknown error'}`);
      }
    },
  );
}

async function buildPermalink(
  git: Git,
  branch: string | undefined,
  repoRel: string | undefined,
  startLine: number,
  endLine: number,
): Promise<string | undefined> {
  if (!branch || !repoRel) return undefined;
  try {
    const remotesRaw = (await safe(git, ['remote', 'get-url', 'origin'])).trim();
    if (!remotesRaw) return undefined;
    const web = remoteWebUrl(remotesRaw);
    if (!web) return undefined;
    return buildPermalinkUrl(web, branch, repoRel, startLine, endLine);
  } catch {
    return undefined;
  }
}

function relPath(cwd: string, abs: string): string | undefined {
  if (!abs) return undefined;
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..')) return undefined;
  return rel.split(path.sep).join('/');
}

async function resolvePrNumber(git: Git, arg?: number): Promise<number | undefined> {
  if (arg && Number.isFinite(arg) && arg > 0) return arg;
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'number'], { cwd: git.cwd, maxBuffer: 1024 * 1024 });
    const obj = JSON.parse(stdout);
    const n = Number(obj?.number);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000, maxBuffer: 64 * 1024 }); return true; }
  catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
