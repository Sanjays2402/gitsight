/**
 * F124 - Reviewer Load Balancer report.
 *
 * New command (`gitsight.reviewerLoadReport`) that runs the three gh
 * round-trips needed to compute each known-handle's load profile, then
 * shows a picker + opens a markdown report.
 *
 * Where does the "known-handle" set come from?
 *   - Default: CODEOWNERS rules in the workspace + the F91 shortlog
 *     handles for the most-recently-touched paths. If no CODEOWNERS is
 *     present, fall back to the recent committer set on `<base>..HEAD`.
 *   - Override: gitsight.reviewerLoadBalancer.handles (string array).
 *
 * This is the FYI surface. The actual re-ranking that affects the
 * picker order lives in src/git/reviewerLoadBalancer.ts and is
 * composed into the F57 default-reviewers picker in a separate
 * (out-of-scope-for-this-tick) integration.
 *
 * Hard requirements:
 *   - gh CLI on PATH (warns + bails otherwise)
 *   - GitHub repo origin (silently skipped otherwise)
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parseGitHubRepo } from '../git/forcePushGuard';
import { parseCodeownersBody } from '../git/filesIOwn';
import { normaliseOwner } from '../git/defaultReviewers';
import {
  parsePendingFromGhJson,
  parseAckLatencySamples,
  parseThroughputCounts,
  buildReviewerLoadStats,
  scoreReviewerLoad,
  describeLoadStats,
  classifyVerdict,
  buildLoadReport,
  ReviewerLoadStats,
  ReviewerLoadScore,
  LoadVerdict,
} from '../git/reviewerLoadBalancer';

const pexec = promisify(execFile);

export async function showReviewerLoadReport(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot compute reviewer load.');
    return;
  }
  const repo = await resolveGitHubRepo(git);
  if (!repo) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub remote - reviewer load only applies to GitHub.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.reviewerLoadBalancer');
  const lookbackDays = Math.max(7, Math.min(180, cfg.get<number>('lookbackDays', 30)));
  const configHandles = cfg.get<string[]>('handles', []) ?? [];

  const handles = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'GitSight: gathering reviewer handles\u2026' },
    async () => configHandles.length > 0 ? configHandles : await defaultHandles(git),
  );
  if (!handles.length) {
    vscode.window.showInformationMessage('GitSight: no reviewer handles detected. Set `gitsight.reviewerLoadBalancer.handles` to track specific reviewers.');
    return;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: scoring ${handles.length} reviewer${handles.length === 1 ? '' : 's'}\u2026`,
      cancellable: true,
    },
    async (progress, token) => {
      const pendingByHandle = new Map<string, number>();
      let done = 0;
      for (const raw of handles) {
        if (token.isCancellationRequested) break;
        const handle = raw.toLowerCase().replace(/^@/, '');
        progress.report({ message: `@${handle} (${++done}/${handles.length})`, increment: 100 / (handles.length * 2) });
        pendingByHandle.set(handle, await fetchPending(repo.owner, repo.repo, handle));
      }

      // Throughput + latency: one big query rather than per-handle to save
      // gh round-trips. We pull the last 200 merged PRs in the lookback
      // window and dedup author handles inside.
      progress.report({ message: 'gathering recent merged PRs\u2026', increment: 30 });
      const since = isoDateNDaysAgo(lookbackDays);
      const throughputRaw = await fetchMergedReviews(repo.owner, repo.repo, since);
      const ackSamples = parseAckLatencySamples({ raw: throughputRaw, handles: new Set(handles.map(h => h.toLowerCase().replace(/^@/, ''))) });
      const throughputByHandle = parseThroughputCounts(throughputRaw);
      // Intersect with our known set so unrelated reviewers don't show up.
      const handleSet = new Set(handles.map(h => h.toLowerCase().replace(/^@/, '')));
      for (const k of [...throughputByHandle.keys()]) {
        if (!handleSet.has(k)) throughputByHandle.delete(k);
      }
      const stats = buildReviewerLoadStats({ handles, pendingByHandle, ackSamplesByHandle: ackSamples, throughputByHandle });
      const scores = new Map<string, ReviewerLoadScore>();
      for (const s of stats) scores.set(s.handle, scoreReviewerLoad(s));
      return { stats, scores };
    },
  );
  if (!result) return;

  await renderPicker(repo, lookbackDays, result.stats, result.scores);
}

interface RepoSlug { owner: string; repo: string; }

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

async function resolveGitHubRepo(git: Git): Promise<RepoSlug | undefined> {
  try {
    const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
    return parseGitHubRepo(url);
  } catch { return undefined; }
}

async function fetchPending(owner: string, repo: string, handle: string): Promise<number> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'list',
      '--repo', `${owner}/${repo}`,
      '--search', `review-requested:${handle} state:open`,
      '--json', 'number,url,createdAt',
      '--limit', '50',
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    return parsePendingFromGhJson(stdout);
  } catch {
    return 0;
  }
}

async function fetchMergedReviews(owner: string, repo: string, sinceIso: string): Promise<string> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'list',
      '--repo', `${owner}/${repo}`,
      '--state', 'merged',
      '--search', `merged:>=${sinceIso}`,
      '--json', 'number,createdAt,reviews',
      '--limit', '200',
    ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

function isoDateNDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function defaultHandles(git: Git): Promise<string[]> {
  const handles = new Set<string>();
  // 1) Pull handles from CODEOWNERS if present.
  try {
    const repoRoot = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    if (repoRoot) {
      const fs = await import('fs/promises');
      const path = await import('path');
      const candidates = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
      for (const c of candidates) {
        try {
          const body = await fs.readFile(path.join(repoRoot, c), 'utf8');
          const rules = parseCodeownersBody(body);
          for (const r of rules) {
            for (const o of r.owners) {
              const norm = normaliseOwner(o);
              if ((norm.kind === 'user' || norm.kind === 'team') && norm.handle) {
                handles.add(norm.handle.toLowerCase());
              }
            }
          }
          break;
        } catch { /* try next */ }
      }
    }
  } catch { /* ignore */ }
  // 2) If still empty, pull recent committers as a fallback.
  if (handles.size === 0) {
    try {
      const out = await git.raw(['shortlog', '-sne', '--no-merges', '-n', 'HEAD~200..HEAD']);
      for (const line of out.split('\n').map(s => s.trim()).filter(Boolean)) {
        const m = /^\d+\s+([^<]+)<([^>]+)>/.exec(line);
        if (!m) continue;
        const email = m[2].trim().toLowerCase();
        if (!email) continue;
        const local = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
        // Skip noreply / bot suffixes; we still want users with normal email-local-parts as a best guess.
        if (/\bbot\b|noreply|\[bot\]|dependabot|renovate|github-actions/.test(local) || /\bbot\b|noreply|\[bot\]|dependabot|renovate|github-actions/.test(email)) continue;
        // GitHub noreply format: 12345+username@users.noreply.github.com -> username
        const noreply = /^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
        if (noreply) handles.add(noreply[2].toLowerCase());
        else handles.add(local);
      }
    } catch { /* ignore */ }
  }
  return [...handles].slice(0, 30);
}

