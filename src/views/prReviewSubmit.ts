/**
 * F123 - PR Review Submitter.
 *
 * Composes with F75 (review-request inbox), F88 (comments inbox), F93
 * (comment composer) and F105 (inactive reviewer nudger). Those let
 * you READ pending review work and POST individual comments; this one
 * lets you SUBMIT a review verdict via `gh pr review`.
 *
 * Two surfaces:
 *
 *   gitsight.submitPrReview           interactive verdict + body picker
 *                                     (verdict picker -> body editor ->
 *                                      modal preview -> gh pr review)
 *   gitsight.submitPrReviewApprove    one-shot approve (skips body)
 *                                     - explicit guard so users who
 *                                       want quick "LGTM ship it"
 *                                       reviews don't have to walk the
 *                                       full flow each time
 *
 * Flow:
 *   1. Locate the open PR for the current branch via gh pr view --json,
 *      OR accept an explicit number from a PR tree-item arg.
 *   2. (Interactive only) pick verdict via QuickPick.
 *   3. (When body required or chosen) open a scratch markdown buffer
 *      for the body, with template scaffolding for request-changes.
 *   4. Run classifyReviewSubmission for safety gates.
 *   5. Modal confirm with body preview + warnings.
 *   6. Run `gh pr review <num> --<verdict> [--body-file -]` via
 *      execFile (stdin pipe pattern from F93/prCommentCompose).
 *   7. Surface link to the posted review on success.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  classifyReviewSubmission,
  buildReviewArgs,
  actionHeadline,
  summariseReviewBody,
  ReviewVerdict,
} from '../git/prReviewSubmit';

const pexec = promisify(execFile);

export async function submitPrReview(repos: RepoManager, arg?: any): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH.');
    return;
  }
  const prNumber = await resolvePrNumber(git, arg);
  if (!prNumber) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
    return;
  }

  const verdict = await pickVerdict();
  if (!verdict) return;

  let body = '';
  if (verdict !== 'approve' || (await shouldIncludeBodyForApprove())) {
    const captured = await captureBody(verdict);
    if (captured === undefined) return;
    body = captured;
  }

  await runSubmit(git, prNumber, verdict, body);
}

export async function approvePrQuick(repos: RepoManager, arg?: any): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH.');
    return;
  }
  const prNumber = await resolvePrNumber(git, arg);
  if (!prNumber) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch.');
    return;
  }
  // Quick approve = no body. Still run through classify to catch
  // PR-number issues.
  await runSubmit(git, prNumber, 'approve', '');
}

async function runSubmit(git: Git, prNumber: number, verdict: ReviewVerdict, body: string): Promise<void> {
  const verdictRecord = classifyReviewSubmission({ verdict, prNumber, body });
  if (verdictRecord.kind === 'blocked') {
    vscode.window.showErrorMessage(`GitSight: ${verdictRecord.reason}`);
    return;
  }
  const headline = actionHeadline({ verdict, prNumber });
  const preview = body.trim() ? summariseReviewBody(body, { budget: 600 }) : '(no body)';
  const warnings = verdictRecord.warnings.length
    ? `Warnings:\n${verdictRecord.warnings.map(w => `- ${w}`).join('\n')}\n\n`
    : '';
  const detail = `${warnings}Preview:\n${preview}`;
  const proceed = await vscode.window.showWarningMessage(
    headline,
    { modal: true, detail },
    'Submit',
  );
  if (proceed !== 'Submit') return;

  await postReview(git, prNumber, verdict, body);
}

async function postReview(git: Git, prNumber: number, verdict: ReviewVerdict, body: string): Promise<void> {
  const args = buildReviewArgs({ verdict, prNumber, body });
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: submitting ${verdict} review on PR #${prNumber}\u2026` },
    async () => {
      try {
        const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          const child = execFile('gh', args, { cwd: git.cwd, maxBuffer: 8 * 1024 * 1024 }, (err) => {
            if (err) reject(Object.assign(err, { _stderr: stderr, _stdout: stdout })); else resolve({ stdout, stderr });
          });
          child.stdout?.on('data', d => { stdout += d.toString(); });
          child.stderr?.on('data', d => { stderr += d.toString(); });
          if (body && body.trim() && child.stdin) {
            child.stdin.write(body);
            child.stdin.end();
          } else if (child.stdin) {
            // approve with no body still needs stdin closed cleanly
            child.stdin.end();
          }
        });
        // gh pr review prints "Reviewed pull request <url>"; tolerate
        // missing URL and just show a confirmation.
        const url = extractReviewUrl(result.stdout);
        if (url) {
          const action = await vscode.window.showInformationMessage(
            `GitSight: ${verdict} review submitted on PR #${prNumber}.`,
            'Open in browser', 'Copy URL',
          );
          if (action === 'Open in browser') await vscode.env.openExternal(vscode.Uri.parse(url));
          if (action === 'Copy URL') await vscode.env.clipboard.writeText(url);
        } else {
          vscode.window.setStatusBarMessage(`GitSight: ${verdict} review submitted on PR #${prNumber}.`, 4000);
        }
      } catch (e: any) {
        const stderr = String(e?._stderr ?? e?.stderr ?? e?.message ?? '').split('\n').find((l: string) => l.trim()) ?? 'unknown error';
        vscode.window.showErrorMessage(`GitSight: gh pr review failed - ${stderr}`);
      }
    },
  );
}

function extractReviewUrl(stdout: string): string | undefined {
  if (!stdout) return undefined;
  const m = /https?:\/\/\S+/.exec(stdout);
  return m ? m[0] : undefined;
}

async function pickVerdict(): Promise<ReviewVerdict | undefined> {
  const items: (vscode.QuickPickItem & { _v: ReviewVerdict })[] = [
    { label: '$(check) Approve', description: 'LGTM / ship it', _v: 'approve' },
    { label: '$(diff-removed) Request changes', description: 'block the merge until fixed - requires a body', _v: 'request-changes' },
    { label: '$(comment) Comment', description: 'observations without a verdict - requires a body', _v: 'comment' },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Review verdict' });
  return picked?._v;
}

async function shouldIncludeBodyForApprove(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('gitsight.prReview');
  const askMode = cfg.get<string>('approveBodyPrompt', 'ask');
  if (askMode === 'never') return false;
  if (askMode === 'always') return true;
  // ask
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(check) Approve without a body', _b: false },
      { label: '$(edit) Approve with a body', _b: true },
    ] as Array<vscode.QuickPickItem & { _b: boolean }>,
    { placeHolder: 'Add a body to the approval?' },
  );
  return !!picked?._b;
}

async function captureBody(verdict: ReviewVerdict): Promise<string | undefined> {
  const scaffold = verdict === 'request-changes'
    ? `<!-- describe what needs to change -->\n\n## What needs to change\n\n- \n\n## Why\n\n`
    : verdict === 'comment'
    ? `<!-- observation - no verdict -->\n\n`
    : `<!-- optional approval body -->\n\nLGTM. \n`;
  const doc = await vscode.workspace.openTextDocument({ content: scaffold, language: 'markdown' });
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  // Wait for the user to indicate they're done.
  const action = await vscode.window.showInformationMessage(
    'GitSight: edit the review body, then click Continue when done.',
    { modal: false },
    'Continue', 'Cancel',
  );
  if (action !== 'Continue') {
    // Close the document
    try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    return undefined;
  }
  // Strip leading scaffold comments before returning
  const text = editor.document.getText();
  const stripped = stripScaffoldComments(text);
  try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
  return stripped;
}

function stripScaffoldComments(s: string): string {
  return s.replace(/^\s*<!--[\s\S]*?-->\s*\n?/gm, '').trim();
}

async function resolvePrNumber(git: Git, arg: any): Promise<number | undefined> {
  if (arg && typeof arg === 'object' && typeof arg.number === 'number' && arg.number > 0) return arg.number;
  if (typeof arg === 'number' && arg > 0) return arg;
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'number'], {
      cwd: git.cwd, timeout: 5000, maxBuffer: 256 * 1024,
    });
    const obj = JSON.parse(stdout);
    const n = Number(obj?.number);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return undefined;
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}
