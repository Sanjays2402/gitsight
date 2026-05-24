import * as vscode from 'vscode';
import { Git } from '../git/git';
import { runCopilotPrompt } from './copilot';

const SYSTEM_PROMPT = `You are a senior code reviewer. Review the diff and respond as markdown:
## Summary
1-2 sentence overview.

## Issues
List concrete problems (bugs, security, performance, correctness, missing tests). For each: file:line if possible, severity (🔴 High / 🟡 Medium / 🟢 Low), explanation, suggested fix.

## Nits
Style/clarity nits worth mentioning.

## Approval
APPROVE / REQUEST_CHANGES / COMMENT — with one sentence why.

Rules: be specific, cite line numbers from the diff, no fluff, no emoji in headers (only severity), no compliments.`;

export async function reviewStaged(ctx: vscode.ExtensionContext, git: Git) {
  let diff = await git.diff({ staged: true });
  let label = 'staged';
  if (!diff.trim()) {
    diff = await git.diff();
    label = 'working tree';
  }
  if (!diff.trim()) {
    return vscode.window.showInformationMessage('Nothing to review (no diff in staged or working tree).');
  }
  await review(ctx, diff, label);
}

export async function reviewCommit(ctx: vscode.ExtensionContext, git: Git, sha: string) {
  const out = await git.show(sha);
  await review(ctx, out, `commit ${sha.slice(0, 7)}`);
}

export async function reviewRange(ctx: vscode.ExtensionContext, git: Git) {
  const range = await vscode.window.showInputBox({
    prompt: 'Range to review (e.g. main..HEAD)',
    value: 'main..HEAD',
  });
  if (!range) return;
  const diff = await git.raw(['diff', range]);
  if (!diff.trim()) return vscode.window.showInformationMessage('Empty diff.');
  await review(ctx, diff, range);
}

async function review(ctx: vscode.ExtensionContext, diff: string, label: string) {
  const truncated = diff.length > 14000 ? diff.slice(0, 14000) + '\n...[truncated]' : diff;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: AI review (${label})` },
    async () => {
      const md = await runCopilotPrompt(ctx, SYSTEM_PROMPT, `Reviewing ${label}:\n\n${truncated}`);
      const doc = await vscode.workspace.openTextDocument({
        content: `# AI Code Review — ${label}\n\n${md}`,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    },
  );
}
