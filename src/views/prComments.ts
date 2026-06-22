/**
 * F88 — PR Comments Inbox.
 *
 * Pairs with F75 review-request inbox. Where F75 surfaces "PRs awaiting
 * your review", this surfaces "comments left on a specific PR" so you
 * can jump from any comment straight to the file:line in the editor
 * (or open the comment URL in the browser when there's no file context).
 *
 * Flow:
 *   1. Resolve the target PR — defaults to the open PR for the current
 *      branch (`gh pr view`). When the user passes an explicit PR number
 *      arg (from a command-pal invocation), use that instead.
 *   2. Fetch all comments via
 *      `gh pr view <num> --json comments,reviewComments,reviews,number,title,url`.
 *   3. Classify, sort (unresolved-inline first, then other inline, then
 *      threads/summaries; newest first within each tier), and show a
 *      picker.
 *   4. Picking an entry:
 *        - inline + file resolves to git.cwd: open the file at line
 *          (use vscode.Range to center the viewport)
 *        - everything else: open the comment URL in the browser.
 *      A second QuickPick offers "Open in browser" / "Copy URL" / "Open
 *      file at line" so the user can override the default action.
 *
 * Degrades gracefully:
 *   - gh CLI missing: warning toast + bail.
 *   - gh not authenticated: warning toast + bail.
 *   - No open PR + no explicit arg: informational toast + bail.
 *   - PR has no comments: informational toast + bail.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import {
  parsePrComments,
  sortComments,
  describeCommentLabel,
  describeCommentDetail,
  glyphForComment,
  describeCommentsSummary,
  PrCommentEntry,
} from '../git/prComments';

const pexec = promisify(execFile);

export async function showPrCommentsInbox(git: Git, prNumberArg?: number): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  // 1. Resolve the PR.
  const prNumber = await resolvePrNumber(git, prNumberArg);
  if (!prNumber) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch (and no PR number provided).');
    return;
  }

  // 2. Fetch all comments.
  const raw = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: loading comments on PR #${prNumber}\u2026` },
    () => fetchComments(git, prNumber),
  );
  if (raw === undefined) return; // network/auth error already surfaced

  const all = parsePrComments(raw);
  if (!all.length) {
    vscode.window.showInformationMessage(`GitSight: PR #${prNumber} has no comments yet.`);
    return;
  }
  const entries = sortComments(all);

  // 3. Show the picker.
  type Pk = vscode.QuickPickItem & { _entry?: PrCommentEntry };
  const items: Pk[] = [];
  items.push({ label: describeCommentsSummary(entries), kind: vscode.QuickPickItemKind.Separator } as any);
  for (const e of entries) {
    const rel = e.createdAt ? timeAgo(new Date(e.createdAt)) : '';
    items.push({
      label: `$(${glyphForComment(e)}) ${describeCommentLabel(e, rel)}`,
      description: describeStateDescription(e),
      detail: describeCommentDetail(e),
      _entry: e,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `PR #${prNumber} comments \u00b7 ${entries.length} total`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked._entry) return;

  await runDefaultAction(git, picked._entry);
}

async function runDefaultAction(git: Git, entry: PrCommentEntry): Promise<void> {
  // Inline + path: prefer opening the file at the right line.
  if (entry.kind === 'inline' && entry.path) {
    const abs = path.join(git.cwd, entry.path);
    const exists = await fileExists(abs);
    if (exists) {
      await openAtLine(abs, entry.line ?? 1);
      // Offer a follow-up to also open the GitHub comment in the browser.
      if (entry.url) {
        vscode.window.setStatusBarMessage(`GitSight: opened ${entry.path}:${entry.line ?? 1}`, 4000);
      }
      return;
    }
    // File doesn't exist locally (renamed since the comment, or wrong branch).
    // Fall through to browser open.
    vscode.window.setStatusBarMessage(`GitSight: ${entry.path} not in workspace, opening on GitHub`, 3000);
  }
  if (entry.url) {
    await vscode.env.openExternal(vscode.Uri.parse(entry.url));
    return;
  }
  vscode.window.showInformationMessage('GitSight: this comment has no URL and no local file context.');
}

async function openAtLine(absPath: string, line: number): Promise<void> {
  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const zeroBased = Math.max(0, line - 1);
  const pos = new vscode.Position(zeroBased, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function describeStateDescription(e: PrCommentEntry): string {
  if (e.kind === 'inline') {
    return e.state === 'unresolved' ? 'unresolved' : e.state === 'resolved' ? 'resolved' : 'inline';
  }
  if (e.kind === 'review-summary') return 'review summary';
  return 'thread';
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

async function fetchComments(git: Git, prNumber: number): Promise<string | undefined> {
  try {
    const { stdout } = await pexec(
      'gh',
      [
        'pr', 'view', String(prNumber),
        '--json', 'number,title,url,comments,reviewComments,reviews',
      ],
      { cwd: git.cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? '');
    if (/not\s+authenticated/i.test(stderr)) {
      vscode.window.showWarningMessage('GitSight: gh is not authenticated. Run `gh auth login` and try again.');
    } else if (stderr.trim()) {
      vscode.window.showErrorMessage(`GitSight: gh pr view failed — ${stderr.split('\n')[0]}`);
    }
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { maxBuffer: 64 * 1024 }); return true; } catch { return false; }
}
