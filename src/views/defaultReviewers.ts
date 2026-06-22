/**
 * Default-Reviewers Picker (F57).
 *
 * For an open PR on the current branch, parse `.github/CODEOWNERS`, compute
 * which handles + teams own the changed files, present a multi-select
 * picker pre-ticked with the owners, and invoke
 * `gh pr edit <num> --add-reviewer <handle>` for each pick.
 *
 * Flow:
 *   1. Locate the open PR for the current branch via `gh pr view`.
 *   2. Resolve the PR base ref (or fall back to gitsight.defaultReviewers.fallbackBase).
 *   3. Compute the changed file list via `git diff --name-only <base>...HEAD`.
 *   4. Load CODEOWNERS (root, .github/, docs/ — first that exists wins).
 *   5. Build reviewer suggestions, drop the PR author, surface the picker.
 *   6. Pass the picks to `gh pr edit --add-reviewer` and report results.
 *
 * Gracefully degrades when:
 *   - gh CLI isn't installed → show install hint instead of crashing.
 *   - No CODEOWNERS file → show information toast and exit.
 *   - No PR found → offer to copy the suggested handles to clipboard.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Git } from '../git/git';
import { parseCodeownersBody } from '../git/filesIOwn';
import {
  buildReviewerSuggestions,
  describeSuggestion,
  describeSuggestionDetail,
  describeSuggestionWithLoad,
  buildGhAddReviewerArgs,
  parseChangedPaths,
  rerankRoundRobin,
  countReviewerLoad,
  GhPrLoadEntry,
  ReviewerSuggestion,
  AuthorIdentity,
} from '../git/defaultReviewers';

const pexec = promisify(execFile);

type Pk = vscode.QuickPickItem & { _suggestion: ReviewerSuggestion };

export async function showDefaultReviewersPicker(git: Git): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.defaultReviewers');
  const fallbackBase = cfg.get<string>('fallbackBase', 'main') ?? 'main';
  const includeTeams = cfg.get<boolean>('includeTeams', true) ?? true;
  const extraExcluded = cfg.get<string[]>('exclude', []) ?? [];
  const roundRobin = cfg.get<boolean>('roundRobin', true) ?? true;
  const roundRobinWindow = Math.max(1, cfg.get<number>('roundRobinWindow', 20) ?? 20);

  // 1. Resolve PR + base.
  const prInfo = await loadPrForBranch(git);
  const base = prInfo?.baseRefName || fallbackBase;
  const head = prInfo?.headRefName || (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

  // 2. Changed files.
  const diffRaw = await safe(git, ['diff', '--name-only', `${base}...${head || 'HEAD'}`]);
  const changed = parseChangedPaths(diffRaw);
  if (!changed.length) {
    vscode.window.showInformationMessage(
      `GitSight: no changed files between ${base} and ${head || 'HEAD'} — nothing to assign reviewers for.`,
    );
    return;
  }

  // 3. CODEOWNERS.
  const owners = await loadCodeowners(git.cwd);
  if (!owners.found) {
    vscode.window.showInformationMessage(
      'GitSight: no CODEOWNERS file in this repo. Add one to .github/CODEOWNERS to enable reviewer suggestions.',
    );
    return;
  }

  // 4. Author identity for exclusion.
  const author = await loadAuthor(git, prInfo?.authorLogin);

  // 5. Build suggestions.
  const suggestions = buildReviewerSuggestions({
    rules: owners.rules,
    changedPaths: changed,
    author,
    extraExcluded,
    includeTeams,
  });

  if (!suggestions.length) {
    vscode.window.showInformationMessage(
      `GitSight: no CODEOWNERS rule applies to the ${changed.length} changed file(s) (or only the author owns them).`,
    );
    return;
  }

  // 5b. Round-robin: re-rank within each coverage tier by recent request load.
  let ranked = suggestions;
  let loadByHandle = new Map<string, number>();
  if (roundRobin) {
    loadByHandle = await loadRecentReviewerLoad(git, roundRobinWindow);
    ranked = rerankRoundRobin({ suggestions, loadByHandle });
  }

  // 6. Picker.
  const items: Pk[] = ranked.map(s => ({
    label: `${s.kind === 'team' ? '$(organization) ' : '$(account) '}${s.displayHandle}`,
    description: roundRobin
      ? describeSuggestionWithLoad(s, changed.length, loadByHandle)
      : describeSuggestion(s, changed.length),
    detail: describeSuggestionDetail(s),
    picked: true,
    _suggestion: s,
  }));

  const title = prInfo
    ? `Suggest reviewers for PR #${prInfo.number} (${changed.length} file${changed.length === 1 ? '' : 's'} changed)`
    : `Suggest reviewers (${changed.length} file${changed.length === 1 ? '' : 's'} changed)`;

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title,
    placeHolder: `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} from CODEOWNERS \u00b7 base=${base}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked || !picked.length) return;

  const selected = picked.map(p => p._suggestion);

  if (!prInfo) {
    const handles = selected.map(s => s.displayHandle).join(' ');
    const action = await vscode.window.showInformationMessage(
      `GitSight: no open PR for ${head || 'this branch'}. Copy the ${selected.length} suggested handle(s) to clipboard?`,
      'Copy handles',
    );
    if (action === 'Copy handles') {
      await vscode.env.clipboard.writeText(handles);
      vscode.window.setStatusBarMessage(`GitSight: copied ${selected.length} reviewer handle(s).`, 3000);
    }
    return;
  }

  const built = buildGhAddReviewerArgs(prInfo.number, selected);
  if (!built) return;

  // Check for gh CLI before invoking.
  const ghOk = await ghAvailable();
  if (!ghOk) {
    vscode.window.showWarningMessage(
      `GitSight: gh CLI not found on PATH. Install GitHub CLI to assign reviewers automatically. Copied ${selected.length} handle(s) to clipboard.`,
    );
    await vscode.env.clipboard.writeText(selected.map(s => s.displayHandle).join(' '));
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: assigning ${selected.length} reviewer${selected.length === 1 ? '' : 's'} to PR #${prInfo.number}\u2026`,
    },
    async () => {
      try {
        await pexec('gh', built.args, { cwd: git.cwd, maxBuffer: 10 * 1024 * 1024 });
        const parts: string[] = [];
        if (built.users.length) parts.push(`${built.users.length} user${built.users.length === 1 ? '' : 's'}`);
        if (built.teams.length) parts.push(`${built.teams.length} team${built.teams.length === 1 ? '' : 's'}`);
        vscode.window.setStatusBarMessage(
          `GitSight: added ${parts.join(' + ')} as reviewer(s) on PR #${prInfo.number}.`,
          4000,
        );
      } catch (e: any) {
        const stderr = (e?.stderr || e?.message || String(e)).toString().trim();
        const firstLine = stderr.split('\n')[0];
        vscode.window.showErrorMessage(
          `GitSight: gh pr edit failed: ${firstLine}`,
        );
      }
    },
  );
}

interface PrInfo {
  number: number;
  baseRefName: string;
  headRefName: string;
  authorLogin?: string;
}

async function loadPrForBranch(git: Git): Promise<PrInfo | undefined> {
  if (!(await ghAvailable())) return undefined;
  try {
    const { stdout } = await pexec(
      'gh',
      ['pr', 'view', '--json', 'number,baseRefName,headRefName,author'],
      { cwd: git.cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    const j = JSON.parse(stdout);
    if (!j || typeof j.number !== 'number') return undefined;
    return {
      number: j.number,
      baseRefName: j.baseRefName,
      headRefName: j.headRefName,
      authorLogin: j.author?.login,
    };
  } catch {
    return undefined;
  }
}

async function loadCodeowners(repoRoot: string): Promise<{ found: boolean; rules: ReturnType<typeof parseCodeownersBody> }> {
  const candidates = [
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS',
  ];
  for (const rel of candidates) {
    const abs = path.join(repoRoot, rel);
    try {
      const body = await fs.readFile(abs, 'utf8');
      return { found: true, rules: parseCodeownersBody(body) };
    } catch {}
  }
  return { found: false, rules: [] };
}

async function loadAuthor(git: Git, prAuthorLogin: string | undefined): Promise<AuthorIdentity> {
  const email = (await safe(git, ['config', '--get', 'user.email'])).trim();
  const name = (await safe(git, ['config', '--get', 'user.name'])).trim();
  return {
    email,
    name,
    handle: prAuthorLogin || undefined,
  };
}

async function ghAvailable(): Promise<boolean> {
  try {
    await pexec('gh', ['--version'], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

/**
 * F85 — Load the recent reviewer-request window for round-robin re-ranking.
 *
 * Asks gh for the last `windowSize` PRs on the current repo (any state),
 * each with their `reviewRequests` + `latestReviews` arrays. We then count
 * unique-per-PR appearances per handle. Same handle in `reviewRequests`
 * AND `latestReviews` of the same PR counts as ONE — we're measuring how
 * many PRs touched them, not how many request events there were.
 *
 * Silently returns an empty map when gh is missing, the call fails, or
 * the repo isn't a GitHub remote — the picker falls back to plain coverage
 * ranking in that case.
 */
async function loadRecentReviewerLoad(git: Git, windowSize: number): Promise<Map<string, number>> {
  if (!(await ghAvailable())) return new Map();
  try {
    const { stdout } = await pexec(
      'gh',
      [
        'pr', 'list',
        '--state', 'all',
        '--limit', String(windowSize),
        '--json', 'reviewRequests,latestReviews',
      ],
      { cwd: git.cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as GhPrLoadEntry[];
    return countReviewerLoad(parsed);
  } catch {
    return new Map();
  }
}
