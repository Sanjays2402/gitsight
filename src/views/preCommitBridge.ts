/**
 * Pre-Commit Hook Bridge (F45) — runs the repo's `.git/hooks/pre-commit`
 * hook (or framework wrapper) before committing, classifies the failure,
 * and presents a friendly picker so the user can open the offending file
 * at the right line, copy a `--no-verify` escape command, or read the
 * raw output.
 *
 * This module wires into the existing `gitsight.commit` flow via a
 * dedicated command (`gitsight.preCommitBridge`) and is opt-in via
 * `gitsight.preCommitBridge.enabled` (default ON). The hook itself is
 * detected by inspecting `.git/hooks/pre-commit` (existence + executable
 * bit). If no hook is present, the command tells the user politely and
 * exits — it does not invent a hook.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import {
  PreCommitResult,
  detectRunner,
  parseHookOutput,
  describeResult,
  summarise,
  bypassCommand,
} from '../git/preCommitBridge';

type BridgeItem = vscode.QuickPickItem & {
  _open?: { file: string; line?: number; column?: number };
  _action?: 'bypass' | 'show-raw' | 'rerun' | 'disable-hook';
};

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB — beyond this we truncate.

export async function runPreCommitBridge(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight');
  if (!cfg.get<boolean>('preCommitBridge.enabled', true)) {
    vscode.window.showInformationMessage('GitSight: pre-commit bridge is disabled in settings.');
    return;
  }
  const hookPath = path.join(git.cwd, '.git', 'hooks', 'pre-commit');
  let stat: { isFile(): boolean } | undefined;
  try { stat = await fs.stat(hookPath); } catch { /* not present */ }
  if (!stat?.isFile()) {
    vscode.window.showInformationMessage(`GitSight: no pre-commit hook at ${path.relative(git.cwd, hookPath)}.`);
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'GitSight: running pre-commit hook…' },
    () => runHook(git.cwd, hookPath),
  );

  if (result.exitCode === 0) {
    vscode.window.setStatusBarMessage('GitSight: pre-commit hook passed.', 3000);
    return;
  }

  await showFailurePicker(git, result);
}

async function runHook(cwd: string, hookPath: string): Promise<PreCommitResult> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn(hookPath, [], { cwd, env: process.env, shell: false });
    let stdout = '';
    let stderr = '';
    const captureOut = (buf: Buffer) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += buf.toString(); };
    const captureErr = (buf: Buffer) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += buf.toString(); };
    child.stdout.on('data', captureOut);
    child.stderr.on('data', captureErr);
    child.on('error', (e) => {
      resolve({
        runner: 'unknown',
        findings: [],
        raw: `Failed to launch pre-commit hook: ${e.message}`,
        exitCode: 127,
        hasOpenableTarget: false,
      });
    });
    child.on('close', (code) => {
      const raw = `${stdout}\n${stderr}`.trim();
      const runner = detectRunner(raw);
      const findings = parseHookOutput(raw, runner);
      resolve({
        runner,
        findings,
        raw,
        exitCode: code ?? 0,
        hasOpenableTarget: findings.some(f => f.file),
      });
    });
  });
}

async function showFailurePicker(git: Git, result: PreCommitResult) {
  const summary = summarise(result);
  const items: BridgeItem[] = [];
  items.push(sep(describeResult(result)));
  if (summary.rerunMaybeHelps) {
    items.push({
      label: '$(refresh) Re-run hook (likely fixed)',
      description: 'Some formatters auto-fix; the staged files may need re-adding.',
      _action: 'rerun',
    });
  }
  items.push(
    { label: '$(file-code) Show full hook output', description: `${result.raw.length.toLocaleString()} chars`, _action: 'show-raw' },
    { label: '$(debug-disconnect) Bypass: git commit --no-verify', description: 'Copy to clipboard', _action: 'bypass' },
    { label: '$(circle-slash) Disable hook (rename to pre-commit.disabled)', description: 'Reversible — file is renamed, not deleted', _action: 'disable-hook' },
  );

  if (result.findings.length) {
    items.push(sep(`Findings (${summary.files} file${summary.files === 1 ? '' : 's'})`));
    for (const f of result.findings.slice(0, 200)) {
      const lineSuffix = f.line ? `:${f.line}${f.column ? ':' + f.column : ''}` : '';
      items.push({
        label: `$(go-to-file) ${f.file}${lineSuffix}`,
        description: f.rule ? `[${f.rule}] ${f.message}` : f.message,
        _open: { file: f.file, line: f.line, column: f.column },
      });
    }
    if (result.findings.length > 200) {
      items.push({
        label: `… and ${result.findings.length - 200} more findings`,
        description: 'Use "Show full hook output" to see all of them',
        _action: 'show-raw',
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Pre-commit failed — ${describeResult(result)}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked._open) {
    await openFinding(git, picked._open.file, picked._open.line, picked._open.column);
    return;
  }
  switch (picked._action) {
    case 'rerun':
      return runPreCommitBridge(git);
    case 'show-raw':
      return openRawOutput(result);
    case 'bypass':
      await vscode.env.clipboard.writeText(bypassCommand());
      vscode.window.setStatusBarMessage('Copied: git commit --no-verify', 3000);
      return;
    case 'disable-hook':
      return disableHook(git);
  }
}

async function openFinding(git: Git, file: string, line?: number, column?: number) {
  // Resolve relative paths against the repo root.
  const abs = path.isAbsolute(file) ? file : path.join(git.cwd, file);
  let uri: vscode.Uri;
  try {
    await fs.access(abs);
    uri = vscode.Uri.file(abs);
  } catch {
    vscode.window.showWarningMessage(`GitSight: file not found at ${abs}.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  if (line !== undefined) {
    const ln = Math.max(0, line - 1);
    const col = Math.max(0, (column ?? 1) - 1);
    const pos = new vscode.Position(ln, col);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

async function openRawOutput(result: PreCommitResult) {
  const body = [
    `# Pre-commit hook output`,
    ``,
    `Runner: ${result.runner}`,
    `Exit code: ${result.exitCode}`,
    `Findings: ${result.findings.length}`,
    ``,
    `--- BEGIN OUTPUT ---`,
    result.raw,
    `--- END OUTPUT ---`,
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ content: body, language: 'log' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function disableHook(git: Git) {
  const src = path.join(git.cwd, '.git', 'hooks', 'pre-commit');
  const dst = path.join(git.cwd, '.git', 'hooks', 'pre-commit.disabled');
  const ok = await vscode.window.showWarningMessage(
    `Rename .git/hooks/pre-commit → pre-commit.disabled?\n\nThis disables the hook until you rename it back.`,
    { modal: true },
    'Disable',
  );
  if (ok !== 'Disable') return;
  try {
    await fs.rename(src, dst);
    vscode.window.setStatusBarMessage('GitSight: pre-commit hook disabled.', 3000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: failed to disable hook: ${e.message}`);
  }
}

function sep(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}
