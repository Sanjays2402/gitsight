import * as vscode from 'vscode';
import { runCopilotPrompt } from './copilot';

const SYSTEM_PROMPT = `You write Conventional Commits messages from git diffs.
Rules:
- Format: <type>(<scope>): <subject>
- type ∈ feat, fix, docs, refactor, perf, test, build, ci, chore, style
- Subject ≤ 72 chars, imperative mood, no trailing period, no emoji.
- If meaningful, add a blank line + 1-3 bullet body lines starting with '- '.
- Output ONLY the commit message — no fences, no commentary.`;

const EXPLAIN_PROMPT = `Explain this git commit in plain English for a developer reviewing it.
Cover: what changed, why it likely changed, risk level, suggested test focus.
Keep it under 200 words. No fluff.`;

export async function generateCommitMessage(
  ctx: vscode.ExtensionContext,
  diff: string,
): Promise<string> {
  if (!diff.trim()) throw new Error('Nothing staged. Stage changes first.');
  const truncated = diff.length > 12000 ? diff.slice(0, 12000) + '\n...[truncated]' : diff;
  return runCopilotPrompt(ctx, SYSTEM_PROMPT, `Generate a commit message for this diff:\n\n${truncated}`);
}

export async function explainCommit(
  ctx: vscode.ExtensionContext,
  showOutput: string,
): Promise<string> {
  const truncated = showOutput.length > 12000 ? showOutput.slice(0, 12000) + '\n...[truncated]' : showOutput;
  return runCopilotPrompt(ctx, EXPLAIN_PROMPT, truncated);
}
