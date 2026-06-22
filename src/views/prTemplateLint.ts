/**
 * F103 — PR template lint diagnostics.
 *
 * Two surfaces:
 *
 *   1. Passive diagnostics: a DiagnosticCollection that watches the
 *      special PR-description scratch buffer the F2/F77/F87 flows
 *      write to (look for `(gitsight) Pull Request Description` in the
 *      doc title — that's what `vscode.workspace.openTextDocument({
 *      language: 'markdown', content: ... })` produces). We also lint
 *      any markdown buffer that imports the PR_TEMPLATE.md heading
 *      shape (Summary/Test plan/Checklist), gated on a config knob.
 *
 *   2. `gitsight.lintPrTemplate` command: run a one-shot lint on the
 *      currently-active editor (or an explicit PR body URI), surface
 *      results as a sortable quick-pick that jumps to the line.
 *
 * The view layer also exposes `lintPrBodyAgainstTemplate` for the AI
 * flows to call before opening the description — they can then warn
 * the user inline ("4 warnings, open lint report?") instead of just
 * dumping a draft with placeholders into the buffer.
 */
import * as vscode from 'vscode';
import { RepoManager } from '../git/repoManager';
import {
  lintPrBody,
  PrLintFinding,
  PrLintSeverity,
  summariseLint,
  lintVerdict,
} from '../git/prTemplateLint';
import { templateCandidatePaths } from '../git/prTemplate';
import * as path from 'path';

const SOURCE = 'gitsight.prTemplate';

export class PrTemplateLintController implements vscode.Disposable {
  private diag = vscode.languages.createDiagnosticCollection(SOURCE);
  private disposables: vscode.Disposable[] = [];
  /** Per-repo cached template body. */
  private templateCache = new Map<string, string | undefined>();

  constructor(private repos: RepoManager) {
    this.disposables.push(this.diag);

    let timer: NodeJS.Timeout | undefined;
    const rescan = (doc: vscode.TextDocument) => {
      if (!this.isPrBody(doc)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.runLint(doc), 300);
    };
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(rescan),
      vscode.workspace.onDidChangeTextDocument(e => rescan(e.document)),
      vscode.workspace.onDidSaveTextDocument(rescan),
      vscode.workspace.onDidCloseTextDocument(d => {
        if (this.isPrBody(d)) this.diag.delete(d.uri);
      }),
    );

    for (const doc of vscode.workspace.textDocuments) {
      if (this.isPrBody(doc)) this.runLint(doc);
    }

    // Invalidate cache when a repo changes — the template may have changed too.
    this.disposables.push(this.repos.onDidChange(() => this.templateCache.clear()));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private isPrBody(doc: vscode.TextDocument): boolean {
    const cfg = vscode.workspace.getConfiguration('gitsight.prTemplateLint');
    if (!cfg.get<boolean>('enabled', true)) return false;
    if (doc.languageId !== 'markdown') return false;
    // Heuristic: untitled scratch buffer named like "Pull Request Description"
    // (case-insensitive, matches the AI flow's title) OR a file path that
    // ends in PULL_REQUEST_TEMPLATE.md (so the author can lint the template
    // itself before they save it).
    const name = (doc.uri.path || doc.fileName || '').toLowerCase();
    if (name.includes('pull request description')) return true;
    if (name.includes('pull_request_template')) return true;
    return false;
  }

  private async runLint(doc: vscode.TextDocument): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gitsight.prTemplateLint');
    const flagEmptyCheckboxes = cfg.get<boolean>('flagEmptyCheckboxes', false);
    const requiredSections = cfg.get<string[]>('requiredSections', []) ?? [];

    const templateBody = await this.findTemplateBody(doc);
    const findings = lintPrBody(doc.getText(), {
      templateBody,
      flagEmptyCheckboxes,
      requiredSections,
    });
    this.diag.set(doc.uri, findings.map(f => toDiagnostic(f, doc)));
  }

  private async findTemplateBody(doc: vscode.TextDocument): Promise<string | undefined> {
    // Try each known repo for a template — first-match wins.
    for (const git of this.repos.all()) {
      if (this.templateCache.has(git.cwd)) return this.templateCache.get(git.cwd);
      const body = await loadTemplateBody(git.cwd);
      this.templateCache.set(git.cwd, body);
      if (body) return body;
    }
    return undefined;
  }
}

