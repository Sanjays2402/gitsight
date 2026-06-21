/**
 * Per-file commit count CodeLens — at the very top of any tracked file, render
 * a CodeLens reading e.g. "42 commits · 18mo of history · 3 contributors".
 * Clicking opens the GitSight File History view focused on that file.
 *
 * The data comes from `git log --pretty=format:%aI%x09%an --max-count=N`
 * and is summarised by the pure helper `summariseFileStats` in
 * src/git/fileStats.ts (testable without git).
 *
 * Config:
 *   gitsight.fileCommitLens.enabled         (default true)
 *   gitsight.fileCommitLens.maxCommits      (default 500, hard cap)
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { summariseFileStats, formatStats, FileStats } from '../git/fileStats';

interface CacheEntry { mtime: number; stats: FileStats; }

export class FileCommitLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
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
        if (e.affectsConfiguration('gitsight.fileCommitLens')) {
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
    const cfg = vscode.workspace.getConfiguration('gitsight.fileCommitLens');
    if (!cfg.get<boolean>('enabled', true)) return [];
    if (document.uri.scheme !== 'file') return [];
    if (document.lineCount === 0) return [];

    const file = document.uri.fsPath;
    const git = this.repos.forFile(file);
    if (!git) return [];

    // Skip .gitignore so we don't clash with the gitignore CodeLens.
    if (path.basename(file) === '.gitignore') return [];

    const max = Math.max(10, Math.min(5000, cfg.get<number>('maxCommits', 500) ?? 500));
    const stats = await this.getStats(git, file, max);
    if (!stats || stats.totalCommits === 0) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const lens = new vscode.CodeLens(range, {
      command: 'gitsight.showFileHistory',
      title: `$(history) ${formatStats(stats)}`,
      arguments: [],
    });
    return [lens];
  }

  private async getStats(git: Git, file: string, max: number): Promise<FileStats | undefined> {
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat) return;
    const cached = this.cache.get(file);
    if (cached && cached.mtime === stat.mtimeMs) return cached.stats;

    const rel = path.relative(git.cwd, file);
    if (!rel || rel.startsWith('..')) return;

    try {
      const out = await git.raw([
        'log',
        `--max-count=${max}`,
        '--pretty=format:%aI\t%an',
        '--follow',
        '--',
        rel,
      ]);
      const stats = summariseFileStats(out);
      this.cache.set(file, { mtime: stat.mtimeMs, stats });
      return stats;
    } catch {
      return;
    }
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.cache.clear();
  }
}
