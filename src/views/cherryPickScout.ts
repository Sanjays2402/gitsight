/**
 * Cherry-Pick Scout (F65) — wraps the existing `gitsight.cherryPick`
 * command with a pre-check that looks for a same-subject-shape commit
 * already on the current branch and, when one is found, surfaces a
 * modal warning with the candidate so the user can abort the
 * double-pick mistake.
 *
 * The original cherryPick command stays available unchanged — this
 * wrapper just adds an opt-out (configurable) safety net for the
 * common case where someone hand-cherry-picked the same commit on
 * a release branch and then tries to pick it again from main.
 *
 * Configurable via:
 *   gitsight.cherryPickScout.enabled        (default true)
 *   gitsight.cherryPickScout.scanCommits    (default 200)
 *   gitsight.cherryPickScout.scanSince      (default "180.days") — git
 *                                            log --since argument; covers
 *                                            release-branch backports
 *                                            without scanning the whole
 *                                            repo
 */
import * as vscode from 'vscode';
import { Git } from '../git/git';
import {
  findAlreadyPicked,
  parseLogRecords,
  warningHeadline,
  describeMatch,
  RecentCommit,
} from '../git/cherryPickScout';

interface PickArgs {
  /** The Git wrapper for the repo the source commit lives in. */
  git: Git;
  /** The commit being cherry-picked. */
  commit: {
    sha: string;
    shortSha: string;
    subject: string;
    author?: string;
  };
  /** Optional callback to run the actual cherry-pick — defaults to git.cherryPick. */
  runPick?: () => Promise<void>;
}

export async function scoutAndCherryPick(args: PickArgs): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gitsight.cherryPickScout');
  const enabled = cfg.get<boolean>('enabled', true) ?? true;
  const scanCommits = clamp(cfg.get<number>('scanCommits', 200) ?? 200, 10, 5000);
  const scanSince = cfg.get<string>('scanSince', '180.days') ?? '180.days';

  if (!enabled) {
    await runPick(args);
    return;
  }

  const verdict = await scout(args.git, args.commit, scanCommits, scanSince);
  if (!verdict.alreadyPicked) {
    await runPick(args);
    return;
  }

  // Surface the modal warning with the strongest match.
  const topMatch = verdict.matches[0];
  const detail = verdict.matches.slice(0, 3).map(m => `\u2022 ${describeMatch(m)}`).join('\n');
  const more = verdict.matches.length > 3 ? `\n\u2026and ${verdict.matches.length - 3} more.` : '';
  const headline = warningHeadline(args.commit, verdict);
  const choice = await vscode.window.showWarningMessage(
    headline,
    {
      modal: true,
      detail: `Top match${verdict.matches.length === 1 ? '' : 'es'}:\n${detail}${more}\n\nPick anyway will run git cherry-pick regardless.`,
    },
    'Pick anyway',
    'Show top match',
  );
  if (choice === 'Show top match') {
    await vscode.commands.executeCommand('gitsight.showCommitDetail', args.git, topMatch.sha);
    return;
  }
  if (choice === 'Pick anyway') {
    await runPick(args);
    return;
  }
  // Cancelled.
}

async function runPick(args: PickArgs): Promise<void> {
  if (args.runPick) {
    await args.runPick();
  } else {
    await args.git.cherryPick(args.commit.sha);
  }
  vscode.window.setStatusBarMessage(
    `GitSight: cherry-picked ${args.commit.shortSha}.`,
    3000,
  );
}

async function scout(
  git: Git,
  source: { sha: string; subject: string },
  scanCommits: number,
  scanSince: string,
): Promise<ReturnType<typeof findAlreadyPicked>> {
  const recent = await loadRecentCommits(git, scanCommits, scanSince);
  return findAlreadyPicked(source, recent);
}

async function loadRecentCommits(git: Git, scanCommits: number, scanSince: string): Promise<RecentCommit[]> {
  try {
    const raw = await git.raw([
      'log',
      `-n`,
      String(scanCommits),
      `--since=${scanSince}`,
      `--pretty=format:%H|%h|%an|%aI|%s%n%b%n--RECORD--`,
      'HEAD',
    ]);
    return parseLogRecords(raw);
  } catch {
    return [];
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
