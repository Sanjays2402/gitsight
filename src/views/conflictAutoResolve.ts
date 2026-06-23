/**
 * F113 - Auto-Resolve Trivial Conflicts.
 *
 * Composes with F107 conflict resolution coach. The coach is per-block
 * interactive; this command scans every conflict in the active file
 * and offers to one-shot-resolve every block classified as `trivial`
 * by F107's heuristic.
 *
 * Flow:
 *   1. Active editor's document body -> buildAutoResolvePlan.
 *   2. If 0 trivial blocks, info toast + bail.
 *   3. Else show a modal with the plan markdown -> Apply / Show plan only.
 *   4. Apply -> WorkspaceEdit replaces the whole document; status bar
 *      reports resolved + remaining counts.
 *
 * Wires from a new command (`gitsight.autoResolveTrivialConflicts`)
 * AND from F107's per-block picker (added "Auto-resolve all trivial"
 * action) so the user can opt into the bulk path mid-walkthrough.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { RepoManager } from '../git/repoManager';
import {
  buildAutoResolvePlan,
  applyAutoResolvePlan,
  describeAutoResolveOutcome,
  buildPlanMarkdown,
  countDifficulties,
  countRemaining,
} from '../git/conflictAutoResolve';

export async function runAutoResolveTrivialConflicts(repos: RepoManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('GitSight: open a conflicted file first.');
    return;
  }
  const doc = editor.document;
  const fsPath = doc.uri.fsPath;
  const git = repos.forFile(fsPath);
  if (!git) {
    vscode.window.showInformationMessage('GitSight: this file is not in a Git repository.');
    return;
  }
  const rel = path.relative(git.cwd, fsPath) || path.basename(fsPath);
  const body = doc.getText();
  const plan = buildAutoResolvePlan(body);

  if (plan.totalBlocks === 0) {
    vscode.window.showInformationMessage(`GitSight: no conflict markers on ${rel}.`);
    return;
  }
  if (plan.entries.length === 0) {
    const counts = countDifficulties(plan);
    const breakdown = [
      counts.small ? `${counts.small} small` : '',
      counts.moderate ? `${counts.moderate} moderate` : '',
      counts.large ? `${counts.large} large` : '',
    ].filter(Boolean).join(', ');
    vscode.window.showInformationMessage(
      `GitSight: no trivial conflicts to auto-resolve on ${rel}. ${plan.totalBlocks} block${plan.totalBlocks === 1 ? '' : 's'} need manual review (${breakdown || 'all non-trivial'}).`,
      'Run conflict coach',
    ).then(c => {
      if (c === 'Run conflict coach') vscode.commands.executeCommand('gitsight.conflictCoach');
    });
    return;
  }

  // Show modal w/ the plan preview.
  const headline = `GitSight: ${plan.entries.length} of ${plan.totalBlocks} conflict block${plan.totalBlocks === 1 ? '' : 's'} on ${rel} can be auto-resolved.`;
  const buttons = ['Apply', 'Preview plan', 'Cancel'];
  const decision = await vscode.window.showInformationMessage(headline, { modal: true }, ...buttons);
  if (!decision || decision === 'Cancel') return;

  if (decision === 'Preview plan') {
    const md = buildPlanMarkdown(rel, plan);
    const previewDoc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(previewDoc, vscode.ViewColumn.Beside, true);
    // Re-prompt after preview.
    const followUp = await vscode.window.showInformationMessage(
      `Apply auto-resolve plan to ${rel}?`,
      { modal: true },
      'Apply',
    );
    if (followUp !== 'Apply') return;
  }

  await applyPlanToActiveEditor(editor, plan, rel);
}

async function applyPlanToActiveEditor(
  editor: vscode.TextEditor,
  plan: ReturnType<typeof buildAutoResolvePlan>,
  rel: string,
): Promise<void> {
  const body = editor.document.getText();
  const result = applyAutoResolvePlan(body, plan);
  if (result.resolvedCount === 0) {
    vscode.window.showWarningMessage(`GitSight: nothing resolved -- the file may have changed since planning.`);
    return;
  }
  const wholeRange = new vscode.Range(
    editor.document.positionAt(0),
    editor.document.positionAt(body.length),
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, wholeRange, result.body);
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('GitSight: VS Code refused to apply the auto-resolve edit.');
    return;
  }
  const remaining = countRemaining(result.body);
  const msg = describeAutoResolveOutcome(rel, result, remaining);
  if (remaining === 0) {
    vscode.window.showInformationMessage(`${msg}. Save the file when you're ready.`);
  } else {
    vscode.window.setStatusBarMessage(msg, 5000);
  }

  // Surface skipped entries (rare but useful when the file moved under us).
  const skipped = result.outcomes.filter(o => o.status === 'skipped');
  if (skipped.length > 0) {
    const detail = skipped.map(o => `block ${o.entry.blockIndex + 1}: ${o.reason ?? 'skipped'}`).join('\n');
    vscode.window.showWarningMessage(`GitSight: ${skipped.length} block${skipped.length === 1 ? '' : 's'} skipped during auto-resolve.`, 'Show details').then(c => {
      if (c === 'Show details') {
        vscode.workspace.openTextDocument({ content: detail, language: 'markdown' })
          .then(d => vscode.window.showTextDocument(d, vscode.ViewColumn.Beside, true));
      }
    });
  }
}
