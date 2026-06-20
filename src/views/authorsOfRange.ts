/**
 * "Show Authors of Range" command — pick two refs (or accept a free-form range
 * like `main..feature`), get a contributor leaderboard scoped to that range.
 * Results land in a QuickPick where each row shows the author, commit count,
 * and percentage share. Picking a row opens the GitSight search view scoped
 * to that author's commits in the range.
 *
 * Implementation: `git shortlog -sne <range>` does the heavy lifting; we
 * parse it via the pure summariser in src/git/rangeAuthors.ts.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  summariseRangeAuthors,
  formatRangeAuthorLine,
  isRangeExpr,
  RangeAuthor,
} from '../git/rangeAuthors';

const RECENTS_KEY = 'gitsight.authorsRange.recents';
const MAX_RECENTS = 8;

export async function showAuthorsOfRange(ctx: vscode.ExtensionContext, git: Git): Promise<void> {
  const range = await promptForRange(ctx, git);
  if (!range) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: authors of ${range}` },
    async () => {
      let out: string;
      try {
        out = await git.raw(['shortlog', '-sne', '--no-merges', range]);
      } catch (e: any) {
        vscode.window.showErrorMessage(`GitSight: invalid range '${range}'. ${e.message}`);
        return;
      }
      const summary = summariseRangeAuthors(out);
      if (summary.totalAuthors === 0) {
        vscode.window.showInformationMessage(`GitSight: no commits in range ${range}.`);
        return;
      }
      rememberRecent(ctx, range);

      const items = summary.authors.map(a => ({
        label: `$(person) ${formatRangeAuthorLine(a)}`,
        description: a.email,
        detail: `${a.commits} of ${summary.totalCommits} commits in ${range}`,
        _author: a,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `${summary.totalAuthors} authors · ${summary.totalCommits} commits · ${range}`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) return;
      await openAuthorCommits(git, range, picked._author);
    },
  );
}

async function promptForRange(ctx: vscode.ExtensionContext, git: Git): Promise<string | undefined> {
  const recents = ctx.workspaceState.get<string[]>(RECENTS_KEY, []);
  const branches = await git.branches(true).catch(() => []);
  const refNames = branches.map(b => b.name);

  type Item = vscode.QuickPickItem & { _range?: string; _action?: 'two-ref' | 'custom' };
  const items: Item[] = [];
  if (recents.length) {
    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator } as any);
    for (const r of recents) items.push({ label: `$(history) ${r}`, _range: r });
  }
  items.push({ label: 'Pick refs', kind: vscode.QuickPickItemKind.Separator } as any);
  items.push({ label: '$(git-compare) Pick two refs…', detail: 'Choose <from> and <to> branches/tags', _action: 'two-ref' });
  items.push({ label: '$(edit) Type a custom range…', detail: 'e.g. v1.0.0..HEAD or main...feature', _action: 'custom' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a recent range or build a new one',
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked._range) return picked._range;
  if (picked._action === 'custom') {
    const r = await vscode.window.showInputBox({
      prompt: 'Range (a..b or a...b)',
      placeHolder: 'main..feature',
      validateInput: v => (isRangeExpr(v.trim()) ? undefined : 'Use the form <from>..<to> or <from>...<to>'),
    });
    return r?.trim();
  }
  // two-ref pickers
  const from = await vscode.window.showQuickPick(refNames, { placeHolder: 'From ref' });
  if (!from) return undefined;
  const to = await vscode.window.showQuickPick(refNames, { placeHolder: 'To ref' });
  if (!to) return undefined;
  return `${from}..${to}`;
}

async function openAuthorCommits(git: Git, range: string, author: RangeAuthor): Promise<void> {
  let log: string;
  try {
    log = await git.raw(['log', range, '--no-merges', `--author=${author.email}`, '--pretty=format:%h\t%s\t%aI']);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: ${e.message}`);
    return;
  }
  const rows = log.split('\n').filter(Boolean);
  if (!rows.length) {
    vscode.window.showInformationMessage(`No commits by ${author.name} in ${range}.`);
    return;
  }
  const items = rows.map(r => {
    const [sha, subject, date] = r.split('\t');
    return {
      label: `$(git-commit) ${subject}`,
      description: `${sha}  ·  ${(date ?? '').slice(0, 10)}`,
      _sha: sha,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${rows.length} commits by ${author.name} in ${range}`,
    matchOnDescription: true,
  });
  if (!picked) return;
  await vscode.commands.executeCommand('gitsight.showCommitDetail', git, picked._sha);
}

function rememberRecent(ctx: vscode.ExtensionContext, range: string) {
  const prev = ctx.workspaceState.get<string[]>(RECENTS_KEY, []);
  const next = [range, ...prev.filter(r => r !== range)].slice(0, MAX_RECENTS);
  ctx.workspaceState.update(RECENTS_KEY, next);
}
