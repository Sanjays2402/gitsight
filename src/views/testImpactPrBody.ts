/**
 * F125 - Test-Impact -> PR body sync.
 *
 * New command (`gitsight.injectTestImpactIntoPr`) that:
 *   1. Computes the F122 test-impact summary for the current branch.
 *   2. Finds the open PR for the branch via `gh pr view --json`.
 *   3. Builds the managed `<!-- GITSIGHT:TEST-IMPACT -->` block.
 *   4. Shows a preview + confirm picker so the user sees what will land.
 *   5. Writes via `gh pr edit --body-file -`.
 *
 * Pairs with F77 (PR draft sync) - both use the same marker-bracketed
 * managed-block pattern. They don't collide because their markers differ
 * (PR-DRAFT-SYNC vs TEST-IMPACT).
 *
 * Hard requirements:
 *   - gh CLI on PATH
 *   - GitHub repo origin
 *   - An open PR for the current branch (any state: open / draft / converted)
 *
 * Why not fire-and-forget like F77? Different shape: F77 is a draft-only
 * convenience that runs on every push; F125 is a one-shot explicit
 * action because the test-impact scan is moderately expensive (one
 * `git grep` per source file + per-source filesystem stat) and the
 * user usually only wants to inject it once when opening the PR.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parseGitHubRepo } from '../git/forcePushGuard';
import { computeTestImpactSummary } from './testImpact';
import {
  buildTestImpactBlock,
  injectTestImpactBlock,
  stripTestImpactBlock,
  classifyTestImpactSync,
  hasTestImpactBlock,
  classifyAutoSync,
  TestImpactSyncDecision,
  TestImpactAutoSyncOutcome,
  TEST_IMPACT_OPEN_MARKER,
} from '../git/testImpactPrBody';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const pexec = promisify(execFile);

export async function injectTestImpactIntoPr(repos: RepoManager): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot edit PR body.');
    return;
  }
  const repo = await resolveGitHubRepo(git);
  if (!repo) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub remote.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('gitsight.testImpactPrBody');
  const maxRows = clamp(cfg.get<number>('maxRows', 12), 1, 50);
  const maxOrphans = clamp(cfg.get<number>('maxOrphans', 10), 0, 100);
  const includeOrphans = cfg.get<boolean>('includeOrphans', true);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'GitSight: computing test impact for PR body\u2026',
      cancellable: true,
    },
    async (_progress, token) => {
      const summary = await computeTestImpactSummary(git, token);
      if (!summary) return undefined;
      const pr = await findOpenPrForBranch(git, repo);
      if (!pr) return { summary, pr: undefined };
      return { summary, pr };
    },
  );

  if (!result) {
    vscode.window.showInformationMessage('GitSight: could not determine PR range.');
    return;
  }
  if (!result.pr) {
    vscode.window.showInformationMessage('GitSight: no open PR for the current branch. Open or push a PR first.');
    return;
  }

  const block = buildTestImpactBlock({
    summary: result.summary,
    syncedAt: formatLocalTime(new Date()),
    maxRows,
    maxOrphans,
    includeOrphans,
  });
  const decision = classifyTestImpactSync(result.pr.body, block);

  if (decision === 'no-change') {
    vscode.window.showInformationMessage(
      `GitSight: PR #${result.pr.number} already has an up-to-date test-impact block.`,
    );
    return;
  }

  const choice = await showConfirmPicker(result.pr, block, decision);
  if (!choice) return;
  if (choice === 'remove') {
    const stripped = stripTestImpactBlock(result.pr.body);
    await applyPrEdit(repo, result.pr.number, stripped, 'removed');
    return;
  }
  if (choice === 'preview') {
    const next = injectTestImpactBlock(result.pr.body, block);
    await openPreview(next, decision);
    return;
  }
  if (choice === 'copy') {
    await vscode.env.clipboard.writeText(block);
    vscode.window.setStatusBarMessage('GitSight: copied test-impact block to clipboard', 3000);
    return;
  }
  // 'apply'
  const next = injectTestImpactBlock(result.pr.body, block);
  await applyPrEdit(repo, result.pr.number, next, decision);
}

interface RepoSlug { owner: string; repo: string; }
interface OpenPr { number: number; url: string; body: string; isDraft: boolean; headRefName: string; }

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

async function findOpenPrForBranch(git: Git, repo: RepoSlug): Promise<OpenPr | undefined> {
  let head: string;
  try {
    head = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch { return undefined; }
  if (!head || head === 'HEAD') return undefined;
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view', head,
      '--repo', `${repo.owner}/${repo.repo}`,
      '--json', 'number,url,body,isDraft,headRefName',
    ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const obj = JSON.parse(stdout);
    if (!obj || typeof obj.number !== 'number') return undefined;
    return {
      number: obj.number,
      url: String(obj.url ?? ''),
      body: String(obj.body ?? ''),
      isDraft: !!obj.isDraft,
      headRefName: String(obj.headRefName ?? ''),
    };
  } catch {
    return undefined;
  }
}

async function showConfirmPicker(
  pr: OpenPr,
  block: string,
  decision: TestImpactSyncDecision,
): Promise<'apply' | 'preview' | 'copy' | 'remove' | undefined> {
  type Action = 'apply' | 'preview' | 'copy' | 'remove';
  type Pk = vscode.QuickPickItem & { _action: Action };
  const headline = decision === 'insert'
    ? `Inject test-impact block into PR #${pr.number}?`
    : `Refresh test-impact block in PR #${pr.number}?`;
  const blockLines = block.split('\n').length;
  const items: Pk[] = [
    { label: `$(check) ${decision === 'insert' ? 'Insert' : 'Refresh'} block now`, description: `${blockLines} lines into PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}`, _action: 'apply' },
    { label: '$(eye) Preview the new PR body', description: 'open the full proposed body before applying', _action: 'preview' },
    { label: '$(copy) Copy block to clipboard', description: 'paste into the PR description yourself', _action: 'copy' },
  ];
  // Only offer remove when there's actually a block to remove.
  if (decision === 'replace') {
    items.push({ label: '$(trash) Remove managed block from PR body', description: 'opt-out of auto-sync for this PR', _action: 'remove' });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: headline,
    matchOnDescription: true,
  });
  return picked?._action;
}

async function openPreview(body: string, decision: TestImpactSyncDecision): Promise<void> {
  const header = `<!-- GitSight: previewed PR body (decision: ${decision}). The block below is what gh pr edit would receive. -->`;
  const doc = await vscode.workspace.openTextDocument({
    content: `${header}\n\n${body}`,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function applyPrEdit(repo: RepoSlug, prNumber: number, body: string, decision: TestImpactSyncDecision | 'removed'): Promise<void> {
  const tmp = path.join(os.tmpdir(), `gitsight-testimpact-${process.pid}-${Date.now()}.md`);
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await pexec('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', `${repo.owner}/${repo.repo}`,
      '--body-file', tmp,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const verb = decision === 'insert' ? 'injected'
              : decision === 'replace' ? 'refreshed'
              : decision === 'removed' ? 'removed'
              : 'updated';
    vscode.window.setStatusBarMessage(`GitSight: ${verb} test-impact block in PR #${prNumber}`, 4000);
  } catch (e: any) {
    vscode.window.showErrorMessage(`GitSight: gh pr edit failed: ${(e?.message ?? String(e)).split('\n')[0]}`);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

function formatLocalTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// Re-export for testing convenience.
export { TEST_IMPACT_OPEN_MARKER };

/**
 * F129 - Test-Impact -> PR body auto-sync.
 *
 * After `gitsight.push`, if the just-pushed branch has an open PR on
 * GitHub AND its body already contains the F125 managed block, refresh
 * the block to reflect the new tip. Fire-and-forget so a transient gh
 * failure never blocks the push.
 *
 * The "already has the block" gate is intentional: this is an opt-in
 * surface. The user expressed intent the first time they ran F125 +
 * picked "Insert"; afterwards they expect the block to stay current
 * without an extra command. Branches WITHOUT the block stay untouched
 * (the user can run F125 manually when they're ready).
 *
 * Returns a structured outcome (rather than throwing) so the status
 * bar can render ONE concise line per push. Errors are demoted to
 * 'failed' with a short reason.
 */
