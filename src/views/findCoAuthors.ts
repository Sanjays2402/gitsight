/**
 * Find Co-Authors (F18) — scans the last N commits, mines authors + existing
 * `Co-authored-by:` trailers, and offers a multi-select quick-pick to append
 * the picked people as trailers to the SCM input box (or copy to clipboard
 * when the SCM box isn't available).
 *
 * Self-identification: pulls `git config --get-all user.email` + the configured
 * `user.email` so the current user is never suggested as their own co-author.
 *
 * Pure ranking + trailer math lives in src/git/coAuthorSuggest.ts (unit-tested).
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import {
  buildCoAuthorSuggestions,
  insertTrailers,
  CoAuthorSuggestion,
} from '../git/coAuthorSuggest';

const DEFAULT_SCAN = 200;

interface Item extends vscode.QuickPickItem {
  _s: CoAuthorSuggestion;
}

export async function showFindCoAuthors(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.coAuthors');
  const scan = Math.max(20, cfg.get<number>('scanCommits', DEFAULT_SCAN));

  const selfEmails = await readSelfEmails(git);
  const commits = await git.log({ max: scan });
  if (!commits.length) {
    vscode.window.showInformationMessage('GitSight: no commits to scan.');
    return;
  }

  const suggestions = buildCoAuthorSuggestions(
    commits.map(c => ({
      sha: c.sha,
      authorName: c.author,
      authorEmail: c.email,
      message: `${c.subject}\n\n${c.body}`,
      date: c.date,
    })),
    selfEmails,
  );
  if (!suggestions.length) {
    vscode.window.showInformationMessage(`GitSight: scanned ${commits.length} commits — no co-author candidates found.`);
    return;
  }

  const items: Item[] = suggestions.map(s => {
    const bits: string[] = [];
    bits.push(`${s.count} commit${s.count === 1 ? '' : 's'}`);
    bits.push(timeAgo(s.lastSeen));
    bits.push([...s.sources].join('+'));
    return {
      label: `$(person) ${s.name}`,
      description: bits.join('  ·  '),
      detail: s.email,
      _s: s,
    };
  });

  const qp = vscode.window.createQuickPick<Item>();
  qp.items = items;
  qp.canSelectMany = true;
  qp.placeholder = `Pick co-authors to add (scanned ${commits.length} commits, ${suggestions.length} candidates)`;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.title = 'GitSight: Find Co-Authors';
  const picks = await new Promise<readonly Item[] | undefined>(resolve => {
    qp.onDidAccept(() => { resolve(qp.selectedItems); qp.hide(); });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!picks || picks.length === 0) return;

  const trailerPicks = picks.map(p => ({ name: p._s.name, email: p._s.email }));

  // Try to write into the built-in git extension's first repo SCM input box.
  const repo = getScmRepo();
  if (repo) {
    const before: string = repo.inputBox.value ?? '';
    const after = insertTrailers(before, trailerPicks);
    repo.inputBox.value = after;
    await vscode.commands.executeCommand('workbench.view.scm');
    vscode.window.setStatusBarMessage(
      `GitSight: added ${picks.length} co-author${picks.length === 1 ? '' : 's'} to commit message`,
      3000,
    );
    return;
  }

  // Fall back to copying the trailer block to the clipboard.
  const block = trailerPicks.map(p => `Co-authored-by: ${p.name} <${p.email}>`).join('\n');
  await vscode.env.clipboard.writeText(block);
  vscode.window.showInformationMessage(
    `GitSight: SCM input not available — ${picks.length} trailer${picks.length === 1 ? '' : 's'} copied to clipboard.`,
  );
}

async function readSelfEmails(git: Git): Promise<string[]> {
  const set = new Set<string>();
  // user.email (current scope)
  try {
    const e = (await git.raw(['config', '--get', 'user.email'])).trim();
    if (e) set.add(e.toLowerCase());
  } catch { /* not set */ }
  // user.email (all scopes, including system/global)
  try {
    const all = await git.raw(['config', '--get-all', 'user.email']);
    for (const line of all.split('\n')) {
      const t = line.trim().toLowerCase();
      if (t) set.add(t);
    }
  } catch { /* not set */ }
  // Workspace override
  const extra = vscode.workspace.getConfiguration('gitsight.coAuthors').get<string[]>('selfEmails', []);
  for (const e of extra) {
    if (e?.trim()) set.add(e.trim().toLowerCase());
  }
  return [...set];
}

function getScmRepo(): any | null {
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt || !gitExt.isActive) return null;
    const api = gitExt.exports?.getAPI?.(1);
    return api?.repositories?.[0] ?? null;
  } catch {
    return null;
  }
}
