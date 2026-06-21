/**
 * Pre-Push Lint Hook bridge (F14).
 *
 * Before a `git push` actually goes out, this controller walks the
 * `<upstream>..HEAD` range (everything new on the current branch) and
 * checks each commit for:
 *
 *   - WIP / fixup! / squash! / amend! / do-not-merge subjects
 *   - Unresolved conflict markers in the commit body
 *   - (optional) subjects missing a configured issue-tracker prefix
 *
 * Errors (conflict markers) trigger a modal-style confirmation that defaults
 * to Cancel; warnings (WIP) trigger an inline confirmation that defaults to
 * Push anyway. Either result can be inspected with a per-commit picker
 * before the user commits to (no pun intended) the push.
 *
 * Hook is wired into the existing `gitsight.push` command via
 * `runPrePushLint()` which returns either `'ok'` or `'cancel'`.
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  lintPrePush,
  summarisePrePush,
  describePrePush,
  parsePrePushLog,
  PrePushCommit,
  PrePushFinding,
  PrePushSummary,
} from '../git/prePushLint';

export interface PrePushLintResult {
  decision: 'ok' | 'cancel';
  summary: PrePushSummary;
  findings: PrePushFinding[];
}

/**
 * Run the pre-push lint. Returns `decision: 'ok'` to proceed, or `'cancel'`
 * to abort the push. The caller is expected to honour the decision and not
 * call `git push` when it's `'cancel'`.
 *
 * Configuration:
 *   gitsight.prePushLint.enabled        (default true)
 *   gitsight.prePushLint.requireSubjectMatching (regex string, default empty)
 *   gitsight.prePushLint.scanPatches    (default true) — read git show for
 *     conflict-marker detection. Disable on huge ranges if it's slow.
 *   gitsight.prePushLint.maxCommits     (default 200) — cap on commits to
 *     scan; if the range is larger, skip the lint entirely and let the
 *     push proceed.
 */
export async function runPrePushLint(git: Git): Promise<PrePushLintResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.prePushLint');
  if (!cfg.get<boolean>('enabled', true)) {
    return emptyOk();
  }

  // 1. Resolve the range. Skip silently when the branch has no upstream —
  //    we'd be linting all of history, which is both expensive and useless.
  const range = await resolveRange(git);
  if (!range) return emptyOk();

  // 2. List commits in range.
  const logOut = await safe(git, [
    'log',
    range,
    '--no-merges',
    '--pretty=format:%H|%h|%s',
  ]);
  const commits = parsePrePushLog(logOut);
  if (!commits.length) return emptyOk();

  const maxCommits = clamp(cfg.get<number>('maxCommits', 200), 10, 5000);
  if (commits.length > maxCommits) {
    // Too big — show a one-liner and skip. The user explicitly opted into
    // a fast push by exceeding the cap.
    vscode.window.setStatusBarMessage(
      `GitSight: ${commits.length} commits exceeds prePushLint.maxCommits=${maxCommits}; skipping lint.`,
      4000,
    );
    return emptyOk();
  }

  // 3. Optionally hydrate patch bodies. We only fetch for commits that
  //    don't already have a WIP-shaped subject — those are flagged anyway.
  if (cfg.get<boolean>('scanPatches', true)) {
    await hydratePatches(git, commits);
  }

  // 4. Lint.
  const requireSubjectMatching = cfg.get<string>('requireSubjectMatching', '');
  const findings = lintPrePush(commits, {
    requireSubjectMatching: requireSubjectMatching || undefined,
  });
  const summary = summarisePrePush(findings);
  if (summary.total === 0) return { decision: 'ok', summary, findings };

  // 5. Surface — modal on error, soft on warning.
  const decision = await promptUser(summary, findings, commits.length);
  return { decision, summary, findings };
}

async function resolveRange(git: Git): Promise<string | undefined> {
  // Prefer the upstream's remote-tracking ref; fall back to origin/<branch>.
  const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') return undefined;
  const upstream = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (upstream) return `${upstream}..HEAD`;
  // No upstream yet — check whether origin/<branch> exists so first-push
  // still gets the lint applied.
  const remoteRef = (await safe(git, ['rev-parse', '--verify', `origin/${branch}`])).trim();
  if (remoteRef) return `origin/${branch}..HEAD`;
  return undefined;
}