export interface AutoSyncResult {
  outcome: TestImpactAutoSyncOutcome;
  prNumber?: number;
  reason?: string;
  /** F134: structured delta when the rewrite refreshed an existing block. */
  diffHeadline?: string;
  /** F134: full delta object when caller needs deeper inspection. */
  diff?: import('../git/testImpactPrBodyDelta').TestImpactDiff;
}

export async function runTestImpactAutoSync(repos: RepoManager, branch?: string): Promise<AutoSyncResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.testImpactPrBody');
  const enabled = cfg.get<boolean>('autoSync', true);
  if (!enabled) return { outcome: 'skipped', reason: 'auto-sync disabled' };

  const git = repos.primary();
  if (!git) return { outcome: 'skipped', reason: 'no git repo' };
  if (!(await ghAvailable())) return { outcome: 'skipped', reason: 'gh CLI missing' };
  const repo = await resolveGitHubRepo(git);
  if (!repo) return { outcome: 'skipped', reason: 'non-GitHub remote' };

  // Bail FAST if there's no PR or no block yet - both are cheap probes
  // that don't require a full test-impact scan.
  let head = (branch ?? '').trim();
  if (!head) {
    try { head = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* ignore */ }
  }
  if (!head || head === 'HEAD') return { outcome: 'skipped', reason: 'detached HEAD' };

  const pr = await findOpenPrForBranchOpportunistic(repo, head);
  if (!pr) return { outcome: 'no-pr' };
  if (!hasTestImpactBlock(pr.body)) return { outcome: 'no-block', prNumber: pr.number };

  // The block is here - compute the fresh impact only NOW.
  const maxRows = clamp(cfg.get<number>('maxRows', 12), 1, 50);
  const maxOrphans = clamp(cfg.get<number>('maxOrphans', 10), 0, 100);
  const includeOrphans = cfg.get<boolean>('includeOrphans', true);

  let summary;
  try {
    summary = await computeTestImpactSummary(git);
  } catch (e: any) {
    return { outcome: 'failed', prNumber: pr.number, reason: `scan failed (${shortError(e)})` };
  }
  if (!summary) return { outcome: 'no-pr', prNumber: pr.number, reason: 'could not determine PR range' };

  const block = buildTestImpactBlock({
    summary,
    syncedAt: formatLocalTime(new Date()),
    maxRows,
    maxOrphans,
    includeOrphans,
  });
  const verdict = classifyAutoSync({ currentBody: pr.body, freshBlock: block, enabled: true });
  if (verdict.outcome === 'no-change') return { outcome: 'no-change', prNumber: pr.number };
  if (verdict.outcome !== 'refreshed') return { outcome: verdict.outcome, prNumber: pr.number, reason: verdict.reason };

  // F134 - compute structured delta BEFORE we write so the status bar
  // can render "+2 tests, -1 stale" instead of just "refreshed".
  let diff: import('../git/testImpactPrBodyDelta').TestImpactDiff | undefined;
  let diffHeadline: string | undefined;
  try {
    const oldOpen = pr.body.indexOf(TEST_IMPACT_OPEN_MARKER);
    const oldClose = pr.body.indexOf('<!-- /GITSIGHT:TEST-IMPACT -->');
    if (oldOpen >= 0 && oldClose > oldOpen) {
      const oldBlock = pr.body.slice(oldOpen, oldClose + '<!-- /GITSIGHT:TEST-IMPACT -->'.length);
      const { diffTestImpactBlocks, summariseDiffHeadline } = await import('../git/testImpactPrBodyDelta');
      diff = diffTestImpactBlocks(oldBlock, block);
      diffHeadline = summariseDiffHeadline(diff);
    }
  } catch { /* delta is a bonus, never block the sync */ }

  const next = injectTestImpactBlock(pr.body, block);
  try {
    await editPrBodyForSync(repo, pr.number, next);
    // F134 - optional per-push delta comment.
    await maybePostDeltaComment(repo, pr.number, diff);
    return { outcome: 'refreshed', prNumber: pr.number, diffHeadline, diff };
  } catch (e: any) {
    return { outcome: 'failed', prNumber: pr.number, reason: shortError(e) };
  }
}

