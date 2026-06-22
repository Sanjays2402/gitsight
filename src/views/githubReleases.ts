/**
 * F74 — GitHub Releases companion.
 *
 * Lists recent releases for the repo via `gh release list`, lets the
 * user preview notes (markdown buffer + Open on GitHub), copy tags, or
 * launch `gh release create` from the latest unreleased tag in a
 * terminal so the standard editor flow takes over.
 *
 * Picker shape:
 *
 *   ─ Header separator with repo + release count
 *   Create release from <tag>   (only when latest local tag is unreleased)
 *   ─ Releases separator
 *   <tagName>  ·  <published>   (one row per release; rich tooltip)
 *
 * Picking a release shows a second QuickPick: View notes / Copy tag /
 * Open on GitHub. View notes opens a markdown scratch buffer with the
 * rendered body + a link back to the GitHub release page.
 *
 * Falls back gracefully when `gh` isn't on PATH (single info toast)
 * or origin isn't a GitHub remote (single warning toast).
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import { parseGitHubRepo } from '../git/forcePushGuard';
import {
  parseReleaseList,
  parseReleaseDetail,
  describeReleaseListEntry,
  renderReleaseMarkdown,
  suggestCreateFromTag,
  ReleaseListEntry,
} from '../git/githubReleases';

const pexec = promisify(execFile);

export async function showReleasesCompanion(git: Git): Promise<void> {
  const repo = await resolveGitHubRepo(git);
  if (!repo) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub repository.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.releasesCompanion');
  const limit = Math.max(5, Math.min(100, cfg.get<number>('listLimit', 20)));

  const { releases, candidateTag } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: loading releases for ${repo.owner}/${repo.repo}\u2026` },
    async () => {
      const list = await listReleases(repo.owner, repo.repo, limit);
      const tags = await safe(git, ['tag', '--sort=-creatordate']);
      const candidate = suggestCreateFromTag(tags, list);
      return { releases: list, candidateTag: candidate };
    },
  );

  if (releases.length === 0 && !candidateTag) {
    vscode.window.showInformationMessage(`GitSight: ${repo.owner}/${repo.repo} has no releases yet.`);
    return;
  }

  type Pk = vscode.QuickPickItem & {
    _action: 'view' | 'create-from-tag';
    _entry?: ReleaseListEntry;
    _tag?: string;
  };

  const items: Pk[] = [];
  items.push({ label: `${repo.owner}/${repo.repo} \u00b7 ${releases.length} release${releases.length === 1 ? '' : 's'}`, kind: vscode.QuickPickItemKind.Separator } as any);
  if (candidateTag) {
    items.push({
      label: `$(tag) Create release from ${candidateTag}`,
      description: 'Opens `gh release create` in a terminal',
      detail: 'Local tag has no matching release yet',
      _action: 'create-from-tag',
      _tag: candidateTag,
    });
  }
  if (releases.length) {
    items.push({ label: 'Releases', kind: vscode.QuickPickItemKind.Separator } as any);
    for (const r of releases) {
      const rel = r.publishedAt ? timeAgo(new Date(r.publishedAt)) : '';
      const icon = r.isDraft ? '$(file)' : (r.isPrerelease ? '$(beaker)' : '$(rocket)');
      items.push({
        label: `${icon} ${describeReleaseListEntry(r, rel)}`,
        description: r.name && r.name !== r.tagName ? r.name : undefined,
        detail: r.url || undefined,
        _action: 'view',
        _entry: r,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Releases for ${repo.owner}/${repo.repo}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked._action) return;

  if (picked._action === 'create-from-tag' && picked._tag) {
    await createReleaseFromTag(git, picked._tag);
    return;
  }
  if (picked._action === 'view' && picked._entry) {
    await showReleaseDetail(repo.owner, repo.repo, picked._entry);
    return;
  }
}

async function showReleaseDetail(owner: string, repo: string, entry: ReleaseListEntry): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action: 'notes' | 'copy-tag' | 'open' };
  const tags: string[] = [];
  if (entry.isDraft) tags.push('draft');
  if (entry.isPrerelease) tags.push('prerelease');
  const headline = `${entry.tagName} \u00b7 ${entry.name || entry.tagName}${tags.length ? `  \u00b7  ${tags.join(' \u00b7 ')}` : ''}`;

  const action = await vscode.window.showQuickPick<Pk>([
    { label: headline, kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(notebook) View notes',     description: 'Open the rendered release body in a markdown scratch buffer', _action: 'notes' },
    { label: '$(globe) Open on GitHub',    description: entry.url,                                                       _action: 'open'  },
    { label: '$(clippy) Copy tag name',    description: entry.tagName,                                                   _action: 'copy-tag' },
  ], { placeHolder: `Release ${entry.tagName}`, matchOnDescription: true });
  if (!action || !action._action) return;

  if (action._action === 'open') {
    if (entry.url) await vscode.env.openExternal(vscode.Uri.parse(entry.url));
    return;
  }
  if (action._action === 'copy-tag') {
    await vscode.env.clipboard.writeText(entry.tagName);
    vscode.window.setStatusBarMessage(`Copied ${entry.tagName}`, 2000);
    return;
  }
  // notes
  const detail = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: loading notes for ${entry.tagName}\u2026` },
    async () => {
      const raw = await ghJson(['release', 'view', entry.tagName, '--repo', `${owner}/${repo}`, '--json', 'tagName,name,body,publishedAt,isDraft,isPrerelease,url']);
      return parseReleaseDetail(raw);
    },
  );
  if (!detail) {
    vscode.window.showWarningMessage(`GitSight: could not load notes for ${entry.tagName}.`);
    return;
  }
  const md = renderReleaseMarkdown(detail, detail.publishedAt ? timeAgo(new Date(detail.publishedAt)) : '');
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function createReleaseFromTag(git: Git, tag: string): Promise<void> {
  const confirm = await vscode.window.showInformationMessage(
    `Create a GitHub release from tag ${tag}?`,
    { modal: true, detail: 'Opens `gh release create` in a terminal. Use the editor that opens to write the release notes; gh handles uploading.' },
    'Create release',
  );
  if (confirm !== 'Create release') return;
  const term = vscode.window.createTerminal({ name: `gh release create ${tag}`, cwd: git.cwd });
  term.show();
  term.sendText(`gh release create ${JSON.stringify(tag)} --title ${JSON.stringify(tag)} --notes-from-tag`);
}

async function listReleases(owner: string, repo: string, limit: number): Promise<ReleaseListEntry[]> {
  const raw = await ghJson([
    'release', 'list',
    '--repo', `${owner}/${repo}`,
    '--limit', String(limit),
    '--json', 'tagName,name,publishedAt,isDraft,isPrerelease,url',
  ]);
  return parseReleaseList(raw);
}

async function ghJson(args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('gh', args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    const stderr = String(e.stderr ?? e.message ?? '');
    if (/not\s+authenticated/i.test(stderr)) {
      vscode.window.showWarningMessage('GitSight: gh is not authenticated. Run `gh auth login` and try again.');
    }
    return '';
  }
}

async function resolveGitHubRepo(git: Git): Promise<{ owner: string; repo: string } | undefined> {
  try {
    const out = await git.raw(['remote', 'get-url', 'origin']);
    return parseGitHubRepo(out.trim());
  } catch {
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { maxBuffer: 64 * 1024 }); return true; } catch { return false; }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
