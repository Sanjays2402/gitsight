/**
 * Open Last Pushed Branch (F38) — the muscle-memory shortcut after running
 * `git push`. Mines the reflog for the most recent "update by push" entry,
 * derives the branch + remote URL, and opens the canonical "view branch"
 * page in the browser. When the host is unknown, falls back to a copy-URL
 * action so the command isn't a dead end.
 *
 * Picker layout: one row per useful destination on the same branch
 * (tree, compare vs main, new PR/MR). Each row is host-aware; rows that
 * don't apply to the detected host are hidden.
 */
import * as vscode from 'vscode';
import { Git, remoteWebUrl } from '../git/git';
import {
  parsePushReflog,
  branchTreeUrl,
  compareUrl,
  newPullRequestUrl,
  detectHost,
} from '../git/lastPushedBranch';

export async function showOpenLastPushedBranch(git: Git) {
  // Cap the reflog scan: 500 entries is enough to find the most recent push
  // in any normal workflow, and avoids dragging a year of history off disk.
  const reflog = await safe(git, [
    'reflog', '--date=iso-strict', '--all', '--pretty=format:%gD %gs', '-n', '500',
  ]);
  const last = parsePushReflog(reflog);

  let branch: string | undefined = last?.branch;
  let pushedWhen: string | undefined = last?.dateIso;

  if (!branch) {
    // Fallback: offer the current branch when the reflog has no push entry
    // (fresh clone, freshly init'd, etc.). Better to do something than nothing.
    const current = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current && current !== 'HEAD') {
      const confirm = await vscode.window.showWarningMessage(
        `GitSight: no push events in the local reflog. Use the current branch (${current}) instead?`,
        { modal: false },
        'Use current branch',
      );
      if (confirm !== 'Use current branch') return;
      branch = current;
    } else {
      vscode.window.showInformationMessage('GitSight: no push events in the local reflog and no branch to fall back to.');
      return;
    }
  }

  const remotes = await safe(git, ['remote', '-v']);
  const m = /^origin\s+(\S+)\s+\(fetch\)/m.exec(remotes);
  const fetchUrl = m ? m[1] : '';
  const base = fetchUrl ? remoteWebUrl(fetchUrl) : undefined;
  if (!base) {
    vscode.window.showWarningMessage('GitSight: no recognizable origin remote — cannot build a branch URL.');
    return;
  }

  const host = detectHost(base);
  const tree = branchTreeUrl(base, branch);
  const defaultBase = await guessDefaultBase(git);
  const cmp = defaultBase ? compareUrl(base, defaultBase, branch) : undefined;
  const pr = newPullRequestUrl(base, branch);

  type Pk = vscode.QuickPickItem & { _url?: string; _action?: 'copy-branch' };
  const items: Pk[] = [
    sep(`Last pushed: ${branch}${pushedWhen ? `  ·  ${relIsoLocal(pushedWhen)}` : ''}  ·  host: ${host}`),
  ];
  if (tree) items.push({ label: '$(git-branch) Open branch tree',           description: tree, _url: tree });
  if (cmp)  items.push({ label: `$(git-compare) Compare ${defaultBase}...${branch}`, description: cmp, _url: cmp });
  if (pr)   items.push({ label: '$(git-pull-request) Open new PR/MR page',  description: pr,   _url: pr });
  if (!tree && !cmp && !pr) {
    items.push({ label: '$(globe) Open repo on remote', description: base, _url: base });
  }
  items.push({ label: '$(clippy) Copy branch name', description: branch, _action: 'copy-branch' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Open ${branch} on ${host}`,
    matchOnDescription: true,
  });
  if (!picked) return;
  if (picked._url) {
    await vscode.env.openExternal(vscode.Uri.parse(picked._url));
    return;
  }
  if (picked._action === 'copy-branch') {
    await vscode.env.clipboard.writeText(branch);
    vscode.window.setStatusBarMessage(`Copied ${branch}`, 2000);
  }
}

async function guessDefaultBase(git: Git): Promise<string | undefined> {
  // Prefer `origin/HEAD`'s target when set; fall back to `main`, then `master`.
  const sym = (await safe(git, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
  if (sym) {
    // sym is like "refs/remotes/origin/main" — strip the prefix.
    const m = /refs\/remotes\/origin\/(.+)$/.exec(sym);
    if (m) return m[1];
  }
  for (const candidate of ['main', 'master', 'develop']) {
    const exists = await safe(git, ['rev-parse', '--verify', `--quiet`, `refs/remotes/origin/${candidate}`]);
    if (exists.trim()) return candidate;
  }
  return undefined;
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function sep(label: string): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

function relIsoLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
