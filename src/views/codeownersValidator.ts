/**
 * F102 — CODEOWNERS validator.
 *
 * Two surfaces:
 *
 *   1. Passive diagnostics: a DiagnosticCollection watches CODEOWNERS
 *      files in any of the canonical locations
 *      (CODEOWNERS, .github/CODEOWNERS, docs/CODEOWNERS) and emits
 *      Problems-panel entries as the user types or saves.
 *
 *   2. `gitsight.validateCodeowners` command: one-shot lint that
 *      opens a markdown report listing findings with their column +
 *      line, suitable for batch review of a fresh CODEOWNERS file.
 *
 * The dead-pattern check fires only when a tracked-files list is
 * available (we shell out to `git ls-files` for that). The lint
 * gracefully degrades to syntactic-only when not in a git repo or
 * when `git ls-files` fails - the syntactic checks (invalid owners,
 * empty owners, negation patterns, duplicates) still produce value.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RepoManager } from '../git/repoManager';
import { Git } from '../git/git';
import {
  lintCodeowners,
  summariseFindings,
  LintFinding,
  LintSeverity,
} from '../git/codeownersLint';

const pexec = promisify(execFile);

const CODEOWNERS_FILENAMES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

export class CodeownersValidatorController implements vscode.Disposable {
  private diag = vscode.languages.createDiagnosticCollection('gitsight.codeowners');
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {
    this.disposables.push(this.diag);

    // Lint on document open / save / change (debounced).
    let timer: NodeJS.Timeout | undefined;
    const rescan = (doc: vscode.TextDocument) => {
      if (!this.isCodeownersDoc(doc)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.runLint(doc), 250);
    };
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => rescan(d)),
      vscode.workspace.onDidSaveTextDocument(d => rescan(d)),
      vscode.workspace.onDidChangeTextDocument(e => rescan(e.document)),
      vscode.workspace.onDidCloseTextDocument(d => {
        if (this.isCodeownersDoc(d)) this.diag.delete(d.uri);
      }),
    );

    // Lint anything already open at activation.
    for (const doc of vscode.workspace.textDocuments) {
      if (this.isCodeownersDoc(doc)) this.runLint(doc);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private isCodeownersDoc(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file') return false;
    const base = path.basename(doc.fileName);
    if (base !== 'CODEOWNERS') return false;
    // Make sure it's in one of the recognised locations relative to a repo.
    const cfg = vscode.workspace.getConfiguration('gitsight.codeownersValidator');
    return cfg.get<boolean>('enabled', true);
  }

  private async runLint(doc: vscode.TextDocument): Promise<void> {
    const body = doc.getText();
    const git = this.findRepoFor(doc.uri);
    let files: string[] = [];
    if (git) {
      try {
        const out = await git.raw(['ls-files']);
        files = out.split('\n').map(s => s.trim()).filter(Boolean);
      } catch {
        // Non-fatal - skip dead-pattern detection.
      }
    }
    const findings = lintCodeowners(body, files);
    const diagnostics = findings.map(f => toDiagnostic(f, doc));
    this.diag.set(doc.uri, diagnostics);
  }

  private findRepoFor(uri: vscode.Uri): Git | undefined {
    const repoList = this.repos.all();
    let best: { git: Git; depth: number } | undefined;
    for (const git of repoList) {
      if (uri.fsPath.startsWith(git.cwd + path.sep) || uri.fsPath === git.cwd) {
        const depth = uri.fsPath.length - git.cwd.length;
        if (!best || depth < best.depth) best = { git, depth };
      }
    }
    return best?.git;
  }
}

function toDiagnostic(f: LintFinding, doc: vscode.TextDocument): vscode.Diagnostic {
  const start = new vscode.Position(f.line, f.column);
  const end = new vscode.Position(f.line, f.column + Math.max(1, f.length));
  const range = new vscode.Range(start, end);
  const sev = mapSeverity(f.severity);
  const diag = new vscode.Diagnostic(range, f.hint ? `${f.message}\n${f.hint}` : f.message, sev);
  diag.source = 'gitsight';
  diag.code = f.category;
  return diag;
}

function mapSeverity(s: LintSeverity): vscode.DiagnosticSeverity {
  if (s === 'error')   return vscode.DiagnosticSeverity.Error;
  if (s === 'warning') return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

/**
 * `gitsight.validateCodeowners` — one-shot lint of every CODEOWNERS
 * file in the workspace. Writes a markdown report to a scratch buffer.
 */
