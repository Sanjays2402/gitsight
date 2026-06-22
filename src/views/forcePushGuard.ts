/**
 * F71 — Branch Protection Guard for force-push.
 *
 * Wraps the force-push code path with a `gh api repos/:owner/:repo/
 * branches/:branch/protection` lookup. When the branch is protected and
 * doesn't allow force-pushes, refuse before the round-trip and surface
 * the protection rules so the user knows what they're up against.
 *
 * Composes with the existing pre-push lint + commit-message gate: this
 * guard runs FIRST (cheap, network-bounded) so the heavier gates only
 * run for pushes that are actually going to be accepted by GitHub.
 *
 * Three commands are exposed:
 *
 *   - gitsight.forcePush               — guard + `git push --force-with-lease`
 *   - gitsight.forcePushDangerous      — guard + `git push --force` (no lease)
 *   - gitsight.checkBranchProtection   — display-only probe (no push)
 *
 * Both force commands prompt for a final modal confirmation even after
 * the guard passes — force-push is destructive enough that one accidental
 * keystroke shouldn't fire it.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Git } from '../git/git';
import {
  classifyProtection,
  describeDecision,
  parseGitHubRepo,
  ProtectionDecision,
} from '../git/forcePushGuard';
import { withAuthSanityCheck } from './sshKeyCheck';

const pexec = promisify(execFile);

export interface GuardResult {
  decision: ProtectionDecision;
  /** Final user decision: ok to push, or cancelled. */
  proceed: boolean;
}

/**
 * Run the protection probe + (when needed) confirmation modal. Returns
 * whether the caller should proceed with the actual force-push.
 */
export async function guardForcePush(git: Git, branch: string): Promise<GuardResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.forcePushGuard');
  if (!cfg.get<boolean>('enabled', true)) return { decision: { kind: 'unknown', reason: 'guard disabled in settings' }, proceed: true };

  const repo = await resolveGitHubRepo(git);
  if (!repo) {
    // Non-GitHub remote — we have no protection API to consult; let
    // the push happen and rely on the remote to refuse if needed.
    return { decision: { kind: 'unknown', reason: 'origin is not a GitHub repository' }, proceed: true };
  }

  if (!(await ghAvailable())) {
    return { decision: { kind: 'unknown', reason: 'gh CLI not on PATH' }, proceed: await confirmWithoutGuard(branch) };
  }

  const probe = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `GitSight: checking protection for ${branch}\u2026` },
    () => probeProtection(repo.owner, repo.repo, branch),
  );

  if (probe.decision.kind === 'unprotected') {
    return { decision: probe.decision, proceed: await confirmForcePush(branch, probe.decision) };
  }
  if (probe.decision.kind === 'unknown') {
    return { decision: probe.decision, proceed: await confirmOnUnknown(branch, probe.decision.reason) };
  }
  // Protected branch.
  if (probe.decision.allowsForcePush) {
    return { decision: probe.decision, proceed: await confirmForcePush(branch, probe.decision) };
  }
  // Protected + force disallowed — refuse.
  await showRefusal(branch, probe.decision);
  return { decision: probe.decision, proceed: false };
}

export async function forcePush(git: Git, opts: { lease: boolean }): Promise<void> {
  const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') {
    vscode.window.showWarningMessage('GitSight: detached HEAD — nothing to force-push.');
    return;
  }
  const { proceed } = await guardForcePush(git, branch);
  if (!proceed) return;

  const args = ['push', '--force-with-lease', 'origin', branch];
  if (!opts.lease) {
    args.splice(1, 1, '--force'); // replace --force-with-lease with --force
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: force-pushing ${branch}\u2026` },
    () => withAuthSanityCheck(git, 'origin', () => git.raw(args).then(() => undefined)),
  );
  vscode.window.setStatusBarMessage(`Force-pushed ${branch}`, 3000);
}

export async function checkBranchProtection(git: Git): Promise<void> {
  const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') {
    vscode.window.showWarningMessage('GitSight: detached HEAD — no branch to check.');
    return;
  }
  const repo = await resolveGitHubRepo(git);
  if (!repo) {
    vscode.window.showInformationMessage('GitSight: origin is not a GitHub repository.');
    return;
  }
  if (!(await ghAvailable())) {
    vscode.window.showWarningMessage('GitSight: gh CLI not on PATH (install: brew install gh).');
    return;
  }
  const probe = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `GitSight: checking protection for ${branch}\u2026` },
    () => probeProtection(repo.owner, repo.repo, branch),
  );
  await renderDecisionInfo(branch, probe.decision);
}

async function probeProtection(
  owner: string,
  repo: string,
  branch: string,
): Promise<{ decision: ProtectionDecision }> {
  try {
    const { stdout } = await pexec('gh', ['api', `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`], { maxBuffer: 4 * 1024 * 1024 });
    return { decision: classifyProtection(stdout, '', 0) };
  } catch (e: any) {
    return { decision: classifyProtection('', String(e.stderr ?? e.message ?? ''), Number(e.code ?? 1)) };
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

async function confirmForcePush(branch: string, decision: ProtectionDecision): Promise<boolean> {
  const headline = `Force-push ${branch}?`;
  const detail = decisionDetail(decision)
    + '\n\nThis rewrites remote history. Anyone with the previous commits in their local tree will need to re-fetch.';
  const choice = await vscode.window.showWarningMessage(
    headline,
    { modal: true, detail },
    'Force-push',
  );
  return choice === 'Force-push';
}

async function confirmWithoutGuard(branch: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Force-push ${branch} without protection check?`,
    { modal: true, detail: 'gh CLI is not on PATH so GitSight cannot consult branch protection. Push will be sent directly.' },
    'Force-push anyway',
  );
  return choice === 'Force-push anyway';
}

async function confirmOnUnknown(branch: string, reason: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Could not check protection for ${branch}`,
    { modal: true, detail: `${reason}.\n\nProceed with the force-push anyway?` },
    'Force-push',
  );
  return choice === 'Force-push';
}

async function showRefusal(branch: string, decision: ProtectionDecision): Promise<void> {
  if (decision.kind !== 'protected') return;
  await vscode.window.showErrorMessage(
    `GitSight: refusing to force-push ${branch}.`,
    { modal: true, detail: decisionDetail(decision) + '\n\nUpdate the branch protection rules on GitHub if you really need to force-push.' },
    'OK',
  );
}

async function renderDecisionInfo(branch: string, decision: ProtectionDecision): Promise<void> {
  if (decision.kind === 'unprotected') {
    vscode.window.showInformationMessage(describeDecision(decision, branch));
    return;
  }
  if (decision.kind === 'unknown') {
    vscode.window.showWarningMessage(describeDecision(decision, branch));
    return;
  }
  const rules = decision.rules.length
    ? '\n\n' + decision.rules.map(r => `  \u00b7 ${r.label}`).join('\n')
    : '';
  await vscode.window.showInformationMessage(
    describeDecision(decision, branch),
    { modal: true, detail: `Active protection rules:${rules || '\n  (none beyond force-push)'}` },
    'OK',
  );
}

function decisionDetail(decision: ProtectionDecision): string {
  if (decision.kind !== 'protected') return '';
  if (!decision.rules.length) return 'Protection is enabled with default rules.';
  return 'Active protection rules:\n' + decision.rules.map(r => `  \u00b7 ${r.label}`).join('\n');
}
