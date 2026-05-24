import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';

interface Rule { pattern: string; owners: string[]; regex: RegExp; }

/**
 * CODEOWNERS overlay:
 *  - status bar shows owners for the active file
 *  - on stage, warns if any staged file has owners the current user is not part of
 */
export class CodeownersOverlay implements vscode.Disposable {
  private rules: Rule[] = [];
  private status: vscode.StatusBarItem;
  private currentUser = '';
  private repoRoot = '';
  private fileWatcher?: vscode.FileSystemWatcher;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly getGit: () => Git | undefined) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.status.command = 'gitsight.codeownersExplain';
    this.disposables.push(
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatus()),
    );
    this.bootstrap();
  }

  dispose() { this.disposables.forEach(d => d.dispose()); this.fileWatcher?.dispose(); }

  private async bootstrap() {
    const git = this.getGit(); if (!git) return;
    this.repoRoot = git.cwd;
    this.currentUser = (await git.raw(['config', 'user.email']).catch(() => '')).trim();
    await this.loadRules();
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.repoRoot, '{CODEOWNERS,.github/CODEOWNERS,docs/CODEOWNERS}'),
    );
    this.fileWatcher.onDidChange(() => this.loadRules());
    this.fileWatcher.onDidCreate(() => this.loadRules());
    this.fileWatcher.onDidDelete(() => { this.rules = []; this.refreshStatus(); });
    this.refreshStatus();
  }

  private async loadRules() {
    const candidates = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
    for (const c of candidates) {
      const p = path.join(this.repoRoot, c);
      try {
        const text = await fs.readFile(p, 'utf8');
        this.rules = parseCodeowners(text);
        this.refreshStatus();
        return;
      } catch { /* try next */ }
    }
    this.rules = [];
    this.refreshStatus();
  }

  private resolveOwners(relPath: string): string[] {
    // Later rules override earlier ones (GitHub semantics)
    let owners: string[] = [];
    for (const r of this.rules) {
      if (r.regex.test('/' + relPath)) owners = r.owners;
    }
    return owners;
  }

  private refreshStatus() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !this.rules.length) { this.status.hide(); return; }
    const rel = path.relative(this.repoRoot, ed.document.uri.fsPath);
    if (rel.startsWith('..')) { this.status.hide(); return; }
    const owners = this.resolveOwners(rel);
    if (!owners.length) {
      this.status.text = '$(person) no owners';
      this.status.tooltip = `CODEOWNERS: no rule matches ${rel}`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.status.text = `$(person) ${owners.length === 1 ? owners[0] : owners[0] + ' +' + (owners.length - 1)}`;
      this.status.tooltip = `Owners of ${rel}:\n${owners.join('\n')}\n\nClick to see full rule.`;
      this.status.backgroundColor = undefined;
    }
    this.status.show();
  }

  async explain() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const rel = path.relative(this.repoRoot, ed.document.uri.fsPath);
    const owners = this.resolveOwners(rel);
    const md = [
      `# CODEOWNERS — \`${rel}\``,
      '',
      owners.length
        ? `Owners: ${owners.map(o => `\`${o}\``).join(', ')}`
        : '_No CODEOWNERS rule matches this file._',
      '',
      '## All rules',
      '',
      ...this.rules.map(r => `- \`${r.pattern}\` → ${r.owners.join(', ')}`),
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async checkStagedOwnership() {
    const git = this.getGit(); if (!git) return;
    if (!this.rules.length) return vscode.window.showInformationMessage('No CODEOWNERS file in this repo.');
    const staged = (await git.raw(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
    if (!staged.length) return vscode.window.showInformationMessage('Nothing staged.');
    const notOwned: { file: string; owners: string[] }[] = [];
    for (const f of staged) {
      const owners = this.resolveOwners(f);
      const mine = owners.some(o => this.currentUser && (o.includes(this.currentUser) || o === '@' + this.currentUser.split('@')[0]));
      if (owners.length && !mine) notOwned.push({ file: f, owners });
    }
    if (!notOwned.length) {
      vscode.window.showInformationMessage(`CODEOWNERS: you own all ${staged.length} staged files. ✅`);
      return;
    }
    const lines = notOwned.map(n => `- ${n.file} → ${n.owners.join(', ')}`).join('\n');
    vscode.window.showWarningMessage(
      `CODEOWNERS: ${notOwned.length}/${staged.length} staged file(s) need reviews from others.`,
      'Show details',
    ).then(c => {
      if (c === 'Show details') {
        vscode.workspace.openTextDocument({ content: `# CODEOWNERS coverage\n\n${lines}`, language: 'markdown' })
          .then(d => vscode.window.showTextDocument(d, vscode.ViewColumn.Beside));
      }
    });
  }
}

export function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1);
    rules.push({ pattern, owners, regex: globToRegex(pattern) });
  }
  return rules;
}

function globToRegex(glob: string): RegExp {
  // simplified gitignore-style; sufficient for CODEOWNERS
  let g = glob;
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i += 2; if (g[i] === '/') i++; }
    else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if ('.+^$()[]{}|\\'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  const prefix = anchored ? '^/' : '(^|/)';
  const suffix = dirOnly ? '(/|$)' : '($|/)';
  return new RegExp(prefix + re + suffix);
}
