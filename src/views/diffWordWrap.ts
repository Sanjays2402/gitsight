/**
 * Diff Word-Wrap Toggle — per-editor word-wrap that lives on the diff editor toolbar.
 *
 * Why: VS Code's `editor.wordWrap` is global. Toggling it from the diff view is
 * a multi-step settings dance. This adds a one-click toolbar button that flips
 * the *active editor*'s wrap state via `editor.action.toggleWordWrap`.
 *
 * The button is shown only in diff editors (when:isInDiffEditor).
 */
import * as vscode from 'vscode';

export function toggleDiffWordWrap() {
  // VS Code already exposes `editor.action.toggleWordWrap` which flips the
  // setting per-editor. We delegate and surface a confirmation pill so the user
  // knows it happened.
  return vscode.commands.executeCommand('editor.action.toggleWordWrap').then(() => {
    const cfg = vscode.workspace.getConfiguration('editor');
    const current = cfg.get<string>('wordWrap', 'off');
    vscode.window.setStatusBarMessage(`$(word-wrap)  Word wrap: ${current === 'on' ? 'on' : 'off'}`, 2000);
  });
}
