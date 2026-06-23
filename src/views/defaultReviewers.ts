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
import { parseCodeownersBody, parseShortlog } from '../git/filesIOwn';
import {
  buildReviewerSuggestions,
  describeSuggestion,
  describeSuggestionDetail,
  describeSuggestionWithLoad,
  describeSuggestionWithLoadScore,
  buildGhAddReviewerArgs,
  parseChangedPaths,
  composeReviewerRanking,
  countReviewerLoad,
  GhPrLoadEntry,
  LoadScoreEntry,
  ReviewerSuggestion,
  AuthorIdentity,
} from '../git/defaultReviewers';
import { buildFromShortlog, classifySelfReview, buildSelfReviewHint } from '../git/reviewersFromShortlog';
import {
  parsePendingFromGhJson,
  parseAckLatencySamples,
  parseThroughputCounts,
  buildReviewerLoadStats,
  scoreReviewerLoad,
} from '../git/reviewerLoadBalancer';

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

  // 3. CODEOWNERS — primary signal. When absent, fall back to F91 shortlog.
  const owners = await loadCodeowners(git.cwd);

  // 4. Author identity for exclusion.
  const author = await loadAuthor(git, prInfo?.authorLogin);

  // 5. Build suggestions.
  let suggestions: ReviewerSuggestion[];
  let suggestionsSource: 'codeowners' | 'shortlog' = 'codeowners';
  // F96 keeps the shortlog around so we can classify WHY an empty result
  // happened (self-dominant / bot-only / no-history / degraded) and
  // surface a useful next-step hint.
  let shortlogForVerdict: import('../git/filesIOwn').ShortlogEntry[] | undefined;
  if (owners.found) {
    suggestions = buildReviewerSuggestions({
      rules: owners.rules,
      changedPaths: changed,
      author,
      extraExcluded,
      includeTeams,
    });
  } else {
    // F91 fallback: top committers across the changed file set.
    suggestionsSource = 'shortlog';
    const fallbackEnabled = cfg.get<boolean>('shortlogFallback', true);
    if (!fallbackEnabled) {
      vscode.window.showInformationMessage(
        'GitSight: no CODEOWNERS file in this repo. Add one to .github/CODEOWNERS to enable reviewer suggestions, or enable `gitsight.defaultReviewers.shortlogFallback`.',
      );
      return;
    }
    const fallbackDays = Math.max(7, cfg.get<number>('shortlogFallbackDays', 180) ?? 180);
    const perTier = Math.max(1, cfg.get<number>('shortlogPerTier', 5) ?? 5);
    shortlogForVerdict = await loadShortlog(git, fallbackDays, changed);
    suggestions = buildFromShortlog({
      shortlog: shortlogForVerdict,
      changedPaths: changed,
      author,
      extraExcluded,
      perTierLimit: perTier,
    });
  }

  if (!suggestions.length) {
    // F96: when the picker drained itself, classify WHY and offer a
    // next-step suggestion rather than a bare "no suggestions" toast.
    if (suggestionsSource === 'shortlog' && shortlogForVerdict) {
      const verdict = classifySelfReview({
        suggestions,
        shortlog: shortlogForVerdict,
        changedPaths: changed,
        author,
      });
      if (verdict !== 'ok') {
        const hint = buildSelfReviewHint(verdict, changed.length);
        const offerFilesIOwn = hint.suggestedCommand === 'gitsight.filesIOwn';
        const action = await vscode.window.showInformationMessage(
          `GitSight: ${hint.summary}`,
          { modal: false, detail: hint.detail },
          ...(offerFilesIOwn ? ['Open Files I Own', 'Dismiss'] : ['Dismiss']),
        );
        if (action === 'Open Files I Own') {
          await vscode.commands.executeCommand('gitsight.filesIOwn');
        }
        return;
      }
    }
    const reason = suggestionsSource === 'codeowners'
      ? `no CODEOWNERS rule applies to the ${changed.length} changed file(s) (or only the author owns them)`
      : `no recent committers found in the last 180d for the ${changed.length} changed file(s)`;
    vscode.window.showInformationMessage(`GitSight: ${reason}.`);
    return;
  }

  // 5b. Compose ranking. F128: prefer load-score (F124 composite — queue,
  // throughput, ack latency) when available, fall back to F85 round-robin
  // open-request count, fall back again to plain coverage. The two gh
  // round-trips are issued in parallel (and skipped when their config flag
  // is off) so the picker still feels snappy.
  const loadBalancerEnabled = roundRobin && cfg.get<boolean>('loadBalancer', true);
  const lbCfg = vscode.workspace.getConfiguration('gitsight.reviewerLoadBalancer');
  const lookbackDays = clampInt(lbCfg.get<number>('lookbackDays', 30), 7, 180);

  const [loadByHandle, scoresByHandle] = await Promise.all([
    roundRobin ? loadRecentReviewerLoad(git, roundRobinWindow) : Promise.resolve(new Map<string, number>()),
    loadBalancerEnabled ? loadReviewerScores(git, suggestions, lookbackDays) : Promise.resolve(new Map<string, LoadScoreEntry>()),
  ]);

  const composition = composeReviewerRanking({
    suggestions,
    loadByHandle: roundRobin ? loadByHandle : undefined,
    scoresByHandle: loadBalancerEnabled ? scoresByHandle : undefined,
  });
  const ranked = composition.ranked;

  // 6. Picker.
  const items: Pk[] = ranked.map(s => ({
    label: `${s.kind === 'team' ? '$(organization) ' : '$(account) '}${s.displayHandle}`,
    description:
      composition.source === 'load-score'
        ? describeSuggestionWithLoadScore(s, changed.length, scoresByHandle)
        : composition.source === 'round-robin'
          ? describeSuggestionWithLoad(s, changed.length, loadByHandle)
          : describeSuggestion(s, changed.length),
    detail: describeSuggestionDetail(s),
    picked: true,
    _suggestion: s,
  }));

  const title = prInfo
    ? `Suggest reviewers for PR #${prInfo.number} (${changed.length} file${changed.length === 1 ? '' : 's'} changed)`
    : `Suggest reviewers (${changed.length} file${changed.length === 1 ? '' : 's'} changed)`;

  const sourceWord = suggestionsSource === 'codeowners' ? 'CODEOWNERS' : 'recent committers (no CODEOWNERS)';
  const rankWord = composition.source === 'load-score'
    ? 'load-balanced'
    : composition.source === 'round-robin'
      ? 'round-robin'
      : 'coverage';
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title,
    placeHolder: `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} from ${sourceWord} \u00b7 ranked by ${rankWord} \u00b7 base=${base}`,
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

