/**
 * "What Will Push?" — surfaces commits in `<upstream>..HEAD` with a quick-pick
 * of useful actions on the pending range. Sits at the boundary between
 * "you've been working" and "you're about to share", which is exactly where
 * the muscle memory of `git push --dry-run` lives but with eyes on it.
 *
 * UX intentionally avoids running `git push` itself — the existing Sync
 * status-bar item already owns that. This command is purely informational
 * plus the actions that compose well with the rest of GitSight.
 */
import * as vscode from 'vscode';
import { Git, remoteWebUrl } from '../git/git';
import {
  parsePendingLog, summarizePending, describePending,
  shortlogText, authorBreakdown, PendingCommit,
} from '../git/pendingPush';

type CommitPickItem = vscode.QuickPickItem & { _commit?: PendingCommit; _action?: ActionId };
type ActionId =
  | 'copy-oneline'
  | 'copy-shortlog'
  | 'copy-author-breakdown'
  | 'open-range-on-remote'
  | 'open-each-on-remote'
  | 'generate-changelog';

const FMT = '%H|%h|%an|%ae|%aI|%s';

export async function showWhatWillPush(git: Git) {
  const upstream = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (!upstream) {
    vscode.window.showWarningMessage(
      'GitSight: this branch has no upstream — set one with `git push -u origin <branch>` first.',
    );
    return;
  }
  const head = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

  const log = await safe(git, ['log', `--pretty=format:${FMT}`, `${upstream}..HEAD`]);
  const commits = parsePendingLog(log);

  if (!commits.length) {
    vscode.window.showInformationMessage(
      `GitSight: nothing to push — ${head} is in sync with ${upstream}.`,
    );
    return;
  }

  const filesTouched = await countFilesTouched(git, upstream);
  const summary = summarizePending(commits, filesTouched);

  // Build a single quick-pick: top items are the actions, then a separator,
  // then the commit list (informational, but accepting a commit copies its SHA).
  const items: CommitPickItem[] = [
    sep(`Actions on ${head} → ${upstream}  ·  ${describePending(summary)}`),
    { label: '$(clippy) Copy oneline list',         description: `${summary.count} commits`,        _action: 'copy-oneline' },
    { label: '$(clippy) Copy shortlog',             description: 'sha  subject  (author)',           _action: 'copy-shortlog' },
    { label: '$(clippy) Copy author breakdown',     description: authorBreakdown(commits),           _action: 'copy-author-breakdown' },
    { label: '$(git-compare) Open compare on remote',description: 'Diff vs upstream in browser',     _action: 'open-range-on-remote' },
    { label: '$(globe) Open each commit on remote', description: 'One tab per commit (up to 10)',    _action: 'open-each-on-remote' },
    { label: '$(book) Generate AI changelog',       description: 'Reuses gitsight.generateChangelog',_action: 'generate-changelog' },
    sep('Commits (accepting a commit copies its SHA)'),
    ...commits.map(c => ({
      label: `$(git-commit) ${c.shortSha}  ${c.subject}`,
      description: c.author,
      detail: relIsoLocal(c.dateIso),
      _commit: c,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${head} ahead of ${upstream}  ·  ${describePending(summary)}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked._commit) {
    await vscode.env.clipboard.writeText(picked._commit.sha);
    vscode.window.setStatusBarMessage(`Copied ${picked._commit.shortSha}`, 2000);
    return;
  }

  switch (picked._action) {
    case 'copy-oneline': {
      const text = commits.map(c => `${c.shortSha}  ${c.subject}`).join('\n');
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Copied ${commits.length} oneline entries`, 2000);
      return;
    }
    case 'copy-shortlog':
      await vscode.env.clipboard.writeText(shortlogText(commits));
      vscode.window.setStatusBarMessage(`Copied shortlog (${commits.length} commits)`, 2000);
      return;
    case 'copy-author-breakdown':
      await vscode.env.clipboard.writeText(authorBreakdown(commits));
      vscode.window.setStatusBarMessage('Copied author breakdown', 2000);
      return;
    case 'open-range-on-remote': {
      const url = await compareRangeUrl(git, upstream, head);
      if (!url) {
        vscode.window.showWarningMessage('GitSight: no recognizable remote for compare URL.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    case 'open-each-on-remote': {
      const remotes = await safe(git, ['remote', '-v']);
      const m = /^origin\s+(\S+)\s+\(fetch\)/m.exec(remotes);
      const base = m ? m[1] : '';
      if (!base) {
        vscode.window.showWarningMessage('GitSight: no recognizable remote.');
        return;
      }
      const cap = commits.slice(0, 10);
      for (const c of cap) {
        const url = remoteWebUrl(base, c.sha);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
      }
      if (commits.length > 10) {
        vscode.window.showInformationMessage(
          `GitSight: opened first 10 of ${commits.length} commits — copy the shortlog for the rest.`,
        );
      }
      return;
    }
    case 'generate-changelog':
      await vscode.commands.executeCommand('gitsight.generateChangelog');
      return;
  }
}

async function countFilesTouched(git: Git, upstream: string): Promise<number> {
  // `--diff-filter` keeps Added/Modified/Deleted/Renamed; ignores type-only changes.
  const out = await safe(git, ['diff', '--name-only', '--diff-filter=AMDR', `${upstream}..HEAD`]);
  return out.split('\n').filter(Boolean).length;
}

async function compareRangeUrl(git: Git, upstream: string, head: string): Promise<string | undefined> {
  const remotes = await safe(git, ['remote', '-v']);
  const m = /^origin\s+(\S+)\s+\(fetch\)/m.exec(remotes);
  const url = m ? m[1] : '';
  if (!url) return undefined;
  const base = remoteWebUrl(url);
  if (!base) return undefined;
  // `upstream` arrives as `origin/main`; we want the branch name on the remote.
  const upBranch = upstream.replace(/^[^/]+\//, '');
  const headEnc = encodeURIComponent(head);
  const upEnc = encodeURIComponent(upBranch);
  if (base.includes('github.com'))    return `${base}/compare/${upEnc}...${headEnc}`;
  if (base.includes('gitlab'))        return `${base}/-/compare/${upEnc}...${headEnc}`;
  if (base.includes('bitbucket.org')) return `${base}/branches/compare/${headEnc}..${upEnc}`;
  return base;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function sep(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function relIsoLocal(iso: string): string {
  // ISO 8601 → "2026-06-20 13:00" without seconds/timezone — easier on the eyes.
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
