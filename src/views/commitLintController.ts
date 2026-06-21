/**
 * Commit-Message linter — surfaces problems in two complementary ways:
 *
 *  1. A `vscode.DiagnosticCollection` for documents in the `git-commit`
 *     language (i.e. `COMMIT_EDITMSG`). Users get red/yellow squigglies and
 *     full Problems-panel integration when they edit a commit message in an
 *     editor.
 *
 *  2. A status-bar pill that watches the built-in git SCM input box. It shows
 *     `$(check) commit ok` when clean, or `$(warning) 1 error, 2 warnings`
 *     when not. Clicking it pops a detail picker scoped to the active problems
 *     so users can jump to the offending line.
 *
 * Both surfaces share the same pure linter (src/git/commitLint.ts). Config
 * lives under `gitsight.commitLint.*`.
 */
import * as vscode from 'vscode';
import {
  lintCommitMessage,
  topSeverity,
  summariseProblems,
  LintProblem,
  LintOptions,
} from '../git/commitLint';

const DIAG_SOURCE = 'gitsight';

function readOptions(): LintOptions {
  const cfg = vscode.workspace.getConfiguration('gitsight.commitLint');
  return {
    maxSubjectLength: cfg.get<number>('maxSubjectLength', 72),
    maxBodyLength: cfg.get<number>('maxBodyLength', 100),
    requireBlankLineAfterSubject: cfg.get<boolean>('requireBlankLineAfterSubject', true),
    warnTrailingWhitespace: cfg.get<boolean>('warnTrailingWhitespace', true),
    warnLowercaseSubject: cfg.get<boolean>('warnLowercaseSubject', false),
    warnSubjectPeriod: cfg.get<boolean>('warnSubjectPeriod', true),
    warnWipPrefix: cfg.get<boolean>('warnWipPrefix', true),
    warnMissingBody: cfg.get<boolean>('warnMissingBody', true),
  };
}

function toDiagnostic(doc: vscode.TextDocument, p: LintProblem): vscode.Diagnostic {
  const lineNo = Math.min(Math.max(p.line, 0), Math.max(0, doc.lineCount - 1));
  const range = doc.lineAt(lineNo).range;
  const sev = p.severity === 'error'
    ? vscode.DiagnosticSeverity.Error
    : vscode.DiagnosticSeverity.Warning;
  const d = new vscode.Diagnostic(range, p.message, sev);
  d.source = DIAG_SOURCE;
  d.code = p.code;
  return d;
}

export class CommitLintController implements vscode.Disposable {
  private diag = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
  private pill: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private lastProblems: LintProblem[] = [];
  private lastValue = '';

  constructor() {
    this.pill = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 93);
    this.pill.command = 'gitsight.commitLintShowProblems';
    this.disposables.push(this.diag, this.pill);

    // Editor / document diagnostics
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => this.lintDocument(d)),
      vscode.workspace.onDidChangeTextDocument(e => this.lintDocument(e.document)),
      vscode.workspace.onDidCloseTextDocument(d => this.diag.delete(d.uri)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.commitLint')) {
          this.relintAll();
          this.refreshPill();
        }
      }),
    );
    for (const d of vscode.workspace.textDocuments) this.lintDocument(d);

    // SCM input watcher (polls the built-in git extension)
    this.disposables.push({ dispose: () => clearInterval(this.timer) });
    this.refreshPill();
  }

  private timer: NodeJS.Timeout = setInterval(() => this.refreshPill(), 1500);

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('gitsight.commitLintShowProblems', () => this.showProblemsPicker()),
    ];
  }

  private relintAll() {
    this.diag.clear();
    for (const d of vscode.workspace.textDocuments) this.lintDocument(d);
  }

  private lintDocument(doc: vscode.TextDocument) {
    if (doc.languageId !== 'git-commit') return;
    const cfg = vscode.workspace.getConfiguration('gitsight.commitLint');
    if (!cfg.get<boolean>('enabled', true)) { this.diag.delete(doc.uri); return; }
    // Skip the comment block at the bottom of COMMIT_EDITMSG (lines starting with `#`).
    const text = doc.getText().split('\n').filter(l => !l.startsWith('#')).join('\n');
    const problems = lintCommitMessage(text, readOptions());
    this.diag.set(doc.uri, problems.map(p => toDiagnostic(doc, p)));
  }

  private async refreshPill() {
    const cfg = vscode.workspace.getConfiguration('gitsight.commitLint');
    if (!cfg.get<boolean>('enabled', true) || !cfg.get<boolean>('showPill', true)) {
      this.pill.hide();
      return;
    }
    const value = readScmInput();
    if (value == null) {
      this.pill.hide();
      return;
    }
    if (value === this.lastValue) {
      // No change — keep last state but ensure visibility.
      if (this.lastValue) this.pill.show(); else this.pill.hide();
      return;
    }
    this.lastValue = value;
    if (!value.trim()) {
      this.lastProblems = [];
      this.pill.hide();
      return;
    }
    const problems = lintCommitMessage(value, readOptions());
    this.lastProblems = problems;
    const sev = topSeverity(problems);
    const summary = summariseProblems(problems);
    if (!sev) {
      this.pill.text = '$(check) commit ok';
      this.pill.tooltip = `GitSight commit linter: ${summary}`;
      this.pill.backgroundColor = undefined;
    } else {
      this.pill.text = `${sev === 'error' ? '$(error)' : '$(warning)'} ${summary}`;
      this.pill.tooltip = new vscode.MarkdownString(
        `**GitSight commit linter**  \n${summary}\n\nClick to inspect the issues.`,
      );
      this.pill.backgroundColor = new vscode.ThemeColor(
        sev === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground',
      );
    }
    this.pill.show();
  }

  private async showProblemsPicker() {
    if (!this.lastProblems.length) {
      vscode.window.showInformationMessage('GitSight: commit message looks good.');
      return;
    }
    const items = this.lastProblems.map(p => ({
      label: `${p.severity === 'error' ? '$(error)' : '$(warning)'} line ${p.line + 1}: ${p.message}`,
      description: p.code,
    }));
    await vscode.window.showQuickPick(items, {
      placeHolder: `${this.lastProblems.length} commit message ${this.lastProblems.length === 1 ? 'issue' : 'issues'}`,
    });
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
  }
}

/**
 * Best-effort read of the first repo's SCM input box via the built-in
 * `vscode.git` API. Returns `null` when git isn't loaded or no repo exists.
 */
function readScmInput(): string | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return null;
    if (!gitExt.isActive) return null; // don't force-activate; the user activated git already in any real workspace
    const api = gitExt.exports?.getAPI?.(1);
    const repo = api?.repositories?.[0];
    if (!repo) return null;
    return repo.inputBox?.value ?? '';
  } catch {
    return null;
  }
}
