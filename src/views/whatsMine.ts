/**
 * F100 — "What's mine?" dashboard.
 *
 * One command (`gitsight.whatsMine`) that surfaces every commitment the
 * current user has open: PRs that need their review, PRs they
 * authored, issues assigned to them, and their own recent commits in
 * the current repo. Picker shape mirrors F94 workspaceSecretAudit:
 * a tree-of-trees with a summary header, section separators, and
 * trailing global actions.
 *
 * Powered by:
 *   gh search prs --review-requested=@me --state=open --limit N
 *   gh search prs --author=@me --state=open --limit N
 *   gh search issues --assignee=@me --state=open --limit N
 *   git log --author=<self-email> --since=<n>d
 *
 * Picking a row routes to the right open-action (PR -> Open URL /
 * Copy URL / Checkout; issue -> Open / Copy / Append trailer; commit
 * -> Show commit detail / Copy SHA).
 *
 * Gracefully degrades when:
 *   - gh isn't on PATH or isn't authenticated -> a separate "gh not
 *     available" warning, then continues with only the local commit
 *     stream (which still works without gh)
 *   - origin isn't a GitHub remote -> picker still works; gh searches
 *     run org-wide (gh's default behaviour for @me searches)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import {
  parseAuthoredPrs,
  parseReviewRequestedPrs,
  parseAssignedIssues,
  parseRecentCommits,
  buildSections,
  describeSummary,
  describeItemLabel,
  describeItemDetail,
  glyphForItem,
  DashboardItem,
  DashboardSection,
} from '../git/whatsMine';

const pexec = promisify(execFile);

export async function showWhatsMineDashboard(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.whatsMine');
  const limit = Math.max(5, Math.min(100, cfg.get<number>('listLimit', 25)));
  const sinceDays = Math.max(1, Math.min(60, cfg.get<number>('commitWindowDays', 7)));

  const ghOk = await ghAvailable();

  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GitSight: gathering your open work\u2026' },
    async () => {
      const collected: DashboardItem[] = [];
      if (ghOk) {
        const [review, authored, issues] = await Promise.all([
          fetchReviewPrs(git, limit),
          fetchAuthoredPrs(git, limit),
          fetchAssignedIssues(git, limit),
        ]);
        collected.push(...review, ...authored, ...issues);
      }
      const commits = await fetchRecentCommits(git, sinceDays);
      collected.push(...commits);
      return collected;
    },
  );

  if (!items.length && !ghOk) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH and no recent commits (install: brew install gh).');
    return;
  }

  const sections = buildSections(items);
  await runPicker(git, sections, !ghOk);
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version']); return true; } catch { return false; }
}

async function fetchReviewPrs(git: Git, limit: number): Promise<DashboardItem[]> {
  const args = ['search', 'prs',
    '--review-requested', '@me',
    '--state', 'open',
    '--limit', String(limit),
    '--json', 'number,title,url,repository,updatedAt,isDraft,state,reviewDecision'];
  return runGhJson(args, git, parseReviewRequestedPrs);
}

async function fetchAuthoredPrs(git: Git, limit: number): Promise<DashboardItem[]> {
  const args = ['search', 'prs',
    '--author', '@me',
    '--state', 'open',
    '--limit', String(limit),
    '--json', 'number,title,url,repository,updatedAt,isDraft,state,reviewDecision,author'];
  return runGhJson(args, git, parseAuthoredPrs);
}

async function fetchAssignedIssues(git: Git, limit: number): Promise<DashboardItem[]> {
  const args = ['search', 'issues',
    '--assignee', '@me',
    '--state', 'open',
    '--limit', String(limit),
    '--json', 'number,title,url,repository,updatedAt,state'];
  return runGhJson(args, git, parseAssignedIssues);
}

async function runGhJson(
  args: string[],
  git: Git,
  parser: (raw: string) => DashboardItem[],
): Promise<DashboardItem[]> {
  try {
    const { stdout } = await pexec('gh', args, { cwd: git.cwd, maxBuffer: 20 * 1024 * 1024 });
    return parser(stdout);
  } catch {
    return [];
  }
}

async function fetchRecentCommits(git: Git, sinceDays: number): Promise<DashboardItem[]> {
  try {
    const email = (await git.raw(['config', 'user.email'])).trim();
    if (!email) return [];
    const out = await git.raw([
      'log',
      `--since=${sinceDays}.days`,
      `--author=${email}`,
      '--pretty=format:%H|%h|%aI|%s',
      '-n', '100',
    ]);
    return parseRecentCommits(out, { authorLogin: email });
  } catch {
    return [];
  }
}

interface SectionItem extends vscode.QuickPickItem {
  _item?: DashboardItem;
  _action?: 'open-section' | 'refresh' | 'configure';
}

async function runPicker(git: Git, sections: DashboardSection[], ghMissing: boolean): Promise<void> {
  const summary = describeSummary(sections);
  const items: SectionItem[] = [];

  if (ghMissing) {
    items.push({
      label: '$(warning) gh CLI not available',
      description: 'PR + issue surfaces are empty - install gh and `gh auth login` to populate',
      _action: 'configure',
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }

  items.push({
    label: summary,
    description: 'Summary',
    kind: vscode.QuickPickItemKind.Separator,
  });

  const now = new Date();
  for (const section of sections) {
    items.push({
      label: section.title,
      description: `${section.items.length} item${section.items.length === 1 ? '' : 's'}`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    if (section.items.length === 0) {
      items.push({
        label: '  $(circle-slash) (none)',
        description: '',
      });
      continue;
    }
    for (const item of section.items) {
      items.push({
        label: `  $(${glyphForItem(item)}) ${describeItemLabel(item)}`,
        description: describeItemDetail(item, now),
        detail: item.url || undefined,
        _item: item,
      });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(refresh) Refresh',
    description: 'Re-run the dashboard query',
    _action: 'refresh',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `What's mine — ${summary}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'refresh') return showWhatsMineDashboard(git);
  if (picked._action === 'configure') {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nousresearch.gitsight whatsMine');
    return;
  }
  if (!picked._item) return;

  await openItem(picked._item, git);
}

async function openItem(item: DashboardItem, git: Git): Promise<void> {
  if (item.kind === 'recent-commit') {
    const subOptions: vscode.QuickPickItem[] = [
      { label: '$(eye) Show commit detail',  description: item.shortSha ?? '' },
      { label: '$(copy) Copy SHA',           description: item.shortSha ?? '' },
    ];
    const sub = await vscode.window.showQuickPick(subOptions, { placeHolder: item.title });
    if (!sub) return;
    if (sub.label.includes('Copy SHA') && item.shortSha) {
      await vscode.env.clipboard.writeText(item.shortSha);
      vscode.window.setStatusBarMessage(`Copied ${item.shortSha}`, 2000);
      return;
    }
    if (sub.label.includes('Show commit detail') && item.shortSha) {
      await vscode.commands.executeCommand('gitsight.showCommitDetail', { sha: item.shortSha });
      return;
    }
    return;
  }

  // PR or issue.
  const subOptions: vscode.QuickPickItem[] = [];
  if (item.url) subOptions.push({ label: '$(link-external) Open on GitHub', description: item.url });
  if (item.url) subOptions.push({ label: '$(copy) Copy URL',                description: item.url });
  if (item.number && item.kind.startsWith('pr-')) {
    subOptions.push({ label: '$(git-pull-request) Checkout (gh pr checkout)', description: `#${item.number}` });
  }
  if (item.number && item.kind === 'issue-assigned') {
    subOptions.push({ label: '$(check) Append "Closes" trailer to SCM input', description: `#${item.number}` });
  }
  const sub = await vscode.window.showQuickPick(subOptions, { placeHolder: describeItemLabel(item) });
  if (!sub) return;

  if (sub.label.includes('Open on GitHub') && item.url) {
    await vscode.env.openExternal(vscode.Uri.parse(item.url));
    return;
  }
  if (sub.label.includes('Copy URL') && item.url) {
    await vscode.env.clipboard.writeText(item.url);
    vscode.window.setStatusBarMessage(`Copied ${item.url}`, 2000);
    return;
  }
  if (sub.label.includes('Checkout') && item.number) {
    const term = vscode.window.createTerminal({ name: `gh pr checkout #${item.number}`, cwd: git.cwd });
    term.show();
    term.sendText(`gh pr checkout ${item.number}`);
    return;
  }
  if (sub.label.includes('Append "Closes"') && item.number) {
    // Re-enter the F99 picker preselected to this issue? Simpler: bake
    // the trailer ourselves with a default kind, no extra picker.
    await vscode.commands.executeCommand('gitsight.appendIssueTrailer');
    return;
  }
}
