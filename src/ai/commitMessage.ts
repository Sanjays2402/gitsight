import * as vscode from 'vscode';

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

export async function generateCommitMessage(diff: string): Promise<string> {
  if (!diff.trim()) throw new Error('Nothing staged. Stage changes first.');
  const truncated = diff.length > 12000 ? diff.slice(0, 12000) + '\n...[truncated]' : diff;
  return runAI(`${SYSTEM_PROMPT}\n\nGenerate a commit message for this diff:\n\n${truncated}`);
}

export async function explainCommit(showOutput: string): Promise<string> {
  const truncated = showOutput.length > 12000 ? showOutput.slice(0, 12000) + '\n...[truncated]' : showOutput;
  return runAI(`${EXPLAIN_PROMPT}\n\n${truncated}`);
}

async function runAI(prompt: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('gitsight.ai');
  const provider = cfg.get<string>('provider') ?? 'copilot';
  if (provider === 'copilot') return runCopilot(prompt);
  if (provider === 'ollama') return runOllama(prompt, cfg.get<string>('model') ?? 'llama3');
  throw new Error(`AI provider '${provider}' disabled.`);
}

async function runCopilot(prompt: string): Promise<string> {
  const lm = (vscode as any).lm;
  if (!lm?.selectChatModels) throw new Error('VS Code Language Model API unavailable. Update VS Code.');
  const models = await lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) throw new Error('No Copilot model available. Sign in to GitHub Copilot.');
  const LMM = (vscode as any).LanguageModelChatMessage;
  const res = await models[0].sendRequest([LMM.User(prompt)], {}, new vscode.CancellationTokenSource().token);
  let text = '';
  for await (const chunk of res.text) text += chunk;
  return text.trim();
}

async function runOllama(prompt: string, model: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama: ${res.status}`);
  const data = (await res.json()) as { response: string };
  return data.response.trim();
}
