/**
 * F138 - Pre-merge readiness checklist.
 *
 * New command (`gitsight.preMergeChecklist`) that runs five gates
 * against an open PR before the user runs `gh pr merge`:
 *
 *   1. Conflict freshness (mergeable / mergeStateStatus)
 *   2. Required status checks (mergeStateStatus + failing count)
 *   3. Review approvals (reviewDecision + approval count)
 *   4. Base divergence (comparing PR base..HEAD)
 *   5. Test-impact block sync (F125 marker presence + drift)
 *
 * Picker UX: matches F101 (pre-flight) - placeholder shows the
 * verdict + issue count, actions offer Open report / Open PR / Run
 * merge anyway (only when verdict is 'caution').
 *
 * Composes with F75 prReviewInbox + the F106 prTimelinePill action
 * menu so users get to this command from the same surfaces they
 * already use for PR-state-aware actions.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { parseRemote } from '../git/hostDetect';
import {
  runPreMergeChecklist,
  describeMergeReport,
  renderMergeReport,
  allowsOverride,
  normaliseMergeStateStatus,
  normaliseMergeable,
  MergeReport,
  PreMergeInputs,
} from '../git/preMergeChecklist';
import {
  hasTestImpactBlock,
  buildTestImpactBlock,
  needsTestImpactRewrite,
  TEST_IMPACT_OPEN_MARKER,
  TEST_IMPACT_CLOSE_MARKER,
} from '../git/testImpactPrBody';
import { computeTestImpactSummary } from './testImpact';

const pexec = promisify(execFile);

interface PrSnapshot {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  reviews: Array<{ author?: { login?: string }; state?: string; submittedAt?: string }>;
  isDraft: boolean;
  statusCheckRollup?: Array<{ conclusion?: string; status?: string; name?: string }>;
}

export async function runPreMergeChecklist_View(repos: { primary(): Git | undefined }, arg?: any): Promise<void> {
  const git = repos.primary();
  if (!git) {
    vscode.window.showWarningMessage('GitSight: no git repo in workspace.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not found - cannot probe PR state.');
    return;
  }

  const prNumber = await resolvePrNumber(git, arg);
  if (prNumber === undefined) return;

  const repoSlug = await resolveRepoSlug(git);
  if (!repoSlug) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub remote.');
    return;
  }

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `GitSight: pre-merge checklist for PR #${prNumber}\u2026`,
    },
    async () => {
      const pr = await fetchPrSnapshot(repoSlug, prNumber);
      if (!pr) return { report: undefined, pr: undefined };
      const inputs = await assembleInputs(git, pr, repoSlug);
      return { report: runPreMergeChecklist(inputs), pr };
    },
  );

  if (!report.pr) {
    vscode.window.showErrorMessage(`GitSight: could not fetch PR #${prNumber} - check the number and your gh auth.`);
    return;
  }
  await showResult(report.pr, report.report!);
}

async function showResult(pr: PrSnapshot, report: MergeReport): Promise<void> {
  const display = `PR #${pr.number} ${pr.title}`;
  type Pk = vscode.QuickPickItem & { _act?: 'preview' | 'open' | 'merge' };
  const items: Pk[] = [];
  items.push({
    label: `$(${glyphForVerdict(report.verdict)}) ${describeMergeReport(report)}`,
    description: display,
    detail: `Verdict: ${report.verdict.toUpperCase()} \u00b7 ${report.counts.error} error \u00b7 ${report.counts.warning} warning \u00b7 ${report.counts.ok} ok`,
  });
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
  for (const c of report.checks) {
    const g = c.severity === 'error' ? 'error'
            : c.severity === 'warning' ? 'warning'
            : 'pass';
    items.push({
      label: `$(${g}) ${c.title}`,
      description: c.severity,
      detail: c.message + (c.hint ? ` \u00b7 ${c.hint}` : ''),
    });
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as any);
  items.push({ label: '$(file) Open full report', _act: 'preview' });
  items.push({ label: '$(globe) Open PR on GitHub', _act: 'open' });
  if (allowsOverride(report.verdict)) {
    items.push({ label: '$(warning) Merge anyway (override caution)', _act: 'merge' });
  } else if (report.verdict === 'ready') {
    items.push({ label: '$(check) Merge now', _act: 'merge' });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: describeMergeReport(report),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  switch (picked._act) {
    case 'preview': {
      const md = renderMergeReport(`PR #${pr.number} ${pr.title}`, report);
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      break;
    }
    case 'open': {
      await vscode.env.openExternal(vscode.Uri.parse(pr.url));
      break;
    }
    case 'merge': {
      const detail = report.verdict === 'caution'
        ? 'Verdict is CAUTION. Confirm you want to merge despite the warnings above.'
        : 'Verdict is READY. Proceed with `gh pr merge`.';
      const ok = await vscode.window.showWarningMessage(
        `Run \`gh pr merge ${pr.number}\` now?`,
        { modal: true, detail },
        'Run merge', 'Cancel',
      );
      if (ok !== 'Run merge') return;
      await runMerge(pr.number);
      break;
    }
  }
}

function glyphForVerdict(v: MergeReport['verdict']): string {
  switch (v) {
    case 'ready':   return 'check';
    case 'caution': return 'warning';
    case 'blocked': return 'error';
  }
}

async function resolvePrNumber(git: Git, arg: any): Promise<number | undefined> {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg === 'object' && typeof arg.number === 'number') return arg.number;
  if (arg && typeof arg === 'object' && typeof arg.pr?.number === 'number') return arg.pr.number;
  // Try to look up the current branch's PR opportunistically.
  try {
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch && branch !== 'HEAD') {
      const slug = await resolveRepoSlug(git);
      if (slug) {
        try {
          const { stdout } = await pexec('gh', [
            'pr', 'view', branch,
            '--repo', `${slug.owner}/${slug.repo}`,
            '--json', 'number',
          ], { timeout: 10000 });
          const obj = JSON.parse(stdout);
          if (obj?.number) return obj.number as number;
        } catch { /* ignore - fall through to prompt */ }
      }
    }
  } catch { /* ignore */ }
  const ans = await vscode.window.showInputBox({
    title: 'GitSight - pre-merge checklist',
    placeHolder: 'PR number',
    validateInput: (v) => /^\d+$/.test(v.trim()) ? null : 'enter a PR number',
  });
  if (!ans) return undefined;
  const n = Number.parseInt(ans.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

interface RepoSlug { owner: string; repo: string; }

async function resolveRepoSlug(git: Git): Promise<RepoSlug | undefined> {
  try {
    const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
    const info = parseRemote(url);
    if (!info) return undefined;
    if (info.host !== 'github') return undefined;
    return { owner: info.owner, repo: info.repo };
  } catch {
    return undefined;
  }
}

async function fetchPrSnapshot(slug: RepoSlug, prNumber: number): Promise<PrSnapshot | undefined> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view', String(prNumber),
      '--repo', `${slug.owner}/${slug.repo}`,
      '--json', 'number,url,title,body,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,reviews,isDraft,statusCheckRollup',
    ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const obj = JSON.parse(stdout);
    if (!obj || typeof obj.number !== 'number') return undefined;
    return {
      number: obj.number,
      url: String(obj.url ?? ''),
      title: String(obj.title ?? ''),
      body: String(obj.body ?? ''),
      baseRefName: String(obj.baseRefName ?? 'main'),
      headRefName: String(obj.headRefName ?? ''),
      mergeable: obj.mergeable ?? null,
      mergeStateStatus: obj.mergeStateStatus ?? null,
      reviewDecision: obj.reviewDecision ?? null,
      reviews: Array.isArray(obj.reviews) ? obj.reviews : [],
      isDraft: !!obj.isDraft,
      statusCheckRollup: Array.isArray(obj.statusCheckRollup) ? obj.statusCheckRollup : undefined,
    };
  } catch {
    return undefined;
  }
}

