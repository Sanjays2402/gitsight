/**
 * Pure helpers for the Pre-Push Commit-Message Gate (F69).
 *
 * The F14 pre-push lint already catches WIP/fixup subjects and embedded
 * conflict markers. What it DOESN'T catch is "this commit subject is 200
 * characters long" or "the body lines aren't wrapped" — exactly the
 * style problems the F21 commit-message linter (`lintCommitMessage`)
 * surfaces in the SCM input box during composing.
 *
 * This module reuses `lintCommitMessage` against the FULL message
 * (subject + body) for each commit in the to-push range, aggregates the
 * results, and decides whether to block the push based on a
 * configurable severity floor.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/prePushMessageGate.test.ts.
 */

import { lintCommitMessage, LintOptions, LintProblem, LintSeverity } from './commitLint';

export interface PrePushCommitMessage {
  sha: string;
  shortSha: string;
  subject: string;
  /** Full commit message (subject + blank line + body). */
  message: string;
}

export interface CommitGateFinding {
  sha: string;
  shortSha: string;
  subject: string;
  problems: LintProblem[];
  /** Highest severity in the problem list. */
  topSeverity: LintSeverity;
}

export interface CommitGateSummary {
  totalCommits: number;
  commitsWithErrors: number;
  commitsWithWarnings: number;
  totalProblems: number;
  /** True when at least one commit has problems at or above `blockAt`. */
  blocking: boolean;
}

export type GateBlockLevel = 'error' | 'warning' | 'never';

/**
 * Lint every commit's message. Returns one finding per *commit that has
 * problems* — commits with clean messages are dropped from the output
 * (the summary still counts them in totalCommits).
 *
 * The lint options thread through unchanged so the gate behaves
 * identically to the SCM input-box validator.
 */
export function lintCommitMessages(
  commits: PrePushCommitMessage[],
  options: LintOptions = {},
): CommitGateFinding[] {
  const out: CommitGateFinding[] = [];
  for (const c of commits) {
    const problems = lintCommitMessage(c.message, options);
    if (!problems.length) continue;
    const topSeverity: LintSeverity =
      problems.some(p => p.severity === 'error') ? 'error' : 'warning';
    out.push({
      sha: c.sha,
      shortSha: c.shortSha,
      subject: c.subject,
      problems,
      topSeverity,
    });
  }
  return out;
}

export function summariseCommitGate(
  findings: CommitGateFinding[],
  totalCommits: number,
  blockAt: GateBlockLevel,
): CommitGateSummary {
  let withErrors = 0;
  let withWarnings = 0;
  let totalProblems = 0;
  for (const f of findings) {
    if (f.topSeverity === 'error') withErrors++;
    else withWarnings++;
    totalProblems += f.problems.length;
  }
  const blocking =
    blockAt === 'never'
      ? false
      : blockAt === 'error'
        ? withErrors > 0
        : withErrors > 0 || withWarnings > 0;
  return {
    totalCommits,
    commitsWithErrors: withErrors,
    commitsWithWarnings: withWarnings,
    totalProblems,
    blocking,
  };
}

/**
 * One-line headline for the controller's modal/toast.
 *   "3 commits have message issues (2 errors, 1 warning)"
 */
export function describeCommitGate(summary: CommitGateSummary): string {
  const flagged = summary.commitsWithErrors + summary.commitsWithWarnings;
  if (flagged === 0) return 'all commit messages clean';
  const word = flagged === 1 ? 'commit has' : 'commits have';
  const bits: string[] = [];
  if (summary.commitsWithErrors) bits.push(`${summary.commitsWithErrors} error${summary.commitsWithErrors === 1 ? '' : 's'}`);
  if (summary.commitsWithWarnings) bits.push(`${summary.commitsWithWarnings} warning${summary.commitsWithWarnings === 1 ? '' : 's'}`);
  return `${flagged} ${word} message issues (${bits.join(', ')})`;
}

/**
 * Parse stdout from:
 *
 *   git log <range> --pretty=format:'<SHA>%n<SHORTSHA>%n<SUBJECT>%n<BODY>%x1e'
 *
 * where %x1e is the ASCII record separator. The subject is the first
 * non-blank line after the short-sha and the body is everything until
 * the record separator (joined with newlines).
 *
 * We keep the parsing simple and explicit — the regex-based parsers in
 * other modules get gnarly when the subject contains `|` or other
 * separators.
 */
export function parseCommitMessageLog(raw: string): PrePushCommitMessage[] {
  if (!raw) return [];
  const records = raw.split('\x1e');
  const out: PrePushCommitMessage[] = [];
  for (const rec of records) {
    const trimmed = rec.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    if (lines.length < 3) continue;
    const sha = lines[0];
    const shortSha = lines[1];
    const subject = lines[2];
    const body = lines.slice(3).join('\n');
    const message = body ? `${subject}\n\n${body}` : subject;
    out.push({ sha, shortSha, subject, message });
  }
  return out;
}
