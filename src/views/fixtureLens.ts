/**
 * Fixture-Author CodeLens (F50) — at the top of test fixture / snapshot /
 * golden files, render a CodeLens reading e.g.
 *
 *   "Last 3 authors: alice (2d ago), bob (3w ago), carol (6mo ago)"
 *
 * Clicking opens the file's history view (delegates to the existing
 * gitsight.showFileHistory). Hover shows per-author commit counts.
 *
 * Why: when a snapshot looks wrong, the actionable question is "who last
 * touched this?" — and the secondary question is "who else might know
 * what the expected output should be?" The per-file commit count lens
 * (F20) answers neither — it just counts. This lens names names.
 *
 * Coexists with the F20 fileCommitLens by sitting on a separate range
 * (line 0 vs line 0 — both go to position 0,0 but VS Code stacks
 * CodeLenses at the same line happily). Files that aren't fixtures
 * receive zero CodeLenses from this provider.
 *
 * Config:
 *   gitsight.fixtureLens.enabled    (default true)
 *   gitsight.fixtureLens.maxCommits (default 50, hard cap 500)
 *   gitsight.fixtureLens.topAuthors (default 3, max 10)
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import {
  isFixtureFile,
  parseFixtureLog,
  buildLensLine,
} from '../git/fixtureLens';

interface CacheEntry {
  mtime: number;
  title: string;
  tooltip: string;
}

export class FixtureLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _e = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._e.event;
  private cache = new Map<string, CacheEntry>();
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {
    this.disposables.push(
      repos.onDidChange(() => { this.cache.clear(); this._e.fire(); }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        this.cache.delete(doc.uri.fsPath);
        this._e.fire();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.fixtureLens')) {
          this.cache.clear();
          this._e.fire();
        }
      }),
    );
  }

  register(): vscode.Disposable {
    const reg = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this);
    this.disposables.push(reg);
    return new vscode.Disposable(() => this.dispose());
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const cfg = vscode.workspace.getConfiguration('gitsight.fixtureLens');
    if (!cfg.get<boolean>('enabled', true)) return [];
    if (document.uri.scheme !== 'file') return [];
    if (document.lineCount === 0) return [];

    const file = document.uri.fsPath;
    const git = this.repos.forFile(file);
    if (!git) return [];

    const rel = path.relative(git.cwd, file).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return [];
    if (!isFixtureFile(rel)) return [];

    const max = Math.max(3, Math.min(500, cfg.get<number>('maxCommits', 50) ?? 50));
    const topN = Math.max(1, Math.min(10, cfg.get<number>('topAuthors', 3) ?? 3));

    const entry = await this.getEntry(git, file, rel, max, topN);
    if (!entry) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const lens = new vscode.CodeLens(range, {
      command: 'gitsight.showFileHistory',
      title: `$(person) ${entry.title}`,
      tooltip: entry.tooltip,
      arguments: [],
    });
    return [lens];
  }

  private async getEntry(git: Git, file: string, rel: string, max: number, topN: number): Promise<CacheEntry | undefined> {
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat) return;
    const cached = this.cache.get(file);
    if (cached && cached.mtime === stat.mtimeMs) return cached;

    try {
      const out = await git.raw([
        'log',
        `--max-count=${max}`,
        '--pretty=format:%H|%h|%aI|%an',
        '--follow',
        '--',
        rel,
      ]);
      const commits = parseFixtureLog(out);
      const line = buildLensLine(commits, new Date(), topN);
      if (!line) return undefined;
      const entry: CacheEntry = { mtime: stat.mtimeMs, title: line.title, tooltip: line.tooltip };
      this.cache.set(file, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.cache.clear();
  }
}
