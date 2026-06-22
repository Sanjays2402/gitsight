/**
 * F104 — Open issue from selection.
 *
 * Companion to F99 (which inserts a `#NN` reference at the cursor):
 * this slice goes the OTHER way. Pick a `// TODO`, `// FIXME`, or any
 * other comment / code selection, and we open a `gh issue create`
 * payload pre-filled with:
 *
 *   - title from the first non-empty body line (after stripping the
 *     comment delimiter + marker prefix)
 *   - body containing the placeholder text + a host-aware permalink
 *     block + a fenced code quote of the selection
 *   - default labels mapped from the marker kind (FIXME -> bug,
 *     HACK -> tech-debt, OPTIMIZE -> performance)
 *
 * Surfaces:
 *
 *   - Command palette: `gitsight.openIssueFromSelection`
 *   - Code-action (Refactor): "GitSight: Open issue from selection"
 *     offered when the editor has a non-empty selection AND the file
 *     is inside a git repo
 *
 * Preview-then-post pattern: never auto-submits to gh. A preview
 * markdown buffer opens with title + body + label list; the user picks
 * Post / Copy command / Cancel.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import { remoteWebUrl } from '../git/hostDetect';
import {
  composeIssueDraft,
  classifySelection,
  buildGhIssueArgs,
  IssueDraft,
} from '../git/issueFromSelection';

const pexec = promisify(execFile);

/** Entry — invoked by the command + code-action. */
export async function runOpenIssueFromSelection(repos: RepoManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('GitSight: open an editor first.');
    return;
  }
  const sel = editor.selection;
  if (sel.isEmpty) {
    vscode.window.showInformationMessage('GitSight: select the TODO/FIXME (or code) you want to file.');
    return;
  }
  const git = repos.all().find(g =>
    editor.document.uri.fsPath.startsWith(g.cwd + path.sep) || editor.document.uri.fsPath === g.cwd,
  );
  if (!git) {
    vscode.window.showWarningMessage('GitSight: active editor is not inside a tracked git repo.');
    return;
  }

  const selectionText = editor.document.getText(sel);
  const verdict = classifySelection(selectionText);
  if (verdict === 'empty') {
    vscode.window.showInformationMessage('GitSight: selection is empty.');
    return;
  }
  if (verdict === 'too-large') {
    const pick = await vscode.window.showWarningMessage(
      `GitSight: selection is large (over 400 lines). Open issue anyway?`,
      { modal: true },
      'Open anyway',
    );
    if (pick !== 'Open anyway') return;
  }

  const relPath = posixRel(git.cwd, editor.document.uri.fsPath);
  const startLine = sel.start.line + 1;
  const endLine = sel.end.line + 1;

  const [originUrl, commitSha, branch] = await Promise.all([
    safe(git, ['remote', 'get-url', 'origin']),
    safe(git, ['rev-parse', 'HEAD']),
    safe(git, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const remoteBase = originUrl.trim() ? remoteWebUrl(originUrl.trim()) : undefined;

  const draft = composeIssueDraft({
    selection: selectionText,
    relPath,
    startLine,
    endLine,
    remoteUrl: remoteBase,
    commitSha: commitSha.trim() || undefined,
    branch: branch.trim() || undefined,
    languageId: editor.document.languageId,
  });

  await previewAndAct(git, draft);
}

async function previewAndAct(git: Git, draft: IssueDraft): Promise<void> {
  const previewBody = renderPreview(draft);
  const doc = await vscode.workspace.openTextDocument({ content: previewBody, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });

  const ghOk = await ghAvailable();
  const actions: string[] = [];
  if (ghOk) actions.push('Open issue with gh');
  actions.push('Copy gh command', 'Copy body only');

  const pick = await vscode.window.showQuickPick(actions, {
    placeHolder: ghOk
      ? `Verdict: ${draft.verdict.toUpperCase()}  -  marker: ${draft.marker ?? 'none'}`
      : 'gh not on PATH - install: brew install gh',
  });
  if (!pick) return;

  if (pick === 'Open issue with gh') {
    await runGhCreate(git, draft);
  } else if (pick === 'Copy gh command') {
    const cmd = shellQuoteCommand(['gh', ...buildGhIssueArgs(draft)]);
    await vscode.env.clipboard.writeText(cmd + ' <<\'EOF\'\n' + draft.body + '\nEOF\n');
    vscode.window.showInformationMessage('GitSight: gh command copied to clipboard.');
  } else if (pick === 'Copy body only') {
    await vscode.env.clipboard.writeText(`# ${draft.title}\n\n${draft.body}`);
    vscode.window.showInformationMessage('GitSight: issue body copied to clipboard.');
  }
}

function renderPreview(draft: IssueDraft): string {
  const parts: string[] = [];
  parts.push('<!--');
  parts.push('  GitSight: Issue draft preview. Use the picker to post via gh,');
  parts.push('  copy the gh command, or copy just the body.');
  parts.push(`  Verdict: ${draft.verdict}.  Marker: ${draft.marker ?? 'none'}.`);
  if (draft.suggestedLabels.length) parts.push(`  Labels: ${draft.suggestedLabels.join(', ')}`);
  parts.push('-->');
  parts.push('');
  parts.push(`# ${draft.title || '(no title)'}`);
  parts.push('');
  parts.push(draft.body);
  return parts.join('\n');
}

async function runGhCreate(git: Git, draft: IssueDraft): Promise<void> {
  const args = buildGhIssueArgs(draft);
  const result = await new Promise<{ url: string; err?: string }>((resolve) => {
    const child = execFile('gh', args, { cwd: git.cwd }, (err, stdout, stderr) => {
      if (err) {
        resolve({ url: '', err: String(stderr || err.message) });
        return;
      }
      const line = (stdout || '').split('\n').map(s => s.trim()).filter(Boolean).pop() ?? '';
      resolve({ url: line });
    });
    try {
      child.stdin?.write(draft.body);
      child.stdin?.end();
    } catch {
      // child may have already failed; the callback handles the error path
    }
  });

  if (result.err) {
    vscode.window.showErrorMessage(`GitSight: gh issue create failed - ${result.err.split('\n')[0]}`);
    return;
  }
  if (!result.url) {
    vscode.window.showInformationMessage('GitSight: issue created.');
    return;
  }
  const open = await vscode.window.showInformationMessage(
    `GitSight: issue created.`,
    'Open in browser',
    'Copy URL',
  );
  if (open === 'Open in browser') vscode.env.openExternal(vscode.Uri.parse(result.url));
  if (open === 'Copy URL') await vscode.env.clipboard.writeText(result.url);
}

function shellQuoteCommand(parts: string[]): string {
  return parts.map(p => {
    if (/^[a-zA-Z0-9_./:-]+$/.test(p)) return p;
    return `'${p.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

function posixRel(base: string, target: string): string {
  return path.relative(base, target).split(path.sep).join('/');
}

async function safe(git: Git, args: string[]): Promise<string> {
  try {
    return (await git.raw(args)) ?? '';
  } catch {
    return '';
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version']); return true; } catch { return false; }
}

/** CodeAction provider — surfaces the command on any non-empty selection
 * inside a git repo. */
export class OpenIssueCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.Refactor],
  };

  constructor(private repos: RepoManager) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    if (document.uri.scheme !== 'file') return;
    if (range.isEmpty) return;
    const inRepo = this.repos.all().some(g =>
      document.uri.fsPath.startsWith(g.cwd + path.sep) || document.uri.fsPath === g.cwd,
    );
    if (!inRepo) return;

    const action = new vscode.CodeAction('GitSight: Open issue from selection', vscode.CodeActionKind.Refactor);
    action.command = {
      command: 'gitsight.openIssueFromSelection',
      title: 'GitSight: Open issue from selection',
    };
    return [action];
  }
}