/**
 * F91 — Load the per-file shortlog over the last N days, restricted to
 * the file set that the PR actually changed. Restricting at the git-log
 * layer keeps the call cheap on monorepos — without `-- <paths>` we'd
 * pull every author of every file in the repo.
 */
async function loadShortlog(git: Git, days: number, paths: string[]): Promise<ReturnType<typeof parseShortlog>> {
  if (!paths.length) return [];
  const args = [
    'log',
    `--since=${days}.days`,
    '--no-merges',
    `--pretty=format:%aE|%aN`,
    '--name-only',
    '--',
    ...paths,
  ];
  const out = await safe(git, args);
  return parseShortlog(out);
}

/**
 * F128 - Fetch per-handle load scores for the current suggestion set.
 *
 * Mirrors the F124 reviewer-load-report fetch logic, but scoped to the
 * suggestion set so we only do work for handles the picker is about to
 * show. Falls back to an empty map (which the composition treats as
 * "no scores") on any failure - gh missing, network hiccup, non-GitHub
 * remote. The picker silently degrades to F85 round-robin in those cases.
 *
 * Bounded by a 12-second timeout so an unresponsive gh doesn't make the
 * picker feel stuck; the worst case is reverting to round-robin.
 */
async function loadReviewerScores(
  git: Git,
  suggestions: ReviewerSuggestion[],
  lookbackDays: number,
): Promise<Map<string, LoadScoreEntry>> {
  const out = new Map<string, LoadScoreEntry>();
  if (!suggestions.length) return out;
  if (!(await ghAvailable())) return out;

  // We only score USER handles - team handles have no review queue of
  // their own (the underlying users do). Teams stay in the picker but
  // sort by tier + alphabetical when scores are partial.
  const userHandles = suggestions
    .filter(s => s.kind === 'user')
    .map(s => s.handle.toLowerCase().replace(/^@/, ''));
  if (!userHandles.length) return out;

  const handleSet = new Set(userHandles);
  const repoUrl = await safe(git, ['config', '--get', 'remote.origin.url']);
  const slug = extractGitHubSlug(repoUrl);

  try {
    const pendingByHandle = new Map<string, number>();
    // Fan-out for pending requests (cheap one-call-per-handle search).
    // Bounded by Promise.all with a 12s outer race so a slow gh doesn't
    // hold the picker.
    const pendingPromise = (async () => {
      for (const handle of userHandles) {
        pendingByHandle.set(handle, await fetchPendingRequests(handle, slug));
      }
      return pendingByHandle;
    })();
    const since = isoDateNDaysAgo(lookbackDays);
    const reviewsRaw = await raceWithTimeout(
      fetchMergedReviewsForScoring(slug, since),
      12_000,
      '',
    );
    await raceWithTimeout(pendingPromise, 12_000, pendingByHandle);

    const ackSamples = parseAckLatencySamples({ raw: reviewsRaw, handles: handleSet });
    const throughputAll = parseThroughputCounts(reviewsRaw);
    const throughputByHandle = new Map<string, number>();
    for (const [k, v] of throughputAll) {
      if (handleSet.has(k)) throughputByHandle.set(k, v);
    }
    const stats = buildReviewerLoadStats({
      handles: userHandles,
      pendingByHandle,
      ackSamplesByHandle: ackSamples,
      throughputByHandle,
    });
    for (const s of stats) {
      const score = scoreReviewerLoad(s);
      out.set(s.handle, { handle: s.handle, score: score.score });
    }
  } catch {
    // Swallow - the picker has a safe fallback.
  }
  return out;
}

