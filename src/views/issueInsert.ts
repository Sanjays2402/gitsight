/**
 * F99 — GitHub issue link inserter.
 *
 * Two surfaces:
 *
 *   gitsight.insertIssueReference       — cursor-position insert of #NN
 *                                          (or org/repo#NN when crossing
 *                                          repos), or a markdown link
 *                                          for documentation contexts.
 *   gitsight.appendIssueTrailer         — append `Closes: #NN` (or
 *                                          Fixes / Resolves / Refs /
 *                                          Related) to the SCM input box,
 *                                          composing cleanly with F73
 *                                          commitFooter and F60 scaffold.
 *
 * The picker is one shared list of open issues sorted OPEN-first with
 * most-recent updates first. Picking dispatches to the right insert
 * mode based on which entry-point command the user invoked.
 *
 * Falls back gracefully when:
 *   - gh CLI isn't on PATH (hint to brew install gh)
 *   - origin isn't a GitHub remote (info toast)
 *   - the user picks "Insert markdown link" but there's no active editor
 *     (copies the link to clipboard instead)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { parseRemote } from '../git/hostDetect';
import {
  parseIssueList,
  sortIssuesForPicker,
  describeIssueLabel,
  describeIssueDetail,
  formatCursorReference,
  formatMarkdownLink,
  appendIssueTrailerToScmInput,
  IssueEntry,
  IssueTrailerKind,
  ISSUE_TRAILER_KINDS,
} from '../git/issueInsert';

const pexec = promisify(execFile);

export type InsertMode = 'cursor' | 'markdown-link' | 'trailer';

export async function insertIssueAtCursor(git: Git): Promise<void> {
  await runInsertFlow(git, 'cursor');
}

export async function insertIssueAsMarkdownLink(git: Git): Promise<void> {
  await runInsertFlow(git, 'markdown-link');
}

export async function appendIssueTrailerToScm(git: Git): Promise<void> {
  await runInsertFlow(git, 'trailer');
}

async function runInsertFlow(git: Git, mode: InsertMode): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }

  const slug = await resolveRepoSlug(git);
  if (!slug) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub repository.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.issueInsert');
  const limit = Math.max(10, Math.min(200, cfg.get<number>('listLimit', 40)));
  const includeClosed = cfg.get<boolean>('includeClosed', false);

  const issues = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: loading issues from ${slug}\u2026` },
    () => fetchIssues(git, limit, includeClosed),
  );
  if (!issues.length) {
    vscode.window.showInformationMessage(`GitSight: no ${includeClosed ? '' : 'open '}issues in ${slug}.`);
    return;
  }

  const picked = await pickIssue(issues);
  if (!picked) return;

  if (mode === 'cursor') {
    await doCursorInsert(picked, slug);
  } else if (mode === 'markdown-link') {
    await doMarkdownInsert(picked, slug);
  } else {
    await doTrailerAppend(picked, slug);
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version']); return true; } catch { return false; }
}

async function resolveRepoSlug(git: Git): Promise<string | undefined> {
  try {
    const remotes = await git.remotes();
    const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
    if (!origin) return undefined;
    const info = parseRemote(origin.fetchUrl);
    if (!info || info.host !== 'github') return undefined;
    if (!info.owner || !info.repo) return undefined;
    return `${info.owner}/${info.repo}`;
  } catch {
    return undefined;
  }
}

async function fetchIssues(git: Git, limit: number, includeClosed: boolean): Promise<IssueEntry[]> {
  const args = ['issue', 'list',
    '--limit', String(limit),
    '--state', includeClosed ? 'all' : 'open',
    '--json', 'number,title,state,labels,url,updatedAt,author,assignees'];
  try {
    const { stdout } = await pexec('gh', args, { cwd: git.cwd, maxBuffer: 20 * 1024 * 1024 });
    return sortIssuesForPicker(parseIssueList(stdout));
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? '');
    if (/not\s+authenticated/i.test(msg)) {
      vscode.window.showWarningMessage('GitSight: gh CLI not authenticated. Run `gh auth login`.');
    } else if (/could not resolve/i.test(msg) || /timeout/i.test(msg) || /network/i.test(msg)) {
      vscode.window.showWarningMessage('GitSight: could not reach GitHub (network).');
    } else {
      vscode.window.showErrorMessage(`GitSight: gh issue list failed — ${msg.split('\n')[0].slice(0, 200)}`);
    }
    return [];
  }
}

async function pickIssue(issues: IssueEntry[]): Promise<IssueEntry | undefined> {
  type Pk = vscode.QuickPickItem & { _issue: IssueEntry };
  const items: Pk[] = issues.map(iss => ({
    label: `$(${iss.state === 'OPEN' ? 'issues' : 'issue-closed'}) ${describeIssueLabel(iss)}`,
    description: describeIssueDetail(iss),
    detail: iss.url,
    _issue: iss,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Pick an issue (${issues.length} loaded)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?._issue;
}

async function doCursorInsert(iss: IssueEntry, slug: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    // No editor focused — fall through to clipboard.
    await vscode.env.clipboard.writeText(formatCursorReference(iss.number));
    vscode.window.setStatusBarMessage(`GitSight: #${iss.number} copied (no active editor).`, 3000);
    return;
  }
  const qualified = await maybePromptQualified(slug);
  const ref = formatCursorReference(iss.number, { qualified, repoSlug: slug });
  await editor.edit(edit => {
    for (const sel of editor.selections) {
      if (sel.isEmpty) edit.insert(sel.active, ref);
      else edit.replace(sel, ref);
    }
  });
  vscode.window.setStatusBarMessage(`GitSight: inserted ${ref}`, 2500);
}

async function doMarkdownInsert(iss: IssueEntry, slug: string): Promise<void> {
  const qualified = await maybePromptQualified(slug);
  const link = formatMarkdownLink(iss, { qualified, repoSlug: slug });
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(link);
    vscode.window.setStatusBarMessage(`GitSight: ${link} copied (no active editor).`, 3000);
    return;
  }
  await editor.edit(edit => {
    for (const sel of editor.selections) {
      if (sel.isEmpty) edit.insert(sel.active, link);
      else edit.replace(sel, link);
    }
  });
  vscode.window.setStatusBarMessage(`GitSight: inserted ${link}`, 2500);
}

async function doTrailerAppend(iss: IssueEntry, slug: string): Promise<void> {
  // Pick which trailer kind.
  const kindPicked = await vscode.window.showQuickPick(
    ISSUE_TRAILER_KINDS.map(k => ({
      label: k,
      description: describeTrailerKind(k),
    })),
    { placeHolder: `Trailer kind for #${iss.number}` },
  );
  if (!kindPicked) return;
  const kind = kindPicked.label as IssueTrailerKind;

  const qualified = await maybePromptQualified(slug);

  const repo = getScmRepo();
  if (!repo?.inputBox) {
    const trailer = `${kind}: ${formatCursorReference(iss.number, { qualified, repoSlug: slug })}`;
    await vscode.env.clipboard.writeText(trailer);
    vscode.window.showInformationMessage(`GitSight: SCM input not available — ${trailer} copied to clipboard.`);
    return;
  }

  const current: string = repo.inputBox.value ?? '';
  const { result, appended } = appendIssueTrailerToScmInput(current, kind, iss.number, { qualified, repoSlug: slug });
  if (!appended) {
    vscode.window.setStatusBarMessage(`GitSight: ${kind}: #${iss.number} already present — skipped.`, 3000);
    return;
  }
  repo.inputBox.value = result;
  await vscode.commands.executeCommand('workbench.view.scm');
  vscode.window.setStatusBarMessage(`GitSight: appended ${kind}: #${iss.number}`, 3000);
}

function describeTrailerKind(k: IssueTrailerKind): string {
  switch (k) {
    case 'Closes':   return 'GitHub closes the issue when this lands';
    case 'Fixes':    return 'Same as Closes — fixes-style verb';
    case 'Resolves': return 'Same as Closes — resolves-style verb';
    case 'Refs':     return 'Reference without closing';
    case 'Related':  return 'Loosely related';
  }
}

/**
 * When the current repo isn't the obvious target (i.e. the user might
 * want to reference an issue in another repo), ask whether to use the
 * `org/repo#NN` qualified form. We only prompt when the config flag
 * `gitsight.issueInsert.qualifiedPrompt` is true (default false) since
 * it's noisy for the common case where everything's in one repo.
 */
async function maybePromptQualified(slug: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('gitsight.issueInsert');
  if (!cfg.get<boolean>('qualifiedPrompt', false)) return false;
  if (!slug) return false;
  const picked = await vscode.window.showQuickPick(
    [
      { label: `$(symbol-number) #NN`, description: 'Bare reference (this repo only)', _q: false },
      { label: `$(symbol-namespace) ${slug}#NN`, description: 'Qualified reference (cross-repo safe)', _q: true },
    ],
    { placeHolder: 'Reference form' },
  );
  return picked?._q ?? false;
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
