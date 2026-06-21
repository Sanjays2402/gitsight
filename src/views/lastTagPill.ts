/**
 * Last-Shown-Tag pill — surfaces the most recent tag in the status bar
 * alongside the commit-count since it. Click → action menu (copy name,
 * open on remote, show shortlog since, checkout detached).
 *
 *   $(tag) v1.2.3 +5
 *
 * Configurable via:
 *   gitsight.lastTagPill.enabled     boolean (default true)
 *   gitsight.lastTagPill.preferStable  boolean (default true) — when true,
 *     skip pre-release tags (v2.0.0-rc.1) in favour of the newest stable
 *     so a release branch shows the version users actually have.
 *
 * Cheap: one `git tag --sort=-creatordate --format=...` + one
 * `git rev-list --count tag..HEAD`, both gated by `RepoManager.onDidChange`
 * plus a 60s poll fallback.
 */
import * as vscode from 'vscode';
import { Git, Tag, remoteWebUrl } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { pickLatestTag, formatTagPill, formatTagTooltip } from '../git/latestTag';
import { ageLabel } from '../git/recentBranches';

interface PillState {
  pick: ReturnType<typeof pickLatestTag>;
  commitsSince?: number;
}

export class LastTagPill implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private cmdId = 'gitsight.lastTagPill.menu';

  constructor(private repos: RepoManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
    this.item.command = this.cmdId;
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(this.cmdId, () => this.showMenu()),
      repos.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitsight.lastTagPill')) this.refresh();
      }),
    );
    this.timer = setInterval(() => this.refresh(), 60_000);
    this.refresh();
  }

  async refresh() {
    const cfg = vscode.workspace.getConfiguration('gitsight.lastTagPill');
    if (!cfg.get<boolean>('enabled', true)) { this.item.hide(); return; }
    const git = this.repos.primary();
    if (!git) { this.item.hide(); return; }
    try {
      const state = await readState(git, cfg.get<boolean>('preferStable', true));
      if (!state.pick) { this.item.hide(); return; }
      this.item.text = `$(tag) ${formatTagPill(state.pick, state.commitsSince)}`;
      const tooltip = new vscode.MarkdownString(
        formatTagTooltip(state.pick, {
          ageLabel: state.pick.tag.date ? ageLabel(state.pick.tag.date.toISOString()) : '',
          commitsSince: state.commitsSince,
        }),
      );
      tooltip.isTrusted = true;
      this.item.tooltip = tooltip;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  private async showMenu() {
    const git = this.repos.primary();
    if (!git) return;
    const cfg = vscode.workspace.getConfiguration('gitsight.lastTagPill');
    const state = await readState(git, cfg.get<boolean>('preferStable', true));
    if (!state.pick) {
      vscode.window.showInformationMessage('GitSight: no tags in this repo yet.');
      return;
    }
    const tag = state.pick.tag.name;
    const since = state.commitsSince ?? 0;
    const items: (vscode.QuickPickItem & { _action: string })[] = [
      { label: '$(clippy) Copy tag name',           description: tag,                          _action: 'copy' },
      { label: '$(globe) Open tag on remote',       description: 'Release notes (where supported)', _action: 'open' },
      { label: '$(list-unordered) Show commits since', description: since > 0 ? `${since} commits` : 'HEAD is on the tag', _action: 'log' },
      { label: '$(clippy) Copy shortlog since',     description: 'Author counts for tag..HEAD',_action: 'copy-shortlog' },
      { label: '$(git-commit) Checkout tag (detached)', description: 'git checkout --detach',    _action: 'checkout' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Latest tag: ${tag}${since > 0 ? `  (+${since} commits)` : ''}`,
    });
    if (!picked) return;

    switch (picked._action) {
      case 'copy':
        await vscode.env.clipboard.writeText(tag);
        vscode.window.setStatusBarMessage(`Copied ${tag}`, 2000);
        return;
      case 'open': {
        const url = await tagReleaseUrl(git, tag);
        if (!url) {
          vscode.window.showWarningMessage('GitSight: no recognizable remote — cannot open tag.');
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      case 'log': {
        if (since === 0) {
          vscode.window.showInformationMessage(`GitSight: HEAD is on ${tag}.`);
          return;
        }
        const out = await safe(git, ['log', '--oneline', '--no-merges', `${tag}..HEAD`]);
        const doc = await vscode.workspace.openTextDocument({
          language: 'log',
          content: `# Commits since ${tag} (${since} total)\n\n${out}`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'copy-shortlog': {
        if (since === 0) {
          await vscode.env.clipboard.writeText('');
          vscode.window.showInformationMessage(`GitSight: HEAD is on ${tag} — nothing to copy.`);
          return;
        }
        const sl = await safe(git, ['shortlog', '-sne', '--no-merges', `${tag}..HEAD`]);
        await vscode.env.clipboard.writeText(sl);
        vscode.window.setStatusBarMessage(`Copied shortlog since ${tag}`, 2000);
        return;
      }
      case 'checkout': {
        try {
          await git.run(['checkout', '--detach', tag]);
          vscode.window.setStatusBarMessage(`Checked out ${tag} (detached)`, 2500);
          vscode.commands.executeCommand('gitsight.refresh');
        } catch (e: any) {
          vscode.window.showErrorMessage(`GitSight: ${e.message}`);
        }
        return;
      }
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}

async function readState(git: Git, preferStable: boolean): Promise<PillState> {
  const tags = await readTags(git);
  const pick = pickLatestTag(tags, { preferStable });
  if (!pick) return { pick: undefined };
  const commitsSince = await countCommitsSince(git, pick.tag.name);
  return { pick, commitsSince };
}

async function readTags(git: Git): Promise<Tag[]> {
  // Mirror the existing Git.tags() output shape: name | sha | subject | iso-date.
  // We read 200 most recent tags by creator date — enough for any real repo and
  // bounded so a 10k-tag monorepo doesn't drag the status bar.
  const raw = await safe(git, [
    'for-each-ref',
    '--sort=-creatordate',
    '--count=200',
    '--format=%(refname:short)\t%(objectname)\t%(contents:subject)\t%(creatordate:iso-strict)',
    'refs/tags',
  ]);
  return raw.split('\n').filter(Boolean).map(line => {
    const [name, sha, subject, date] = line.split('\t');
    return {
      name: name || '',
      sha: sha || '',
      subject: subject || '',
      date: date ? new Date(date) : undefined,
    } as Tag;
  });
}

async function countCommitsSince(git: Git, tag: string): Promise<number | undefined> {
  try {
    const out = await git.raw(['rev-list', '--count', `${tag}..HEAD`]);
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Host-aware tag URL. GitHub / GitLab / Bitbucket get their canonical
 * release/tag page; ADO falls back to the repo home (it doesn't have a
 * stable per-tag URL without a project context).
 */
async function tagReleaseUrl(git: Git, tag: string): Promise<string | undefined> {
  const remotes = await safe(git, ['remote', '-v']);
  // Cheap heuristic: pick the first origin fetch URL out of `remote -v`.
  const m = /^origin\s+(\S+)\s+\(fetch\)/m.exec(remotes);
  const url = m ? m[1] : '';
  if (!url) return undefined;
  const base = remoteWebUrl(url);
  if (!base) return undefined;
  const encoded = encodeURIComponent(tag);
  if (base.includes('github.com'))     return `${base}/releases/tag/${encoded}`;
  if (base.includes('gitlab'))         return `${base}/-/tags/${encoded}`;
  if (base.includes('bitbucket.org'))  return `${base}/src/${encoded}`;
  return base;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