async function hydratePatches(git: Git, commits: PrePushCommit[]): Promise<void> {
  // Skip patch fetching for commits already flagged as WIP-shape — that
  // keeps the I/O budget low on busy branches.
  await Promise.all(commits.map(async c => {
    if (looksLikeWip(c.subject)) return;
    try {
      // -U0: no context lines, the marker either appears in the patch or
      // it doesn't. Drastically cheaper than the default U3.
      c.patch = await git.raw(['show', '-U0', '--format=', c.sha]);
    } catch {
      // Patch fetch failure is non-fatal — we'll just skip conflict-marker
      // detection for that commit.
    }
  }));
}

function looksLikeWip(subject: string): boolean {
  return /^(wip|fixup!|squash!|amend!|tmp:|temp:|todo:|do\s*not\s*merge|dnm)\b/i.test(subject ?? '');
}

async function promptUser(
  summary: PrePushSummary,
  findings: PrePushFinding[],
  totalCommits: number,
): Promise<'ok' | 'cancel'> {
  const desc = describePrePush(summary);
  const headline = `GitSight: pre-push lint flagged ${summary.total} issue${summary.total === 1 ? '' : 's'} in ${totalCommits} commit${totalCommits === 1 ? '' : 's'} — ${desc}.`;

  if (summary.blocking) {
    // Hard error — modal, default Cancel.
    const choice = await vscode.window.showWarningMessage(
      headline,
      { modal: true, detail: detailLines(findings) },
      'Show findings…',
      'Push anyway',
    );
    if (choice === 'Show findings…') {
      await showFindingsPicker(findings);
      // After the picker, fall back to a soft re-confirm so the user can
      // either Push anyway or Cancel.
      const after = await vscode.window.showWarningMessage(
        headline + ' Continue with the push?',
        { modal: true },
        'Push anyway',
      );
      return after === 'Push anyway' ? 'ok' : 'cancel';
    }
    return choice === 'Push anyway' ? 'ok' : 'cancel';
  }

  // Soft warning — non-modal, default Push anyway.
  const choice = await vscode.window.showWarningMessage(
    headline,
    'Push anyway',
    'Show findings…',
    'Cancel',
  );
  if (choice === 'Show findings…') {
    await showFindingsPicker(findings);
    const after = await vscode.window.showWarningMessage(
      headline + ' Continue with the push?',
      'Push anyway',
      'Cancel',
    );
    return after === 'Push anyway' ? 'ok' : 'cancel';
  }
  return choice === 'Push anyway' ? 'ok' : 'cancel';
}

function detailLines(findings: PrePushFinding[]): string {
  return findings.slice(0, 8).map(f =>
    `${f.severity === 'error' ? '!' : '·'} ${f.shortSha}  ${f.detail}  —  ${f.subject}`,
  ).join('\n') + (findings.length > 8 ? `\n…and ${findings.length - 8} more` : '');
}

async function showFindingsPicker(findings: PrePushFinding[]): Promise<void> {
  type Pk = vscode.QuickPickItem & { _sha: string };
  const items: Pk[] = findings.map(f => ({
    label: `${f.severity === 'error' ? '$(error)' : '$(warning)'} ${f.shortSha}  ${f.detail}`,
    description: f.subject,
    detail: f.kind === 'conflict-marker'
      ? 'Unresolved conflict marker in commit body — almost certainly a mid-rebase mistake.'
      : f.kind === 'missing-issue'
        ? 'Subject does not match the configured issue-tracker pattern.'
        : 'WIP-shaped commit subject — likely not meant for the remote.',
    _sha: f.sha,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${findings.length} pre-push finding${findings.length === 1 ? '' : 's'} — pick one to view`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  // Open the commit detail in a side editor (re-use the existing command).
  await vscode.commands.executeCommand('gitsight.showCommitDetail', undefined, picked._sha);
}

function emptyOk(): PrePushLintResult {
  return {
    decision: 'ok',
    summary: { total: 0, errors: 0, warnings: 0, byKind: { 'wip-commit': 0, 'conflict-marker': 0, 'missing-issue': 0 }, blocking: false },
    findings: [],
  };
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}

function clamp(v: number | undefined, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