async function renderPicker(
  repo: RepoSlug,
  lookbackDays: number,
  stats: ReviewerLoadStats[],
  scores: Map<string, ReviewerLoadScore>,
): Promise<void> {
  type Pk = vscode.QuickPickItem & { _stats?: ReviewerLoadStats; _action?: 'open-report'; };
  const items: Pk[] = [];
  items.push({ label: `Reviewer load - ${stats.length} reviewer${stats.length === 1 ? '' : 's'} - last ${lookbackDays}d`, kind: vscode.QuickPickItemKind.Separator } as any);

  const sorted = [...stats].sort((a, b) => {
    const sa = scores.get(a.handle)?.score ?? Number.POSITIVE_INFINITY;
    const sb = scores.get(b.handle)?.score ?? Number.POSITIVE_INFINITY;
    return sa - sb;
  });
  for (const s of sorted) {
    const score = scores.get(s.handle) ?? scoreReviewerLoad(s);
    const verdict = classifyVerdict(s, score);
    items.push({
      label: `$(${glyphFor(verdict)}) @${s.handle}`,
      description: describeLoadStats(s, score),
      detail: detailFor(verdict),
      _stats: s,
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(notebook) Open full report', _action: 'open-report' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Reviewer load (${repo.owner}/${repo.repo})`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked._action === 'open-report') {
    const doc = await vscode.workspace.openTextDocument({
      content: buildLoadReport({ stats, scores, lookbackDays }),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    return;
  }
  if (picked._stats) {
    const handle = picked._stats.handle;
    const sub = await vscode.window.showQuickPick([
      { label: '$(link-external) Open assigned reviews on GitHub' },
      { label: '$(copy) Copy handle' },
    ], { placeHolder: `@${handle}` });
    if (!sub) return;
    if (sub.label.includes('Open assigned reviews')) {
      const url = `https://github.com/${repo.owner}/${repo.repo}/pulls?q=is%3Apr+is%3Aopen+review-requested%3A${encodeURIComponent(handle)}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (sub.label.includes('Copy handle')) {
      await vscode.env.clipboard.writeText(`@${handle}`);
      vscode.window.setStatusBarMessage(`Copied @${handle}`, 2000);
    }
  }
}

function glyphFor(verdict: LoadVerdict): string {
  switch (verdict) {
    case 'fast': return 'rocket';
    case 'busy': return 'flame';
    case 'slow': return 'watch';
    case 'neutral': return 'circle-outline';
    case 'unknown': return 'question';
  }
}

function detailFor(verdict: LoadVerdict): string | undefined {
  switch (verdict) {
    case 'fast': return 'ships reviews faster than they pile up';
    case 'busy': return 'lots of queued requests, may slow next round';
    case 'slow': return 'median acknowledgement is 2+ days';
    case 'neutral': return undefined;
    case 'unknown': return 'no recent activity in the lookback window';
  }
}
