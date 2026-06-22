/**
 * F81 — Recent Contributors Decoration + Picker.
 *
 * Decorates every tracked file in the workspace with a tiny badge
 * showing how many unique contributors have touched it in the last N
 * commits (default 50), plus a rich tooltip listing them with their
 * last-touch date.
 *
 * Lightweight version of F50 fixtureLens but for every file, not just
 * fixtures. Useful for "who else touched this file recently?" at a
 * glance without opening blame.
 *
 * Also registers a command (`gitsight.recentContributors.show`) that
 * opens a QuickPick of the contributors for the currently-active file.
 *
 * Performance:
 *   - Provider caches per `${file}@${mtime}` (same shape as blameHover)
 *     to avoid shelling out on every decoration request.
 *   - VS Code calls provideFileDecoration lazily — only for files
 *     currently visible in the explorer. We never scan the whole repo.
 *   - On RepoManager change we drop the cache so the next decoration
 *     request re-shells out.
 *
 * Configurable via:
 *   gitsight.recentContributors.enabled        (default true)
 *   gitsight.recentContributors.scanCommits    (default 50, clamped 5..500)
 *   gitsight.recentContributors.maxInTooltip   (default 10)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { timeAgo } from '../git/format';
import {
  parseContributors,
  describeHeadline,
  describeContributor,
  buildTooltipMarkdown,
  badgeForCount,
  RecentContributor,
} from '../git/recentContributors';

const SHOW_COMMAND = 'gitsight.recentContributors.show';

interface CacheEntry {
  mtime: number;
  contributors: RecentContributor[];
  windowSize: number;
}

export class RecentContributorsProvider
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
        if (e.affectsConfiguration('gitsight.recentContributors')) {
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
        this.showPicker().catch(e => vscode.window.showErrorMessage(`GitSight: ${e.message ?? e}`)),
      ),
    ];
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== 'file') return undefined;
    const cfg = vscode.workspace.getConfiguration('gitsight.recentContributors');
    if (!cfg.get<boolean>('enabled', true)) return undefined;
    const git = this.repos.forFile(uri.fsPath);
    if (!git) return undefined;
    const rel = path.relative(git.cwd, uri.fsPath);
    if (!rel || rel.startsWith('..') || isSkippablePath(rel)) return undefined;

    const entry = await this.load(git, uri.fsPath, rel, cfg);
    if (!entry || !entry.contributors.length) return undefined;
    const badge = badgeForCount(entry.contributors.length);
    if (!badge) return undefined;
    const md = new vscode.MarkdownString(
      `**GitSight: recent contributors**\n\n${describeHeadline(entry.contributors, entry.windowSize)}\n\n${
        buildTooltipMarkdown(
          entry.contributors.slice(0, clampInt(cfg.get<number>('maxInTooltip', 10), 1, 50)),
          d => timeAgo(d),
        )
      }`,
    );
    md.isTrusted = false;
    return {
      badge,
      tooltip: `Recent contributors: ${entry.contributors.length} \u2014 hover for details`,
      // No color — we don't want to lie about file health like the
      // git scm decoration provider does. Just a neutral badge.
    };
  }

  private async load(
    git: Git,
    abs: string,
    rel: string,
    cfg: vscode.WorkspaceConfiguration,
  ): Promise<CacheEntry | undefined> {
    const stat = await fs.promises.stat(abs).catch(() => undefined);
    if (!stat) return undefined;
    const windowSize = clampInt(cfg.get<number>('scanCommits', 50), 5, 500);
    const cached = this.cache.get(abs);
    if (cached && cached.mtime === stat.mtimeMs && cached.windowSize === windowSize) {
      return cached;
    }
    if (this.inFlight.has(abs)) return undefined;
    this.inFlight.add(abs);
    try {
      const out = await safe(git, [
        'log',
        `-n${windowSize}`,
        '--no-merges',
        '--format=%an%x09%ae%x09%aI',
        '--',
        rel,
      ]);
      const contributors = parseContributors(out);
      const entry = { mtime: stat.mtimeMs, contributors, windowSize };
      this.cache.set(abs, entry);
      // Surface the result asynchronously so the explorer repaints once
      // the badge becomes available.
      this._e.fire(vscode.Uri.file(abs));
      return entry;
    } finally {
      this.inFlight.delete(abs);
    }
  }

  private async showPicker(): Promise<void> {
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
    const cfg = vscode.workspace.getConfiguration('gitsight.recentContributors');
    const rel = path.relative(git.cwd, file);
    const entry = await this.load(git, file, rel, cfg);
    if (!entry || !entry.contributors.length) {
      vscode.window.showInformationMessage(`GitSight: no recent contributors on ${rel}.`);
      return;
    }
    type Pk = vscode.QuickPickItem & { _c?: RecentContributor; _action?: 'filter'; };
    const items: Pk[] = [];
    items.push({ label: describeHeadline(entry.contributors, entry.windowSize), kind: vscode.QuickPickItemKind.Separator } as any);
    for (const c of entry.contributors) {
      items.push({
        label: `$(person) ${c.name}`,
        description: describeContributor(c, timeAgo(c.lastDate)),
        detail: c.email || undefined,
        _c: c,
        _action: 'filter',
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Recent contributors on ${rel}`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || !picked._c) return;
    // The most useful per-author action is to surface their commits via
    // the existing F8 authorsOfRange flow; absent that, fall back to a
    // copy-handle action.
    await vscode.env.clipboard.writeText(picked._c.email || picked._c.name);
    vscode.window.setStatusBarMessage(
      `Copied ${picked._c.email || picked._c.name}`,
      2500,
    );
  }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }
}

function isSkippablePath(rel: string): boolean {
  if (!rel || rel.endsWith('/')) return true;
  // Skip the kinds of files where contributor counts are noise:
  //   - inside node_modules / .git / dist / build
  //   - binary suffixes that won't have meaningful blame anyway
  if (/(?:^|\/)(?:node_modules|\.git|dist|build|out|out-test|coverage)(?:\/|$)/.test(rel)) return true;
  const lower = rel.toLowerCase();
  const binarySuffixes = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
    '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.mp3', '.mp4', '.mov', '.avi', '.webm',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.class', '.jar', '.war', '.pyc', '.pyo',
    '.vsix', '.wasm',
  ];
  for (const ext of binarySuffixes) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
