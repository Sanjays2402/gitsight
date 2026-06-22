/**
 * F107 — Conflict resolution coach.
 *
 * For the active editor, walk every conflict marker block and surface
 * a per-conflict picker. Each row says:
 *
 *   Conflict 2/5  -  src/foo.ts  -  3/5 lines  -  trivial (take theirs)
 *
 * Picking a row opens a SIDE-BY-SIDE diff editor (ours <-> theirs)
 * via virtual `gitsight-conflict:` documents. When the merge style is
 * `diff3`, a second picker offers `Open base` (ours <-> base) and
 * `Show all three` (3-pane: ours, base, theirs) chained via the
 * built-in `vscode.diff` command.
 *
 * Bottom of each per-conflict picker:
 *   - Take ours
 *   - Take theirs
 *   - Take both (ours then theirs)
 *   - Take both (theirs then ours)
 *   - Edit manually (jump cursor to the marker)
 *
 * "Take" applies the resolution by editing the file in place via the
 * pure helper applyResolution() — block indices remain valid because
 * applyResolution re-extracts on each call.
 *
 * Composes with F34 (conflictMarkers) + F78 (stagedConflictGate)
 * which already have the marker-detection plumbing.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { RepoManager } from '../git/repoManager';
import {
  extractConflicts,
  applyResolution,
  classifyDifficulty,
  describeBlockForPicker,
  ConflictExtraction,
  ResolutionChoice,
} from '../git/conflictCoach';

const SCHEME = 'gitsight-conflict';

class ConflictContentProvider implements vscode.TextDocumentContentProvider {
  private cache = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  /** Cache content under a URI; later `provideTextDocumentContent` reads it back. */
  set(uri: vscode.Uri, content: string): void {
    this.cache.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cache.get(uri.toString()) ?? '';
  }

  clear(uri?: vscode.Uri): void {
    if (uri) { this.cache.delete(uri.toString()); return; }
    this.cache.clear();
  }
}

const PROVIDER = new ConflictContentProvider();

export function registerConflictCoach(repos: RepoManager): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  disposables.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, PROVIDER));
  return disposables;
}

/**
 * Entry: show the conflict-coach picker for the active editor.
 */