/**
 * F134 - opportunistic delta comment. Gated by:
 *   - gitsight.testImpactPrBody.postDeltaComment (default false)
 *   - shouldPostDeltaComment verdict (structural change or
 *     big rescore)
 *
 * Fire-and-forget - never throws. Returns silently when not configured.
 */
async function maybePostDeltaComment(
  repo: RepoSlug,
  prNumber: number,
  diff: import('../git/testImpactPrBodyDelta').TestImpactDiff | undefined,
): Promise<void> {
  if (!diff) return;
  const cfg = vscode.workspace.getConfiguration('gitsight.testImpactPrBody');
  if (!cfg.get<boolean>('postDeltaComment', false)) return;
  const threshold = cfg.get<number>('deltaCommentRescoreThreshold', 10);
  try {
    const { shouldPostDeltaComment, buildDeltaCommentBody } = await import('../git/testImpactPrBodyDelta');
    if (shouldPostDeltaComment({ diff, rescoreThreshold: threshold }) !== 'post') return;
    const body = buildDeltaCommentBody({ diff });
    if (!body || !body.trim()) return;
    const tmp = path.join(os.tmpdir(), `gitsight-test-impact-delta-${prNumber}.md`);
    await fs.writeFile(tmp, body, 'utf8');
    try {
      await pexec('gh', [
        'pr', 'comment', String(prNumber),
        '--repo', `${repo.owner}/${repo.repo}`,
        '--body-file', tmp,
      ], { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
    } finally {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
    }
  } catch { /* comment is a bonus, sync already wrote the body */ }
}

/**
 * Fire-and-forget wrapper. Surfaces one quiet status-bar line on
 * success, a short warning on failure, and stays silent otherwise.
 * Never throws - the underlying push already succeeded.
 */
export function runTestImpactAutoSyncFireAndForget(repos: RepoManager, branch?: string): void {
  void (async () => {
    try {
      const r = await runTestImpactAutoSync(repos, branch);
      switch (r.outcome) {
        case 'refreshed':
          vscode.window.setStatusBarMessage(
            r.diffHeadline && r.diffHeadline !== 'no change'
              ? `GitSight: refreshed test-impact in PR #${r.prNumber} (${r.diffHeadline})`
              : `GitSight: refreshed test-impact in PR #${r.prNumber}`,
            4000,
          );
          break;
        case 'failed':
          vscode.window.setStatusBarMessage(
            `GitSight: test-impact sync failed (${truncate(r.reason ?? 'unknown', 60)})`,
            5000,
          );
          break;
        // no-pr / no-block / no-change / skipped are quiet - the user
        // either hasn't opted in (no block) or there's literally nothing
        // to do.
        default:
          break;
      }
    } catch {
      // Never surface as a modal - the push succeeded.
    }
  })();
}

async function findOpenPrForBranchOpportunistic(repo: RepoSlug, head: string): Promise<OpenPr | undefined> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view', head,
      '--repo', `${repo.owner}/${repo.repo}`,
      '--json', 'number,url,body,isDraft,headRefName',
    ], { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
    const obj = JSON.parse(stdout);
    if (!obj || typeof obj.number !== 'number') return undefined;
    return {
      number: obj.number,
      url: String(obj.url ?? ''),
      body: String(obj.body ?? ''),
      isDraft: !!obj.isDraft,
      headRefName: String(obj.headRefName ?? ''),
    };
  } catch {
    return undefined;
  }
}

async function editPrBodyForSync(repo: RepoSlug, prNumber: number, body: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `gitsight-testimpact-autosync-${process.pid}-${Date.now()}.md`);
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await pexec('gh', [
      'pr', 'edit', String(prNumber),
      '--repo', `${repo.owner}/${repo.repo}`,
      '--body-file', tmp,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

function shortError(e: any): string {
  const msg = (e?.message ?? e?.stderr ?? String(e)).toString().split('\n')[0];
  return truncate(msg, 80);
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}\u2026`;
}
