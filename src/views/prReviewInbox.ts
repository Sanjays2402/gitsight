/**
 * F75 — PR Review-Request Inbox.
 *
 * Runs `gh pr list --search "is:open review-requested:@me"` (across all
 * repos accessible to the gh CLI by default; scopable to the current
 * repo via config) and surfaces the results in a picker that opens the
 * PR in the browser, copies the URL, or checks it out locally.
 *
 * Picker shape:
 *   ─ Header separator with total + urgency split
 *   <state-glyph> owner/repo#N  ·  title (author)  ·  3d ago
 *   ...
 *
 * Picking a PR fans out to a second QuickPick: Open in browser / Copy
 * URL / Checkout locally (uses `gh pr checkout`). Matches the F38 +
 * F74 picker pattern.
 *
 * Falls back when gh isn't on PATH, isn't authenticated, or returns
 * an empty result.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { timeAgo } from '../git/format';
import { parseGitHubRepo } from '../git/forcePushGuard';
import {
  parsePrReviewList,
  sortByUrgency,
  glyphForState,
  describePrLabel,
  describePrDetail,
  PrReviewEntry,
  ReviewState,
} from '../git/prReviewInbox';

const pexec = promisify(execFile);

export async function showPrReviewInbox(git: Git): Promise<void> {
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('gitsight.prReviewInbox');
  const scope = cfg.get<string>('scope', 'all') === 'current' ? 'current' : 'all';
  const limit = Math.max(5, Math.min(100, cfg.get<number>('listLimit', 25)));
  const includeDrafts = cfg.get<boolean>('includeDrafts', false);

  let repoFilter: { owner: string; repo: string } | undefined;
  if (scope === 'current') {
    repoFilter = await resolveGitHubRepo(git);
    if (!repoFilter) {
      vscode.window.showInformationMessage('GitSight: origin is not a GitHub repository.');
      return;
    }
  }

  const all = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GitSight: loading PRs that need your review\u2026' },
    () => fetchPrs(repoFilter, limit, includeDrafts),
  );
  const entries = sortByUrgency(all);

  if (entries.length === 0) {
    const scopeWord = scope === 'current' && repoFilter ? `for ${repoFilter.owner}/${repoFilter.repo}` : 'across all your repositories';
    vscode.window.showInformationMessage(`GitSight: no PRs need your review ${scopeWord}.`);
    return;
  }

  type Pk = vscode.QuickPickItem & { _entry: PrReviewEntry };
  const items: Pk[] = [];
  items.push({ label: headerSeparatorLabel(entries), kind: vscode.QuickPickItemKind.Separator } as any);
  for (const e of entries) {
    const rel = e.updatedAt ? timeAgo(new Date(e.updatedAt)) : '';
    items.push({
      label: `$(${glyphForState(e.reviewState)}) ${describePrLabel(e, rel)}`,
      description: describeStateLabel(e.reviewState),
      detail: describePrDetail(e),
      _entry: e,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'PRs awaiting your review',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked || !picked._entry) return;

  await showPrActions(git, picked._entry);
}

async function showPrActions(git: Git, entry: PrReviewEntry): Promise<void> {
  type Pk = vscode.QuickPickItem & { _action: 'open' | 'copy' | 'checkout' | 'preflight' };
  const headline = `${entry.repoSlug}#${entry.number} \u00b7 ${entry.title}`;
  const action = await vscode.window.showQuickPick<Pk>([
    { label: headline, kind: vscode.QuickPickItemKind.Separator } as any,
    { label: '$(globe) Open in browser',           description: entry.url, _action: 'open'     },
    { label: '$(clippy) Copy PR URL',              description: entry.url, _action: 'copy'     },
    { label: '$(rocket) Run checkout pre-flight',  description: 'safety checks before gh pr checkout', _action: 'preflight' },
    { label: '$(git-pull-request) Checkout locally', description: `gh pr checkout ${entry.number}`, _action: 'checkout' },
  ], { placeHolder: `PR ${entry.repoSlug}#${entry.number}`, matchOnDescription: true });
  if (!action || !action._action) return;

  if (action._action === 'open') {
    if (entry.url) await vscode.env.openExternal(vscode.Uri.parse(entry.url));
    return;
  }
  if (action._action === 'copy') {
    await vscode.env.clipboard.writeText(entry.url);
    vscode.window.setStatusBarMessage(`Copied ${entry.repoSlug}#${entry.number} URL`, 2000);
    return;
  }
  if (action._action === 'preflight') {
    await vscode.commands.executeCommand('gitsight.prCheckoutPreflight', {
      number: entry.number,
      repoSlug: entry.repoSlug,
      headRefName: entry.headRefName,
      baseRefName: entry.baseRefName,
      url: entry.url,
    });
    return;
  }
  if (action._action === 'checkout') {
    await checkoutPr(git, entry);
    return;
  }
}

async function checkoutPr(git: Git, entry: PrReviewEntry): Promise<void> {
  // Only run `gh pr checkout` when the local clone's origin matches the
  // PR's repo — otherwise we'd land the wrong branch in the wrong tree.
  const localRepo = await resolveGitHubRepo(git);
  if (!localRepo || `${localRepo.owner}/${localRepo.repo}` !== entry.repoSlug) {
    const ok = await vscode.window.showWarningMessage(
      `GitSight: this workspace's origin (${localRepo ? localRepo.owner + '/' + localRepo.repo : 'unknown'}) doesn't match ${entry.repoSlug}.`,
      { modal: true, detail: 'Open the PR in the browser instead?' },
      'Open in browser',
    );
    if (ok === 'Open in browser' && entry.url) {
      await vscode.env.openExternal(vscode.Uri.parse(entry.url));
    }
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `GitSight: checking out PR #${entry.number}\u2026` },
      () => pexec('gh', ['pr', 'checkout', String(entry.number)], { cwd: git.cwd, maxBuffer: 4 * 1024 * 1024 }).then(() => undefined),
    );
    vscode.window.setStatusBarMessage(`Checked out PR #${entry.number}`, 3000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr checkout failed — ${String(e.stderr ?? e.message ?? '').split('\n')[0]}`);
  }
}

async function fetchPrs(
  repoFilter: { owner: string; repo: string } | undefined,
  limit: number,
  includeDrafts: boolean,
): Promise<PrReviewEntry[]> {
  const search = [
    'is:open',
    'review-requested:@me',
    'archived:false',
    includeDrafts ? '' : 'draft:false',
  ].filter(Boolean).join(' ');
  const args = [
    'pr', 'list',
    '--state', 'open',
    '--limit', String(limit),
    '--search', search,
    '--json', 'number,title,url,headRefName,baseRefName,author,repository,updatedAt,isDraft,additions,deletions,changedFiles,reviewDecision',
  ];
  if (repoFilter) {
    args.splice(1, 0, '--repo', `${repoFilter.owner}/${repoFilter.repo}`);
  }
  try {
    const { stdout } = await pexec('gh', args, { maxBuffer: 8 * 1024 * 1024 });
    return parsePrReviewList(stdout);
  } catch (e: any) {
    const stderr = String(e.stderr ?? e.message ?? '');
    if (/not\s+authenticated/i.test(stderr)) {
      vscode.window.showWarningMessage('GitSight: gh is not authenticated. Run `gh auth login` and try again.');
    } else if (stderr.trim()) {
      vscode.window.showErrorMessage(`GitSight: gh pr list failed — ${stderr.split('\n')[0]}`);
    }
    return [];
  }
}

function headerSeparatorLabel(entries: PrReviewEntry[]): string {
  const counts: Record<ReviewState, number> = {
    'review-required': 0, 'changes-requested': 0, 'commented': 0,
    'approved': 0, 'unknown': 0,
  };
  for (const e of entries) counts[e.reviewState]++;
  const bits = [
    counts['review-required'] ? `${counts['review-required']} need review` : '',
    counts['changes-requested'] ? `${counts['changes-requested']} changes requested` : '',
    counts.commented ? `${counts.commented} commented` : '',
    counts.approved ? `${counts.approved} approved` : '',
  ].filter(Boolean);
  return `${entries.length} PR${entries.length === 1 ? '' : 's'} \u00b7 ${bits.join(' \u00b7 ') || 'review pending'}`;
}

function describeStateLabel(state: ReviewState): string {
  switch (state) {
    case 'review-required':   return 'review required';
    case 'changes-requested': return 'changes requested';
    case 'approved':          return 'approved';
    case 'commented':         return 'commented';
    case 'unknown':           return '';
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
