/**
 * F112 - Review-comment AI summary view.
 *
 * Composes with F88 PR Comments Inbox. When a PR has >= 10 real
 * comments, this view collects them via gh, builds an LM prompt, runs
 * the Copilot model, and renders the parsed result into a scratch
 * markdown document. Surfaces:
 *
 *   - `gitsight.summarisePrComments` command (palette + the prComments
 *     picker can fall through here when the user picks "Summarise
 *     discussion (AI)").
 *   - A picker offering Open in editor / Copy markdown / Cancel.
 *
 * Gating:
 *   - `shouldOfferReviewSummary` from the pure module says yes/no.
 *   - When fewer than the threshold, the command surfaces an info
 *     toast (so users invoking it from the palette aren't met with
 *     silence).
 *
 * Hard requirements:
 *   - gh CLI available + authenticated
 *   - github.com repo
 *   - Copilot model resolves (via runCopilotPrompt)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { runCopilotPrompt } from '../ai/copilot';
import {
  parsePrComments,
  PrCommentEntry,
} from '../git/prComments';
import {
  shouldOfferReviewSummary,
  buildReviewSummaryPrompt,
  parseReviewSummaryOutput,
  renderReviewSummary,
  REVIEW_SUMMARY_SYSTEM_PROMPT,
  REVIEW_SUMMARY_MIN_COMMENTS,
} from '../git/reviewSummaryAi';

const pexec = promisify(execFile);

export async function summarisePrComments(
  ctx: vscode.ExtensionContext,
  git: Git,
  prNumberArg?: number,
): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot fetch PR comments.');
    return;
  }
  const prNumber = await resolvePrNumber(git, prNumberArg);
  if (!prNumber) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch (and no PR number provided).');
    return;
  }
  const raw = await fetchComments(git, prNumber);
  if (raw === undefined) return;
  const comments = parsePrComments(raw);
  if (!shouldOfferReviewSummary(comments)) {
    vscode.window.showInformationMessage(
      `GitSight: PR #${prNumber} has ${comments.filter(c => !!c.body).length} substantive comment(s). AI summary unlocks at ${REVIEW_SUMMARY_MIN_COMMENTS}+.`,
    );
    return;
  }
  const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

  const summary = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: summarising ${comments.length} comments on PR #${prNumber}\u2026`,
      cancellable: true,
    },
    async (_p, token) => {
      const tokenSource = new vscode.CancellationTokenSource();
      token.onCancellationRequested(() => tokenSource.cancel());
      const userPrompt = buildReviewSummaryPrompt({ comments, prNumber, branch });
      let raw = '';
      try {
        raw = await runCopilotPrompt(ctx, REVIEW_SUMMARY_SYSTEM_PROMPT, userPrompt, { tokenSource });
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: ${e.message}`);
        return undefined;
      }
      return raw;
    },
  );
  if (!summary) return;
  const parsed = parseReviewSummaryOutput(summary);
  const md = renderReviewSummary(parsed, { prNumber, commentCount: comments.length });

  type Pk = vscode.QuickPickItem & { _action: 'open' | 'copy' | 'cancel' };
  const items: Pk[] = [
    { label: `PR #${prNumber} discussion summary`, kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(file) Open in scratch editor', _action: 'open' },
    { label: '$(copy) Copy markdown to clipboard', _action: 'copy' },
    { label: '$(close) Discard', _action: 'cancel' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: parsed.allResolved
      ? 'All threads appear resolved.'
      : `${parsed.questions.length} open question${parsed.questions.length === 1 ? '' : 's'}`,
  });
  if (!picked || picked._action === 'cancel') return;
  if (picked._action === 'copy') {
    await vscode.env.clipboard.writeText(md);
    vscode.window.setStatusBarMessage('GitSight: summary copied.', 2500);
    return;
  }
  if (picked._action === 'open') {
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md + '\n' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return (await git.raw(args)) ?? ''; } catch { return ''; }
}

async function resolvePrNumber(git: Git, prNumberArg?: number): Promise<number | undefined> {
  if (typeof prNumberArg === 'number' && prNumberArg > 0) return prNumberArg;
  try {
    const { stdout } = await pexec('gh', ['pr', 'view', '--json', 'number'], {
      cwd: git.cwd, timeout: 10000, maxBuffer: 256 * 1024,
    });
    const obj = JSON.parse(stdout);
    const n = Number(obj?.number);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

async function fetchComments(git: Git, prNumber: number): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view', String(prNumber),
      '--json', 'comments,reviewComments,reviews,number,title,url',
    ], { cwd: git.cwd, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh failed: ${e.message}`);
    return undefined;
  }
}

/**
 * Accept either bare number argument OR a tree-item-shaped object like
 * `{ number: 42 }` from a context menu invocation.
 */
export function normalisePrArg(arg: any): number | undefined {
  if (arg === undefined || arg === null) return undefined;
  if (typeof arg === 'number') return arg > 0 ? arg : undefined;
  if (typeof arg === 'string') { const n = Number(arg); return Number.isFinite(n) && n > 0 ? n : undefined; }
  if (typeof arg === 'object') {
    const n = Number(arg.number ?? arg.prNumber ?? arg.pr?.number);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}
