import * as vscode from 'vscode';

const MODEL_KEY = 'gitsight.ai.selectedModel';

export interface SelectedModel {
  vendor: string;
  family: string;
  id: string;
  name: string;
}

export async function listCopilotModels(): Promise<any[]> {
  const lm = (vscode as any).lm;
  if (!lm?.selectChatModels) return [];
  try {
    return await lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    return [];
  }
}

export async function promptCopilotSignIn(): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    'GitSight AI requires GitHub Copilot. Sign in to continue.',
    'Sign in to Copilot',
    'Install Copilot',
    'Cancel',
  );
  if (pick === 'Sign in to Copilot') {
    await vscode.commands.executeCommand('github.copilot.signIn').then(undefined, () => undefined);
    return true;
  }
  if (pick === 'Install Copilot') {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      'GitHub.copilot-chat',
    );
    return true;
  }
  return false;
}

export async function pickModel(ctx: vscode.ExtensionContext): Promise<SelectedModel | undefined> {
  const models = await listCopilotModels();
  if (!models.length) {
    await promptCopilotSignIn();
    return undefined;
  }
  const items = models.map((m: any) => ({
    label: m.name ?? `${m.family} (${m.id})`,
    description: `${m.vendor} · ${m.family}`,
    detail: m.id,
    model: m,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a GitHub Copilot model for GitSight AI',
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  const sel: SelectedModel = {
    vendor: picked.model.vendor,
    family: picked.model.family,
    id: picked.model.id,
    name: picked.model.name ?? picked.model.family,
  };
  await ctx.globalState.update(MODEL_KEY, sel);
  vscode.window.showInformationMessage(`GitSight: AI model set to ${sel.name}.`);
  return sel;
}

export function getSelectedModel(ctx: vscode.ExtensionContext): SelectedModel | undefined {
  return ctx.globalState.get<SelectedModel>(MODEL_KEY);
}

export async function resolveModel(ctx: vscode.ExtensionContext): Promise<any | undefined> {
  const models = await listCopilotModels();
  if (!models.length) {
    await promptCopilotSignIn();
    return undefined;
  }
  const sel = getSelectedModel(ctx);
  if (sel) {
    const match = models.find((m: any) => m.id === sel.id);
    if (match) return match;
  }
  // Auto-prefer gpt-4o / claude / latest if available, else first
  const preferred =
    models.find((m: any) => /gpt-4o|claude-3-5-sonnet|claude-sonnet/i.test(m.family ?? '')) ??
    models[0];
  return preferred;
}

export async function runCopilotPrompt(
  ctx: vscode.ExtensionContext,
  systemPrompt: string,
  userPrompt: string,
  opts: { tokenSource?: vscode.CancellationTokenSource } = {},
): Promise<string> {
  const model = await resolveModel(ctx);
  if (!model) throw new Error('No GitHub Copilot model available. Run "GitSight: Pick AI Model".');
  const LMM = (vscode as any).LanguageModelChatMessage;
  const messages = [LMM.User(`${systemPrompt}\n\n${userPrompt}`)];
  const token = (opts.tokenSource ?? new vscode.CancellationTokenSource()).token;
  const res = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const chunk of res.text) text += chunk;
  return text.trim();
}

export function modelStatusLabel(ctx: vscode.ExtensionContext): string {
  const sel = getSelectedModel(ctx);
  return sel ? sel.name : 'auto';
}
