/**
 * Gitignore Insight CodeLens — at the top of a `.gitignore`, render a CodeLens
 * showing how many files in the workspace are currently ignored by that file
 * (and the total ignored-file count for the repo). Clicking the lens opens a
 * QuickPick of the ignored paths, capped to a configurable maximum so very
 * large `node_modules` lists don't OOM the picker.
 *
 * The work is done by `git check-ignore -v --stdin` so we get back the rule
 * that matched each file. The pure helpers in src/git/gitignoreInsight.ts
 * (count attribution by source file) can be tested without git.
 *
 * Config:
 *   gitsight.gitignoreInsight.enabled        (default true)
 *   gitsight.gitignoreInsight.maxFiles       (default 5000, hard cap on the scan)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { attributeIgnoredFiles, AttributedFile } from '../git/gitignoreInsight';

interface CacheEntry { ts: number; results: AttributedFile[]; }

export class GitignoreInsightLens implements vscode.CodeLensProvider, vscode.Disposable {
  private _e = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._e.event;
  private cache = new Map<string, CacheEntry>();
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {
    this.disposables.push(
      repos.onDidChange(() => { this.cache.clear(); this._e.fire(); }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (path.basename(doc.uri.fsPath) === '.gitignore') { this.cache.clear(); this._e.fire(); }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.gitignoreInsight')) { this.cache.clear(); this._e.fire(); }
      }),
    );
  }

  register(): vscode.Disposable {
    const sel: vscode.DocumentSelector = [
      { scheme: 'file', pattern: '**/.gitignore' },
    ];
    const reg = vscode.languages.registerCodeLensProvider(sel, this);
    this.disposables.push(reg);
    return new vscode.Disposable(() => this.dispose());
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const cfg = vscode.workspace.getConfiguration('gitsight.gitignoreInsight');
    if (!cfg.get<boolean>('enabled', true)) return [];
    if (path.basename(document.uri.fsPath) !== '.gitignore') return [];
    const git = this.repos.forFile(document.uri.fsPath);
    if (!git) return [];

    const results = await this.scan(git, cfg.get<number>('maxFiles', 5000) ?? 5000);
    const here = document.uri.fsPath;
    const matched = results.filter(r => sameFile(r.sourceFile, here)).length;
    const total = results.length;

    const range = new vscode.Range(0, 0, 0, 0);
    const summary = new vscode.CodeLens(range, {
      command: 'gitsight.showIgnoredFiles',
      title: `$(eye-closed) ${matched} ignored by this .gitignore · ${total} total ignored in repo`,
      arguments: [{ gitCwd: git.cwd, sourceFile: here, results }],
    });
    return [summary];
  }

  private async scan(git: Git, max: number): Promise<AttributedFile[]> {
    const cacheKey = git.cwd + '|' + max;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60_000) return cached.results;

    // List every tracked + untracked workspace path, then ask check-ignore why
    // each one would be ignored if it were untracked. We feed paths via stdin
    // because the workspace can have tens of thousands of files.
    const lsArgs = ['ls-files', '--cached', '--others', '--exclude-standard=false'];
    let lsOut: string;
    try {
      lsOut = await git.raw(['ls-files', '--cached', '--others']);
    } catch {
      return [];
    }
    const tracked = lsOut.split('\n').filter(Boolean);

    let ignoredOut: string;
    try {
      ignoredOut = await git.raw(['ls-files', '--others', '--ignored', '--exclude-standard']);
    } catch {
      return [];
    }
    const ignored = ignoredOut.split('\n').filter(Boolean).slice(0, max);
    if (!ignored.length) {
      this.cache.set(cacheKey, { ts: Date.now(), results: [] });
      return [];
    }

    // Run check-ignore in one shot via stdin to attribute each ignored path
    // back to the .gitignore that ruled on it.
    const verbose = await runCheckIgnore(git.cwd, ignored).catch(() => '');
    const attributed = attributeIgnoredFiles(verbose, git.cwd);

    void lsArgs;
    void tracked;
    this.cache.set(cacheKey, { ts: Date.now(), results: attributed });
    return attributed;
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.cache.clear();
  }
}

function sameFile(a: string, b: string): boolean {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

function runCheckIgnore(cwd: string, paths: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['check-ignore', '--verbose', '--no-index', '--stdin'], {
      cwd, maxBuffer: 100 * 1024 * 1024,
    }, (err, stdout) => {
      // check-ignore exits 1 when nothing matched; treat that as empty, not error.
      if (err && (err as any).code !== 1) return reject(err);
      resolve(stdout);
    });
    child.stdin?.end(paths.join('\n') + '\n');
  });
}

export async function showIgnoredFilesPicker(arg: any): Promise<void> {
  const results: AttributedFile[] = arg?.results ?? [];
  const sourceFile: string = arg?.sourceFile;
  const gitCwd: string = arg?.gitCwd;
  const scoped = results.filter(r => sameFile(r.sourceFile, sourceFile));
  if (!scoped.length) {
    vscode.window.showInformationMessage('GitSight: no files are currently ignored by this .gitignore.');
    return;
  }
  const items = scoped.map(r => ({
    label: r.relPath,
    description: r.pattern ? `pattern: ${r.pattern}` : '',
    detail: `line ${r.lineNumber ?? '?'} · ${path.basename(r.sourceFile)}`,
    _abs: path.join(gitCwd, r.relPath),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${items.length} files ignored by this .gitignore — pick to reveal`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  try {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(picked._abs));
  } catch {
    // Fall back to opening if reveal isn't available
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(picked._abs));
  }
}
