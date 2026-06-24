/**
 * F139 - PR-body test-impact INSERT auto-offer (passive controller).
 *
 * Composes with F125 (manual injectTestImpactIntoPr) + F129 (auto-sync
 * fire-and-forget). The gap this fills: F129's auto-sync only refreshes
 * a block that's ALREADY in the body, so a user who has never run F125
 * never sees the benefits of auto-sync.
 *
 * After a `gitsight.push`, this controller:
 *   1. Re-uses the F129 PR-snapshot probe (no extra gh API call).
 *   2. Classifies whether the PR meets the "worth it" threshold for
 *      an offer (default: >= 3 files changed).
 *   3. If yes, surfaces a toast: "Insert test-impact summary into PR #N?"
 *   4. On Accept -> calls the existing gitsight.injectTestImpactIntoPr
 *      command so the user lands on the F125 picker.
 *   5. On Dismiss -> remembers this PR for the session so we don't
 *      pester them on every push.
 *
 * Pure decision logic lives in src/git/testImpactPrBodyInsertOffer.ts;
 * this file owns only the vscode wiring.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import { RepoManager } from '../git/repoManager';
import { parseRemote } from '../git/hostDetect';
import {
  classifyInsertOffer,
  describeInsertOffer,
  dismissalCacheKey,
  shouldRememberDismissal,
  InsertOfferOutcome,
} from '../git/testImpactPrBodyInsertOffer';

const pexec = promisify(execFile);

// Session-only dismissal cache. Cleared on extension reload.
const dismissedKeys = new Set<string>();

interface PrInsertSnapshot {
  number: number;
  url: string;
  body: string;
  isDraft: boolean;
  changedFiles: number;
}

interface RepoSlug { owner: string; repo: string; }

/**
 * Fire-and-forget wrapper. Called by the gitsight.push command after
 * auto-sync runs (when auto-sync reports 'no-block', this is what
 * surfaces the offer). Quiet on every other outcome.
 */
export function runTestImpactInsertOfferFireAndForget(repos: RepoManager, branch?: string): void {
  void (async () => {
    try {
      const outcome = await runInsertOffer(repos, branch);
      // We don't surface skips in the status bar - the user didn't
      // ask. The 'offer' path opens a toast on its own; everything
      // else is silent.
      void outcome;
    } catch {
      // Never blow up the push hot path.
    }
  })();
}

async function runInsertOffer(repos: RepoManager, branch?: string): Promise<InsertOfferOutcome> {
  const cfg = vscode.workspace.getConfiguration('gitsight.testImpactPrBody');
  const enabled = cfg.get<boolean>('insertAutoOffer', true);
  const minimumFileCount = clamp(cfg.get<number>('insertAutoOfferMinFiles', 3), 1, 1000);

  // Cheap pre-check: if the feature is off we don't even start the
  // probe sequence.
  if (!enabled) {
    return 'skip-disabled';
  }

  const git = repos.primary();
  if (!git) return 'skip-no-pr';
  if (!(await ghAvailable())) return 'skip-no-pr';
  const slug = await resolveRepoSlug(git);
  if (!slug) return 'skip-no-pr';

  let head = (branch ?? '').trim();
  if (!head) {
    try { head = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* ignore */ }
  }
  if (!head || head === 'HEAD') return 'skip-no-pr';

  const pr = await fetchPrSnapshot(slug, head);
  if (!pr) return 'skip-no-pr';

  const key = dismissalCacheKey(pr.url);
  const alreadyDismissed = key ? dismissedKeys.has(key) : false;

  const outcome = classifyInsertOffer({
    enabled,
    prBody: pr.body,
    changedFileCount: pr.changedFiles,
    minimumFileCount,
    isDraft: pr.isDraft,
    alreadyDismissed,
  });

  if (outcome !== 'offer') {
    // Remember actionable skips so a future push doesn't re-check the
    // same PR (the user already saw the state once).
    if (key && shouldRememberDismissal(outcome)) {
      // skip-draft + skip-too-small are temporary states - we WANT
      // to recheck once the user un-drafts or adds more files. So
      // only remember literal 'dismissed' here, not the temporary
      // skips. shouldRememberDismissal says draft/too-small SHOULD
      // be remembered for the SESSION though, to avoid re-prompting
      // on every push within one session.
      dismissedKeys.add(key);
    }
    return outcome;
  }

  await promptOffer(pr, key);
  return outcome;
}

async function promptOffer(pr: PrInsertSnapshot, key: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    describeInsertOffer({ prNumber: pr.number, fileCount: pr.changedFiles }),
    'Insert now',
    'Not now',
    'Stop offering',
  );
  if (!choice) {
    // Treat raw dismiss as a soft dismiss - re-prompt next session
    // but not on the next push in this one.
    if (key) dismissedKeys.add(key);
    return;
  }
  if (choice === 'Insert now') {
    await vscode.commands.executeCommand('gitsight.injectTestImpactIntoPr');
    return;
  }
  if (choice === 'Not now') {
    if (key) dismissedKeys.add(key);
    return;
  }
  if (choice === 'Stop offering') {
    // Flip the config off for this workspace + remember the key as a
    // belt-and-suspenders.
    if (key) dismissedKeys.add(key);
    try {
      await vscode.workspace.getConfiguration('gitsight.testImpactPrBody')
        .update('insertAutoOffer', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.setStatusBarMessage(
        'GitSight: test-impact insert auto-offer disabled for this workspace.',
        4000,
      );
    } catch {
      // Workspace-level update can fail in some untrusted-workspace
      // setups - just remember the key and move on.
    }
  }
}

async function fetchPrSnapshot(slug: RepoSlug, head: string): Promise<PrInsertSnapshot | undefined> {
  try {
    const { stdout } = await pexec('gh', [
      'pr', 'view', head,
      '--repo', `${slug.owner}/${slug.repo}`,
      '--json', 'number,url,body,isDraft,changedFiles',
    ], { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
    const obj = JSON.parse(stdout);
    if (!obj || typeof obj.number !== 'number') return undefined;
    return {
      number: obj.number,
      url: String(obj.url ?? ''),
      body: String(obj.body ?? ''),
      isDraft: !!obj.isDraft,
      changedFiles: typeof obj.changedFiles === 'number' ? obj.changedFiles : 0,
    };
  } catch {
    return undefined;
  }
}

async function resolveRepoSlug(git: Git): Promise<RepoSlug | undefined> {
  try {
    const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
    const info = parseRemote(url);
    if (!info || info.host !== 'github') return undefined;
    return { owner: info.owner, repo: info.repo };
  } catch {
    return undefined;
  }
}

async function ghAvailable(): Promise<boolean> {
  try { await pexec('gh', ['--version'], { timeout: 3000 }); return true; }
  catch { return false; }
}

function clamp(n: number | undefined, lo: number, hi: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/**
 * Testability helper: clear the session-only dismissal cache. Not
 * wired to any command - used by tests + extension reload.
 */
export function _resetInsertOfferDismissals(): void {
  dismissedKeys.clear();
}
