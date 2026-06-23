/**
 * F111 - Per-File Complexity Badge.
 *
 * FileDecorationProvider that puts a one-letter badge on every tracked
 * file in the explorer:
 *
 *   (none) - low complexity
 *   M      - medium
 *   H      - high  (yellow-ish tint)
 *   X      - extreme (red tint)
 *
 * Tooltip shows the per-axis breakdown: decisions, max nesting,
 * logical lines, function count.
 *
 * Architecture mirrors F81 RecentContributorsProvider:
 *   - Per-file mtime cache (don't re-score a file that hasn't changed).
 *   - Lazy on-demand via VS Code's provideFileDecoration -- we NEVER
 *     scan the whole repo on activation.
 *   - File-save invalidation.
 *   - Configuration-aware: gitsight.complexityBadge.enabled etc.
 *
 * Also registers a command (`gitsight.complexityBadge.show`) that opens
 * a markdown report for the active file's complexity score.
 *
 * Configurable via:
 *   gitsight.complexityBadge.enabled        (default true)
 *   gitsight.complexityBadge.maxFileBytes   (default 200_000)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RepoManager } from '../git/repoManager';
import {
  computeComplexity,
  badgeFor,
  buildComplexityTooltip,
  describeComplexity,
  classifyBucket,
  isAnalysableFile,
  ComplexityScore,
} from '../git/complexityBadge';

const SHOW_COMMAND = 'gitsight.complexityBadge.show';

interface CacheEntry {
  mtime: number;
  size: number;
  score: ComplexityScore;
}

export class ComplexityBadgeProvider
  implements vscode.FileDecorationProvider, vscode.Disposable {
  private _e = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._e.event;

  private cache = new Map<string, CacheEntry>();
  private inFlight = new Set<string>();
  private disposables: vscode.Disposable[] = [];

  constructor(private repos: RepoManager) {}

  register(): vscode.Disposable {
    const reg = vscode.window.registerFileDecorationProvider(this);
    this.disposables.push(
      reg,
      this.repos.onDidChange(() => {
        this.cache.clear();
        this._e.fire([]);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.complexityBadge')) {
          this.cache.clear();
          this._e.fire([]);
        }
      }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        this.cache.delete(doc.uri.fsPath);
        this._e.fire(doc.uri);
      }),
    );
    return new vscode.Disposable(() => this.dispose());
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(SHOW_COMMAND, () =>
        this.showReport().catch(e => vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`)),
      ),
    ];
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const cfg = vscode.workspace.getConfiguration('gitsight.complexityBadge');
    if (!cfg.get<boolean>('enabled', true)) return undefined;
    const git = this.repos.forFile(uri.fsPath);
    if (!git) return undefined;
    const rel = path.relative(git.cwd, uri.fsPath);
    if (!isAnalysableFile(rel)) return undefined;
    const maxBytes = clampInt(cfg.get<number>('maxFileBytes', 200_000), 1024, 5_000_000);

    const entry = await this.load(uri.fsPath, maxBytes);
    if (!entry) return undefined;
    const badge = badgeFor(entry.score.bucket);
    if (!badge) return undefined;
    const md = new vscode.MarkdownString(buildComplexityTooltip(entry.score));
    md.isTrusted = false;
    return {
      badge,
      tooltip: describeComplexity(entry.score),
      color: colourForBucket(entry.score.bucket),
    };
  }

  private async load(abs: string, maxBytes: number): Promise<CacheEntry | undefined> {
    const stat = await fs.promises.stat(abs).catch(() => undefined);
    if (!stat) return undefined;
    if (stat.size > maxBytes) {
      // Don't badge enormous files -- the heuristic loses meaning past
      // a few thousand lines anyway, and the read would be wasteful on
      // generated bundles.
      return undefined;
    }
    const cached = this.cache.get(abs);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }
    if (this.inFlight.has(abs)) return undefined;
    this.inFlight.add(abs);
    try {
      const body = await fs.promises.readFile(abs, 'utf8').catch(() => '');
      if (!body) return undefined;
      const score = computeComplexity(body);
      const entry: CacheEntry = { mtime: stat.mtimeMs, size: stat.size, score };
      this.cache.set(abs, entry);
      this._e.fire(vscode.Uri.file(abs));
      return entry;
    } finally {
      this.inFlight.delete(abs);
    }
  }

  private async showReport(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('GitSight: open a file first.');
      return;
    }
    const file = editor.document.uri.fsPath;
    const git = this.repos.forFile(file);
    if (!git) {
      vscode.window.showInformationMessage('GitSight: this file is not in a Git repository.');
      return;
    }
    const rel = path.relative(git.cwd, file);
    if (!isAnalysableFile(rel)) {
      vscode.window.showInformationMessage(`GitSight: complexity not analysed for ${rel}.`);
      return;
    }
    const cfg = vscode.workspace.getConfiguration('gitsight.complexityBadge');
    const maxBytes = clampInt(cfg.get<number>('maxFileBytes', 200_000), 1024, 5_000_000);
    const entry = await this.load(file, maxBytes);
    if (!entry) {
      vscode.window.showInformationMessage(`GitSight: ${rel} is too large to score (over ${maxBytes} bytes) or unreadable.`);
      return;
    }
    const s = entry.score;
    const lines: string[] = [
      `# GitSight: complexity report \u2014 ${rel}`,
      '',
      `**${describeComplexity(s)}**`,
      '',
      '| Metric | Value |',
      '| --- | --- |',
      `| Decision points | ${s.decisions} |`,
      `| Max nesting depth | ${s.maxNesting} |`,
      `| Logical lines | ${s.logicalLines} |`,
      `| Functions | ${s.functions} |`,
      `| Composite score | ${s.score} |`,
      `| Bucket | ${s.bucket} |`,
      '',
      '## How the score is built',
      '',
      'A weighted sum that favours decision points + nesting depth, with',
      'sub-linear contributions from line count + function count. Brackets:',
      '',
      `- < 20: low (no badge)`,
      `- < 60: medium (M)`,
      `- < 150: high (H, gutter colour)`,
      `- \u2265 150: extreme (X, gutter colour)`,
      '',
      classifyBucket(s.score) === 'extreme' || classifyBucket(s.score) === 'high'
        ? '**Consider splitting this file into smaller modules.**'
        : '_Complexity is in the comfortable range._',
    ];
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }
}

function colourForBucket(bucket: ReturnType<typeof classifyBucket>): vscode.ThemeColor | undefined {
  // Tint to draw the eye -- borrows VS Code's own diagnostic colours so
  // we automatically match the user's theme.
  switch (bucket) {
    case 'low':     return undefined;
    case 'medium':  return undefined;
    case 'high':    return new vscode.ThemeColor('list.warningForeground');
    case 'extreme': return new vscode.ThemeColor('list.errorForeground');
  }
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