async function assembleInputs(git: Git, pr: PrSnapshot, slug: RepoSlug): Promise<PreMergeInputs> {
  const [approvingReviews, requiredApprovals, baseBehindBy, testImpactSync] = await Promise.all([
    countApprovingReviews(pr),
    fetchRequiredApprovals(slug, pr.baseRefName),
    computeBaseBehindBy(git, pr),
    classifyTestImpactSync(git, pr),
  ]);
  const mergeStateStatus = normaliseMergeStateStatus(pr.mergeStateStatus);
  const failingCheckCount = countFailingChecks(pr);
  return {
    approvingReviews,
    requiredApprovals,
    statusCheckVerdict: mergeStateStatus,
    failingCheckCount,
    mergeable: normaliseMergeable(pr.mergeable),
    mergeStateStatus,
    baseBranch: pr.baseRefName,
    baseBehindBy,
    baseDivergenceThreshold: vscode.workspace.getConfiguration('gitsight.preMergeChecklist').get<number>('baseDivergenceThreshold', 10),
    testImpactHasBlock: testImpactSync.hasBlock,
    testImpactBlockMatchesHead: testImpactSync.matches,
  };
}

function countApprovingReviews(pr: PrSnapshot): number {
  if (!pr.reviews?.length) return 0;
  // Latest-review-wins per author.
  const latest = new Map<string, { state: string; submittedAt: string }>();
  for (const r of pr.reviews) {
    const author = r.author?.login ?? '';
    if (!author) continue;
    const state = (r.state ?? '').toUpperCase();
    const at = r.submittedAt ?? '';
    const prev = latest.get(author);
    if (!prev || at > prev.submittedAt) {
      latest.set(author, { state, submittedAt: at });
    }
  }
  let n = 0;
  for (const r of latest.values()) {
    if (r.state === 'APPROVED') n++;
  }
  return n;
}