export async function runConflictCoach(_repos: RepoManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('GitSight: open the conflicted file first.');
    return;
  }
  const doc = editor.document;
  const extractions = extractConflicts(doc.getText());
  if (!extractions.length) {
    vscode.window.showInformationMessage('GitSight: no conflict markers in this file.');
    return;
  }

  const relPath = vscode.workspace.asRelativePath(doc.uri, false);
  type Pk = vscode.QuickPickItem & { _index: number };
  const items: Pk[] = extractions.map((ex, i) => ({
    label: `$(${glyphForDifficulty(classifyDifficulty(ex).level)}) ${describeBlockForPicker(ex, i, extractions.length, relPath)}`,
    description: `line ${ex.block.startLine + 1}-${(ex.block.endLine === -1 ? ex.block.startLine : ex.block.endLine) + 1}`,
    detail: previewOf(ex),
    _index: i,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `Conflicts in ${relPath} - ${extractions.length} total`,
    placeHolder: 'Pick a conflict to resolve.',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  await openConflictMenu(editor, picked._index);
}

async function openConflictMenu(editor: vscode.TextEditor, blockIndex: number): Promise<void> {
  const ex = extractConflicts(editor.document.getText())[blockIndex];
  if (!ex) {
    vscode.window.showWarningMessage('GitSight: conflict block index out of range (file changed?).');
    return;
  }

  type Action = 'preview-2pane' | 'preview-3pane' | 'take-ours' | 'take-theirs' | 'take-both-ot' | 'take-both-to' | 'jump';
  type Pk = vscode.QuickPickItem & { _a: Action };
  const items: Pk[] = [];
  items.push({ label: `$(diff) Preview side-by-side (ours <-> theirs)`, _a: 'preview-2pane' });
  if (ex.hasBase) {
    items.push({ label: `$(versions) Show 3-way preview (ours <-> base <-> theirs)`, _a: 'preview-3pane' });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
  items.push({ label: '$(arrow-right) Take ours', description: ex.block.oursRef || 'HEAD', _a: 'take-ours' });
  items.push({ label: '$(arrow-left) Take theirs', description: ex.block.theirsRef || 'incoming', _a: 'take-theirs' });
  items.push({ label: '$(fold-up) Take both (ours then theirs)', _a: 'take-both-ot' });
  items.push({ label: '$(fold-down) Take both (theirs then ours)', _a: 'take-both-to' });
  items.push({ label: '$(edit) Edit manually (jump cursor)', _a: 'jump' });

  const diff = classifyDifficulty(ex);
  const tip = diff.suggestion ? ` (suggested: take ${diff.suggestion.replace(/-/g, ' ')})` : '';
  const picked = await vscode.window.showQuickPick(items, {
    title: `Conflict ${blockIndex + 1} - ${diff.level}${tip}`,
    placeHolder: diff.reasons.join('; '),
  });
  if (!picked) return;

  if (picked._a === 'preview-2pane') return showTwoPane(editor.document, ex, blockIndex);
  if (picked._a === 'preview-3pane') return showThreePane(editor.document, ex, blockIndex);
  if (picked._a === 'jump') return jumpToMarker(editor, ex);
  // Resolution choices.
  const choice: ResolutionChoice =
    picked._a === 'take-ours' ? 'ours' :
    picked._a === 'take-theirs' ? 'theirs' :
    picked._a === 'take-both-ot' ? 'both-ours-theirs' :
    'both-theirs-ours';
  await applyAndWriteBack(editor, blockIndex, choice);
}

async function showTwoPane(doc: vscode.TextDocument, ex: ConflictExtraction, blockIndex: number): Promise<void> {
  const left = uriFor(doc, blockIndex, 'ours', ex.block.oursRef || 'HEAD');
  const right = uriFor(doc, blockIndex, 'theirs', ex.block.theirsRef || 'incoming');
  PROVIDER.set(left, ex.oursContent);
  PROVIDER.set(right, ex.theirsContent);
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `Conflict ${blockIndex + 1} - ours <-> theirs`,
    { preview: true },
  );
}

async function showThreePane(doc: vscode.TextDocument, ex: ConflictExtraction, blockIndex: number): Promise<void> {
  // VS Code's `vscode.diff` only handles 2 sides; the conventional
  // "3-way" UI is two adjacent diffs. Open base<->ours then
  // base<->theirs back-to-back.
  const baseUri = uriFor(doc, blockIndex, 'base', 'merge-base');
  const oursUri = uriFor(doc, blockIndex, 'ours', ex.block.oursRef || 'HEAD');
  const theirsUri = uriFor(doc, blockIndex, 'theirs', ex.block.theirsRef || 'incoming');
  PROVIDER.set(baseUri, ex.baseContent);
  PROVIDER.set(oursUri, ex.oursContent);
  PROVIDER.set(theirsUri, ex.theirsContent);
  await vscode.commands.executeCommand(
    'vscode.diff',
    baseUri,
    oursUri,
    `Conflict ${blockIndex + 1} - base <-> ours`,
    { preview: true, viewColumn: vscode.ViewColumn.One },
  );
  await vscode.commands.executeCommand(
    'vscode.diff',
    baseUri,
    theirsUri,
    `Conflict ${blockIndex + 1} - base <-> theirs`,
    { preview: false, viewColumn: vscode.ViewColumn.Beside },
  );
}

async function jumpToMarker(editor: vscode.TextEditor, ex: ConflictExtraction): Promise<void> {
  const pos = new vscode.Position(ex.block.startLine, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function applyAndWriteBack(editor: vscode.TextEditor, blockIndex: number, choice: ResolutionChoice): Promise<void> {
  const body = editor.document.getText();
  let newBody: string;
  try {
    newBody = applyResolution(body, blockIndex, choice);
  } catch (e: any) {
    vscode.window.showWarningMessage(`GitSight: ${e?.message ?? 'failed to apply resolution'}.`);
    return;
  }
  if (newBody === body) {
    vscode.window.showInformationMessage('GitSight: nothing changed (block may be malformed).');
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    editor.document.lineAt(editor.document.lineCount - 1).rangeIncludingLineBreak.end,
  );
  edit.replace(editor.document.uri, fullRange, newBody);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    vscode.window.showWarningMessage('GitSight: failed to apply edit (file might be read-only).');
    return;
  }
  const remaining = extractConflicts(newBody).length;
  vscode.window.setStatusBarMessage(
    `GitSight: conflict ${blockIndex + 1} resolved. ${remaining} remaining.`,
    3000,
  );
}

function uriFor(doc: vscode.TextDocument, blockIndex: number, side: 'ours' | 'base' | 'theirs', refLabel: string): vscode.Uri {
  const fileFrag = doc.uri.fsPath.split(path.sep).pop() ?? 'file';
  const safeRef = refLabel.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return vscode.Uri.parse(`${SCHEME}:/conflict-${blockIndex}-${side}/${safeRef}/${encodeURIComponent(fileFrag)}`);
}

function previewOf(ex: ConflictExtraction): string {
  const ours = ex.oursContent.split('\n')[0] || '(empty)';
  const theirs = ex.theirsContent.split('\n')[0] || '(empty)';
  const short = (s: string) => s.length > 50 ? s.slice(0, 47) + '\u2026' : s;
  return `ours: ${short(ours)}  /  theirs: ${short(theirs)}`;
}

function glyphForDifficulty(d: 'trivial' | 'small' | 'moderate' | 'large'): string {
  switch (d) {
    case 'trivial':   return 'pass-filled';
    case 'small':     return 'circle-small-filled';
    case 'moderate':  return 'warning';
    case 'large':     return 'flame';
  }
}