async function loadTemplateBody(repoRoot: string): Promise<string | undefined> {
  for (const cand of templateCandidatePaths()) {
    if (cand.isDirectory) continue; // directory variant — too many options for the passive lint
    const abs = vscode.Uri.file(path.join(repoRoot, cand.path));
    try {
      const buf = await vscode.workspace.fs.readFile(abs);
      return new TextDecoder('utf8').decode(buf);
    } catch { /* not present */ }
  }
  return undefined;
}

function toDiagnostic(f: PrLintFinding, doc: vscode.TextDocument): vscode.Diagnostic {
  const line = Math.min(Math.max(0, f.line), Math.max(0, doc.lineCount - 1));
  const lineText = doc.lineAt(line).text;
  const startCol = Math.min(Math.max(0, f.column), lineText.length);
  const endCol = Math.min(startCol + Math.max(1, f.length), lineText.length || startCol + 1);
  const range = new vscode.Range(line, startCol, line, endCol);
  const sev = mapSeverity(f.severity);
  const text = f.hint ? `${f.message} ${f.hint}` : f.message;
  const diag = new vscode.Diagnostic(range, text, sev);
  diag.source = 'gitsight';
  diag.code = f.category;
  return diag;
}

function mapSeverity(s: PrLintSeverity): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'info': return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * One-shot lint over the active editor (or first markdown buffer with
 * "pull request" in the name). Opens a quick-pick of findings; each
 * pick jumps to the relevant line.
 */
export async function runPrTemplateLintCommand(repos: RepoManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    vscode.window.showWarningMessage('GitSight: open a markdown PR body to lint.');
    return;
  }
  const doc = editor.document;
  const git = repos.all().find(g =>
    doc.uri.fsPath.startsWith(g.cwd + path.sep) || doc.uri.fsPath === g.cwd,
  ) ?? repos.primary();
  const tmplBody = git ? await loadTemplateBody(git.cwd) : undefined;
  const cfg = vscode.workspace.getConfiguration('gitsight.prTemplateLint');
  const flagEmptyCheckboxes = cfg.get<boolean>('flagEmptyCheckboxes', false);
  const requiredSections = cfg.get<string[]>('requiredSections', []) ?? [];

  const findings = lintPrBody(doc.getText(), {
    templateBody: tmplBody,
    flagEmptyCheckboxes,
    requiredSections,
  });

  if (!findings.length) {
    vscode.window.showInformationMessage(`GitSight PR lint: ${summariseLint(findings)}`);
    return;
  }

  const items: (vscode.QuickPickItem & { line: number })[] = findings.map(f => ({
    label: `$(${glyphFor(f.severity)}) ${f.message}`,
    description: `line ${f.line + 1}`,
    detail: f.hint ?? '',
    line: f.line,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `GitSight PR lint  -  ${summariseLint(findings)}`,
    placeHolder: `Verdict: ${lintVerdict(findings).toUpperCase()}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  const target = new vscode.Position(picked.line, 0);
  editor.selection = new vscode.Selection(target, target);
  editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
}

function glyphFor(s: PrLintSeverity): string {
  switch (s) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'info': return 'info';
  }
}

/**
 * For the AI flows (F2/F77/F87) — call this BEFORE opening the
 * description. Returns a verdict + summary that the caller can show
 * as a toast: "4 warnings in the draft body — review now?".
 */
export async function lintGeneratedPrBody(
  repos: RepoManager,
  body: string,
): Promise<{ findings: PrLintFinding[]; summary: string }> {
  let templateBody: string | undefined;
  for (const git of repos.all()) {
    templateBody = await loadTemplateBody(git.cwd);
    if (templateBody) break;
  }
  const cfg = vscode.workspace.getConfiguration('gitsight.prTemplateLint');
  const findings = lintPrBody(body, {
    templateBody,
    flagEmptyCheckboxes: cfg.get<boolean>('flagEmptyCheckboxes', false),
    requiredSections: cfg.get<string[]>('requiredSections', []) ?? [],
  });
  return { findings, summary: summariseLint(findings) };
}
