/**
 * Conflict Marker Linter (F34) — surfaces lingering `<<<<<<<` / `=======` /
 * `>>>>>>>` markers in saved files as VS Code Diagnostics + provides keyboard
 * commands to jump to the next/previous conflict in the active editor.
 * gitsight-disable-conflict-marker (this controller's docstring contains
 * literal marker strings).
 *
 * Why it matters: the most embarrassing way to break CI is to commit a file
 * with an unresolved conflict marker. The editor's built-in merge editor
 * catches them while the conflict is in progress, but loses interest the
 * moment you save and move on. This catches them whenever they appear in any
 * open file, regardless of language.
 *
 *   - Diagnostics: one Error per block, ranged from `<<<<<<<` to `>>>>>>>`
 *     (or to end-of-file when malformed). Source = `gitsight`, code =
 *     `unresolved-conflict`.
 *   - Status-bar pill: shows `$(warning) N conflicts` when the active editor
 *     has unresolved markers; click jumps to the next one.
 *   - Commands:
 *       gitsight.conflictMarker.jumpNext   (Cmd+Shift+'.' in non-suggest mode)
 *       gitsight.conflictMarker.jumpPrev   (Cmd+Shift+',' in non-suggest mode)
 *
 * Configurable via `gitsight.conflictMarker.enabled` (default true) and
 * `gitsight.conflictMarker.showPill` (default true).
 *
 * Pure parsing lives in src/git/conflictMarkers.ts (unit-tested).
 */
import * as vscode from 'vscode';
import {
  findConflicts,
  isWellFormed,
  nextBlockLine,
  previousBlockLine,
  ConflictBlock,
} from '../git/conflictMarkers';

const DIAG_SOURCE = 'gitsight';
const DIAG_CODE = 'unresolved-conflict';

export class ConflictMarkerController implements vscode.Disposable {
  private diag = vscode.languages.createDiagnosticCollection('gitsight-conflict');
  private pill: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  /** Cached per-uri block list to make jump-next/prev O(1) after a save. */
  private blocksByUri = new Map<string, ConflictBlock[]>();

  constructor() {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    this.pill.command = 'gitsight.conflictMarker.jumpNext';
    this.disposables.push(
      this.diag,
      this.pill,
      vscode.workspace.onDidOpenTextDocument(d => this.scan(d)),
      vscode.workspace.onDidChangeTextDocument(e => this.scan(e.document)),
      vscode.workspace.onDidCloseTextDocument(d => {
        this.diag.delete(d.uri);
        this.blocksByUri.delete(d.uri.toString());
        this.refreshPill();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshPill()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.conflictMarker')) this.relintAll();
      }),
    );
    for (const d of vscode.workspace.textDocuments) this.scan(d);
    this.refreshPill();
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('gitsight.conflictMarker.jumpNext', () => this.jump('next')),
      vscode.commands.registerCommand('gitsight.conflictMarker.jumpPrev', () => this.jump('prev')),
      vscode.commands.registerCommand('gitsight.conflictMarker.rescan', () => {
        this.relintAll();
        vscode.window.setStatusBarMessage('GitSight: rescanned for conflict markers', 2000);
      }),
    ];
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitsight.conflictMarker').get<boolean>('enabled', true);
  }

  private showPillEnabled(): boolean {
    return vscode.workspace.getConfiguration('gitsight.conflictMarker').get<boolean>('showPill', true);
  }

  private scan(doc: vscode.TextDocument) {
    if (!this.isEnabled()) { this.diag.delete(doc.uri); this.blocksByUri.delete(doc.uri.toString()); this.refreshPill(); return; }
    // Skip schemes we don't care about (output/console/git internals/scm input).
    if (!['file', 'untitled', 'vscode-userdata'].includes(doc.uri.scheme)) return;
    // Skip huge files — anything over ~5MB is almost certainly binary or generated.
    if (doc.getText().length > 5 * 1024 * 1024) {
      this.diag.delete(doc.uri);
      this.blocksByUri.delete(doc.uri.toString());
      return;
    }
    const text = doc.getText();
    // Opt-out via magic comment for files that legitimately contain marker
    // strings (this very source, documentation, test fixtures). Match anywhere
    // in the first ~2KB to keep the cost trivial.
    if (text.slice(0, 2048).includes('gitsight-disable-conflict-marker')) {
      this.diag.delete(doc.uri);
      this.blocksByUri.delete(doc.uri.toString());
      this.refreshPill();
      return;
    }
    const blocks = findConflicts(text);
    this.blocksByUri.set(doc.uri.toString(), blocks);
    if (!blocks.length) { this.diag.delete(doc.uri); this.refreshPill(); return; }
    const lastLine = Math.max(0, doc.lineCount - 1);
    const diags = blocks.map(b => {
      const start = doc.lineAt(Math.min(b.startLine, lastLine)).range.start;
      const endLineIdx = isWellFormed(b) ? b.endLine : lastLine;
      const endRange = doc.lineAt(Math.min(endLineIdx, lastLine)).range;
      const range = new vscode.Range(start, endRange.end);
      const msg = isWellFormed(b)
        ? `Unresolved conflict markers (${b.oursRef || 'ours'} vs ${b.theirsRef || 'theirs'}).`
        : `Malformed conflict markers (missing >>>>>>>).`;
      const d = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
      d.source = DIAG_SOURCE;
      d.code = DIAG_CODE;
      return d;
    });
    this.diag.set(doc.uri, diags);
    this.refreshPill();
  }

  private relintAll() {
    this.diag.clear();
    this.blocksByUri.clear();
    for (const d of vscode.workspace.textDocuments) this.scan(d);
  }

  private refreshPill() {
    if (!this.isEnabled() || !this.showPillEnabled()) { this.pill.hide(); return; }
    const ed = vscode.window.activeTextEditor;
    if (!ed) { this.pill.hide(); return; }
    const blocks = this.blocksByUri.get(ed.document.uri.toString()) ?? [];
    if (!blocks.length) { this.pill.hide(); return; }
    this.pill.text = `$(warning) ${blocks.length} conflict${blocks.length === 1 ? '' : 's'}`;
    this.pill.tooltip = new vscode.MarkdownString(
      `**GitSight: unresolved conflict markers**  \n${blocks.length} block${blocks.length === 1 ? '' : 's'} in this file. Click to jump to the next one.`,
    );
    this.pill.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.pill.show();
  }

  private jump(direction: 'next' | 'prev') {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const blocks = this.blocksByUri.get(ed.document.uri.toString()) ?? [];
    if (!blocks.length) {
      vscode.window.showInformationMessage('GitSight: no conflict markers in this file.');
      return;
    }
    const caret = ed.selection.active.line;
    const target = direction === 'next' ? nextBlockLine(caret, blocks) : previousBlockLine(caret, blocks);
    if (target == null) return;
    const pos = new vscode.Position(target, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    vscode.window.setStatusBarMessage(
      `GitSight: conflict ${blocks.findIndex(b => b.startLine === target) + 1} of ${blocks.length}`,
      2000,
    );
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}