async function fetchPendingRequests(handle: string, slug: { owner: string; repo: string } | undefined): Promise<number> {
  try {
    const args = [
      'pr', 'list',
      '--search', `review-requested:${handle} state:open`,
      '--json', 'number,url',
      '--limit', '50',
    ];
    if (slug) args.splice(2, 0, '--repo', `${slug.owner}/${slug.repo}`);
    const { stdout } = await pexec('gh', args, { timeout: 8000, maxBuffer: 1024 * 1024 });
    return parsePendingFromGhJson(stdout);
  } catch {
    return 0;
  }
}

async function fetchMergedReviewsForScoring(slug: { owner: string; repo: string } | undefined, sinceIso: string): Promise<string> {
  try {
    const args = [
      'pr', 'list',
      '--state', 'merged',
      '--search', `merged:>=${sinceIso}`,
      '--json', 'number,createdAt,reviews',
      '--limit', '150',
    ];
    if (slug) args.splice(2, 0, '--repo', `${slug.owner}/${slug.repo}`);
    const { stdout } = await pexec('gh', args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

function isoDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function extractGitHubSlug(url: string): { owner: string; repo: string } | undefined {
  if (!url) return undefined;
  // Match common github URL shapes; same heuristic the rest of the codebase uses.
  const trimmed = url.trim();
  const m =
    /github\.com[:/]([\w.\-]+)\/([\w.\-]+?)(?:\.git)?$/i.exec(trimmed) ||
    /^https?:\/\/github\.com\/([\w.\-]+)\/([\w.\-]+?)(?:\.git)?$/i.exec(trimmed);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

async function raceWithTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return await Promise.race([
    promise.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}