export async function runValidateCodeowners(repos: RepoManager): Promise<void> {
  const repoList = repos.all();
  if (!repoList.length) {
    vscode.window.showWarningMessage('GitSight: no Git repos to validate.');
    return;
  }

  const reports = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GitSight: validating CODEOWNERS\u2026' },
    () => Promise.all(repoList.map(git => lintOneRepo(git))),
  );

  const total = reports.reduce(
    (acc, r) => ({
      errors: acc.errors + r.summary.errors,
      warnings: acc.warnings + r.summary.warnings,
      info: acc.info + r.summary.info,
      files: acc.files + (r.foundFile ? 1 : 0),
    }),
    { errors: 0, warnings: 0, info: 0, files: 0 },
  );

  if (total.files === 0) {
    vscode.window.showInformationMessage('GitSight: no CODEOWNERS files found in the workspace.');
    return;
  }

  const md = renderReport(reports, total);
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

interface RepoReport {
  cwd: string;
  foundFile: boolean;
  filePath?: string;
  findings: LintFinding[];
  summary: { errors: number; warnings: number; info: number };
}

async function lintOneRepo(git: Git): Promise<RepoReport> {
  for (const rel of CODEOWNERS_FILENAMES) {
    const abs = path.join(git.cwd, rel);
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
      const body = Buffer.from(buf).toString('utf8');
      let files: string[] = [];
      try {
        const out = await git.raw(['ls-files']);
        files = out.split('\n').map(s => s.trim()).filter(Boolean);
      } catch { /* non-fatal */ }
      const findings = lintCodeowners(body, files);
      return {
        cwd: git.cwd,
        foundFile: true,
        filePath: rel,
        findings,
        summary: summariseFindings(findings),
      };
    } catch {
      // No file at this location; try the next.
    }
  }
  return {
    cwd: git.cwd,
    foundFile: false,
    findings: [],
    summary: { errors: 0, warnings: 0, info: 0 },
  };
}

function renderReport(
  reports: RepoReport[],
  total: { errors: number; warnings: number; info: number; files: number },
): string {
  const lines: string[] = [];
  lines.push('# CODEOWNERS validation report');
  lines.push('');
  lines.push(`Workspace: ${total.files} CODEOWNERS file${total.files === 1 ? '' : 's'} \u00b7 ${total.errors} error${total.errors === 1 ? '' : 's'} \u00b7 ${total.warnings} warning${total.warnings === 1 ? '' : 's'} \u00b7 ${total.info} info`);
  lines.push('');
  for (const r of reports) {
    if (!r.foundFile) continue;
    lines.push(`## ${path.basename(r.cwd)} - ${r.filePath}`);
    lines.push(`Path: \`${r.cwd}/${r.filePath}\``);
    lines.push(`Findings: ${r.summary.errors} error / ${r.summary.warnings} warning / ${r.summary.info} info`);
    lines.push('');
    if (!r.findings.length) {
      lines.push('No issues found.');
      lines.push('');
      continue;
    }
    lines.push('| Line | Sev | Category | Message |');
    lines.push('|------|-----|----------|---------|');
    for (const f of r.findings) {
      const sev = f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warn' : 'info';
      const msg = (f.message + (f.hint ? ' \u00b7 ' + f.hint : '')).replace(/\|/g, '\\|');
      lines.push(`| ${f.line + 1} | ${sev} | ${f.category} | ${msg} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
