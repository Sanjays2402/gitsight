/**
 * Pre-Push Commit-Message Gate (F69) — runs the commit-message linter
 * (the same one the F21 SCM input-box validator uses) against every
 * commit in the to-push range and decides whether to block the push.
 *
 * Composes with the F14 pre-push lint (which catches WIP subjects +
 * embedded conflict markers): both run before `git push`, and either
 * can cancel.
 *
 * Configurable via:
 *   gitsight.prePushMessageGate.enabled  (default true)
 *   gitsight.prePushMessageGate.blockAt  ('error' | 'warning' | 'never',
 *                                         default 'error')
 *   gitsight.prePushMessageGate.options  ({ ...lintCommitMessage options },
 *                                         passes through verbatim — same
 *                                         shape as the SCM linter config)
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  lintCommitMessages,
  summariseCommitGate,
  describeCommitGate,
  parseCommitMessageLog,
  CommitGateFinding,
  CommitGateSummary,
  GateBlockLevel,
} from '../git/prePushMessageGate';
import { LintOptions } from '../git/commitLint';

export interface PrePushMessageGateResult {
  decision: 'ok' | 'cancel';
  summary: CommitGateSummary;
  findings: CommitGateFinding[];
}

export async function runPrePushMessageGate(git: Git): Promise<PrePushMessageGateResult> {
  const cfg = vscode.workspace.getConfiguration('gitsight.prePushMessageGate');
  if (!cfg.get<boolean>('enabled', true)) return emptyOk();

  const blockAt = (cfg.get<string>('blockAt', 'error') ?? 'error') as GateBlockLevel;
  const lintOptions = (cfg.get<LintOptions>('options', {}) ?? {}) as LintOptions;

  const range = await resolveRange(git);
  if (!range) return emptyOk();

  const raw = await safe(git, [
    'log',
    range,
    '--no-merges',
    `--pretty=format:%H%n%h%n%s%n%b%x1e`,
  ]);
  const commits = parseCommitMessageLog(raw);
  if (!commits.length) return emptyOk();

  const findings = lintCommitMessages(commits, lintOptions);
  const summary = summariseCommitGate(findings, commits.length, blockAt);
  if (summary.totalProblems === 0) return { decision: 'ok', summary, findings };

  const decision = await promptUser(summary, findings, blockAt);
  return { decision, summary, findings };
}

async function resolveRange(git: Git): Promise<string | undefined> {
  const branch = (await safe(git, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') return undefined;
  const upstream = (await safe(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (upstream) return `${upstream}..HEAD`;
  const remoteRef = (await safe(git, ['rev-parse', '--verify', `origin/${branch}`])).trim();
  if (remoteRef) return `origin/${branch}..HEAD`;
  return undefined;
}

async function promptUser(
  summary: CommitGateSummary,
  findings: CommitGateFinding[],
  blockAt: GateBlockLevel,
): Promise<'ok' | 'cancel'> {
  const headline = `GitSight: ${describeCommitGate(summary)} across ${summary.totalCommits} commit${summary.totalCommits === 1 ? '' : 's'}.`;
  const detail = findings
    .slice(0, 6)
    .map(f => `${f.topSeverity === 'error' ? '!' : '\u00b7'} ${f.shortSha}  ${f.subject}\n      ${f.problems[0].message}`)
    .join('\n') + (findings.length > 6 ? `\n\u2026and ${findings.length - 6} more` : '');

  if (summary.blocking) {
    const choice = await vscode.window.showWarningMessage(
      headline,
      { modal: true, detail },
      'Show findings\u2026',
      'Push anyway',
    );
    if (choice === 'Show findings\u2026') {
      await showFindingsPicker(findings);
      const after = await vscode.window.showWarningMessage(
        `${headline} Continue with the push?`,
        { modal: true },
        'Push anyway',
      );
      return after === 'Push anyway' ? 'ok' : 'cancel';
    }
    return choice === 'Push anyway' ? 'ok' : 'cancel';
  }

  // Non-blocking: surface as a soft warning so the user is at least aware.
  const choice = await vscode.window.showWarningMessage(
    headline,
    'Push anyway',
    'Show findings\u2026',
    'Cancel',
  );
  if (choice === 'Show findings\u2026') {
    await showFindingsPicker(findings);
    const after = await vscode.window.showWarningMessage(
      `${headline} Continue with the push?`,
      'Push anyway', 'Cancel',
    );
    return after === 'Push anyway' ? 'ok' : 'cancel';
  }
  return choice === 'Push anyway' ? 'ok' : 'cancel';
}

async function showFindingsPicker(findings: CommitGateFinding[]): Promise<void> {
  type Pk = vscode.QuickPickItem & { _sha: string };
  const items: Pk[] = [];
  for (const f of findings) {
    items.push({
      label: `${f.topSeverity === 'error' ? '$(error)' : '$(warning)'} ${f.shortSha}  ${f.subject}`,
      description: `${f.problems.length} issue${f.problems.length === 1 ? '' : 's'}`,
      detail: f.problems.slice(0, 3).map(p => `${p.severity === 'error' ? '!' : '\u00b7'} ${p.message}`).join('  \u00b7  '),
      _sha: f.sha,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `${findings.length} commit${findings.length === 1 ? '' : 's'} flagged — pick one to view`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  await vscode.commands.executeCommand('gitsight.showCommitDetail', undefined, picked._sha);
}

function emptyOk(): PrePushMessageGateResult {
  return {
    decision: 'ok',
    summary: { totalCommits: 0, commitsWithErrors: 0, commitsWithWarnings: 0, totalProblems: 0, blocking: false },
    findings: [],
  };
}

async function safe(git: Git, args: string[]): Promise<string> {
  try { return await git.raw(args); } catch { return ''; }
}