async function fetchRequiredApprovals(slug: RepoSlug, baseBranch: string): Promise<number> {
  // Probe branch protection for the count. Failures degrade to "1".
  try {
    const { stdout } = await pexec('gh', [
      'api',
      `repos/${slug.owner}/${slug.repo}/branches/${encodeURIComponent(baseBranch)}/protection`,
    ], { timeout: 8000, maxBuffer: 512 * 1024 });
    const obj = JSON.parse(stdout);
    const count = obj?.required_pull_request_reviews?.required_approving_review_count;
    if (typeof count === 'number' && count > 0) return count;
    return 1;
  } catch {
    return 1;
  }
}

async function computeBaseBehindBy(git: Git, pr: PrSnapshot): Promise<number> {
  if (!pr.baseRefName || !pr.headRefName) return 0;
  // Best effort: rev-list --left-right --count <base>...<head>
  // where base is the LOCAL tip of origin/<base> and head is the
  // remote PR head. Local refs may not exist; degrade to 0.
  try {
    const ranges = `origin/${pr.baseRefName}...origin/${pr.headRefName}`;
    const out = (await git.raw(['rev-list', '--left-right', '--count', ranges])).trim();
    const parts = out.split(/\s+/);
    if (parts.length >= 2) {
      const behind = Number.parseInt(parts[0], 10);
      if (Number.isFinite(behind)) return behind;
    }
  } catch { /* base may not be fetched locally */ }
  return 0;
}

async function classifyTestImpactSync(git: Git, pr: PrSnapshot): Promise<{ hasBlock: boolean; matches: boolean }> {
  if (!hasTestImpactBlock(pr.body)) return { hasBlock: false, matches: false };
  // Block present - probe whether re-rendering would change anything.
  // Use the same computeTestImpactSummary entry point that F125 uses
  // so the verdict stays consistent.
  let summary;
  try {
    summary = await computeTestImpactSummary(git);
  } catch {
    // If summarisation fails we can't classify - default to "matches"
    // so we don't surface a false-positive warning.
    return { hasBlock: true, matches: true };
  }
  if (!summary) return { hasBlock: true, matches: true };
  const cfg = vscode.workspace.getConfiguration('gitsight.testImpactPrBody');
  const maxRows = clamp(cfg.get<number>('maxRows', 12), 1, 50);
  const maxOrphans = clamp(cfg.get<number>('maxOrphans', 10), 0, 100);
  const includeOrphans = cfg.get<boolean>('includeOrphans', true);
  const block = buildTestImpactBlock({
    summary,
    syncedAt: 'PROBE',
    maxRows,
    maxOrphans,
    includeOrphans,
  });
  return {
    hasBlock: true,
    matches: !needsTestImpactRewrite(pr.body, block),
  };
}

function countFailingChecks(pr: PrSnapshot): number {
  if (!pr.statusCheckRollup?.length) return 0;
  let n = 0;
  for (const c of pr.statusCheckRollup) {
    const conclusion = (c.conclusion ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'STARTUP_FAILURE') n++;
    else if (status === 'QUEUED' || status === 'PENDING' || status === 'IN_PROGRESS') {
      // Pending checks count as "in flight" - the merge gate still
      // sees BLOCKED in that state, so count them so the message
      // reads "N required checks failing or pending".
      n++;
    }
  }
  return n;
}

async function runMerge(prNumber: number): Promise<void> {
  // Don't auto-merge from the editor - drop into a terminal so the
  // user can pick the strategy + watch the output. Matches F121's
  // mergeQueueEnqueue handoff pattern.
  const term = vscode.window.createTerminal('GitSight: pre-merge');
  term.show();
  term.sendText(`gh pr merge ${prNumber}`, false);
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

function clamp(n: number | undefined, lo: number, hi: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
