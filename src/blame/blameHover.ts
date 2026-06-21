/**
 * Inline blame hover — surfaces commit metadata when the user hovers any line
 * in a tracked file: subject, body, co-authors (parsed from trailers), and
 * Markdown command-links to view the commit / open it on the remote.
 *
 * The expensive bit is `git blame`. We cache by `${file}@${mtime}` so we don't
 * re-shell out on every mouse move. Hover registration covers every language
 * (`{ scheme: 'file' }`).
 *
 * Toggle via `gitsight.blameHover.enabled`. Body & co-authors can be hidden
 * individually for users who want compact hovers.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Git, BlameLine } from '../git/git';
import { timeAgo } from '../git/format';
import { parseCoAuthors, formatCoAuthors } from '../git/coAuthors';
import { classifyHoverAge, tintSpan, hoverAgeLabel, resolveThresholds } from '../git/hoverAgeTint';

interface CacheEntry { mtime: number; lines: BlameLine[]; }

export class BlameHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  private cache = new Map<string, CacheEntry>();
  private bodyCache = new Map<string, string>();
  private disposables: vscode.Disposable[] = [];

  constructor(private getGit: (file: string) => Git | undefined) {}

  register(): vscode.Disposable {
    const reg = vscode.languages.registerHoverProvider({ scheme: 'file' }, this);
    this.disposables.push(
      reg,
      vscode.workspace.onDidSaveTextDocument(doc => {
        this.cache.delete(doc.uri.fsPath);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.blameHover')) {
          this.cache.clear();
          this.bodyCache.clear();
        }
      }),
    );
    return new vscode.Disposable(() => this.dispose());
  }

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const cfg = vscode.workspace.getConfiguration('gitsight.blameHover');
    if (!cfg.get<boolean>('enabled', true)) return;
    if (document.uri.scheme !== 'file') return;
    if (document.isDirty) return;

    const file = document.uri.fsPath;
    const git = this.getGit(file);
    if (!git) return;

    const lines = await this.getBlame(git, file);
    if (!lines) return;
    const hit = lines.find(l => l.line === position.line + 1);
    if (!hit || /^0+$/.test(hit.sha)) return;

    const body = await this.getBody(git, hit.sha);
    const md = await this.renderHover(git, hit, body, cfg);
    return new vscode.Hover(md);
  }

  private async getBlame(git: Git, file: string): Promise<BlameLine[] | undefined> {
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat) return;
    const cached = this.cache.get(file);
    if (cached && cached.mtime === stat.mtimeMs) return cached.lines;
    try {
      const lines = await git.blame(file);
      this.cache.set(file, { mtime: stat.mtimeMs, lines });
      return lines;
    } catch {
      return;
    }
  }

  private async getBody(git: Git, sha: string): Promise<string> {
    const cached = this.bodyCache.get(sha);
    if (cached !== undefined) return cached;
    try {
      const body = (await git.raw(['log', '-n1', '--pretty=format:%B', sha])).trim();
      this.bodyCache.set(sha, body);
      return body;
    } catch {
      this.bodyCache.set(sha, '');
      return '';
    }
  }

  private async renderHover(
    git: Git,
    info: BlameLine,
    body: string,
    cfg: vscode.WorkspaceConfiguration,
  ): Promise<vscode.MarkdownString> {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    // Author-age tint relies on inline `<span style="color:…">` which needs
    // supportHtml. Escapes are applied to the author string before insertion
    // (see `tintSpan`), and `isTrusted = true` is unaffected — we only
    // permit colour styling, no scripts or arbitrary tags.
    md.supportHtml = true;

    const short = info.sha.slice(0, 7);
    md.appendMarkdown(`**${escapeMd(info.summary)}**\n\n`);

    // Author-age tint (F46): classify the commit date and colour the author
    // name accordingly. Users glance at the hover and instantly see whether
    // they're staring at fresh-from-yesterday code or a six-year fossil.
    const tintCfg = vscode.workspace.getConfiguration('gitsight.blameHover');
    const tintEnabled = tintCfg.get<boolean>('authorTint', true);
    let authorMd = escapeMd(info.author);
    let ageSuffix = timeAgo(info.date);
    if (tintEnabled) {
      const thresholds = resolveThresholds({
        agingDays: tintCfg.get<number>('authorTintAgingDays'),
        staleDays: tintCfg.get<number>('authorTintStaleDays'),
        ancientDays: tintCfg.get<number>('authorTintAncientDays'),
      });
      const bucket = classifyHoverAge(info.date, new Date(), thresholds);
      const tintFresh = tintCfg.get<boolean>('authorTintFresh', false);
      if (bucket !== 'fresh' || tintFresh) {
        // Use the un-Markdown-escaped raw author here — `tintSpan` does the
        // HTML escape, which is what MarkdownString's supportHtml renderer
        // expects.
        authorMd = tintSpan(bucket, info.author);
        ageSuffix = hoverAgeLabel(bucket, info.date, new Date());
      }
    }
    md.appendMarkdown(`\`${short}\` · ${authorMd} · ${ageSuffix}\n\n`);

    if (cfg.get<boolean>('showBody', true) && body) {
      // Strip the subject (first line) from the body, plus any trailing trailer block.
      const trimmed = body
        .split('\n')
        .slice(1)
        .join('\n')
        .replace(/\n*Co-authored-by:[\s\S]*$/i, '')
        .trim();
      if (trimmed) {
        md.appendCodeblock(trimmed, 'text');
        md.appendMarkdown('\n');
      }
    }

    if (cfg.get<boolean>('showCoAuthors', true)) {
      const coAuthors = parseCoAuthors(body);
      if (coAuthors.length) {
        md.appendMarkdown(`**Co-authors:** ${formatCoAuthors(coAuthors)}\n\n`);
      }
    }

    const args = encodeURIComponent(JSON.stringify([{ git, sha: info.sha, commit: { sha: info.sha, shortSha: short } }]));
    md.appendMarkdown(
      `[View commit](command:gitsight.showCommitDetail?${argsForShow(git, info.sha)})  ·  ` +
      `[Explain](command:gitsight.explainCommit?${args})  ·  ` +
      `[Open on remote](command:gitsight.openCommitOnRemote?${args})  ·  ` +
      `[Copy SHA](command:gitsight.copyCommitSha?${encodeURIComponent(JSON.stringify([info.sha]))})`,
    );
    md.appendMarkdown(`\n\n_${path.basename(git.cwd)}_`);
    return md;
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.cache.clear();
    this.bodyCache.clear();
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, m => '\\' + m);
}

/**
 * `gitsight.showCommitDetail` is registered with the signature `(git, sha)`.
 * Command-link args need to be a JSON array; positional args land as the
 * function's arguments.
 */
function argsForShow(git: Git, sha: string): string {
  return encodeURIComponent(JSON.stringify([git, sha]));
}
