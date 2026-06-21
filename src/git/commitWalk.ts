/**
 * Pure helpers for the Commit-by-Commit Test Runner (F55).
 *
 * Given a list of commits in `<upstream>..HEAD` (newest first as `git log`
 * emits) and a series of per-commit `RunResult`s, build:
 *   - the order to walk (oldest \u2192 newest, so bisection-style failure
 *     bracketing reads naturally)
 *   - a summary that flags the first failing commit (the bisect candidate)
 *   - a markdown report suitable for a scratch document
 *
 * Pure \u2014 no vscode, no child_process. Tests in test/git/commitWalk.test.ts.
 */

export type RunStatus = 'pass' | 'fail' | 'skipped' | 'error' | 'not-run';

export interface RawCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author?: string;
  authorEmail?: string;
}

export interface RunResult {
  sha: string;
  status: RunStatus;
  /** Exit code from the test command; undefined for skipped/not-run. */
  exitCode?: number;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Last ~50 lines of stderr+stdout, trimmed; for the report footer. */
  tail?: string;
  /** Reason for skip/error (e.g. "checkout failed: dirty working tree"). */
  reason?: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  notRun: number;
  /**
   * The oldest commit that failed \u2014 i.e. the first commit (in oldest-first
   * order) whose status is "fail". This is the bisect candidate.
   */
  firstFailingSha?: string;
  /** The commit that "broke" things: the failing one immediately after a pass. */
  bisectSha?: string;
}

/**
 * Parse the same `<sha>|<shortSha>|<author>|<email>|<subject>` log format
 * we use elsewhere in the project.
 */
export function parseWalkLog(raw: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const line of (raw ?? '').split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [sha, shortSha, author, authorEmail, ...rest] = parts;
    out.push({
      sha,
      shortSha,
      author: author || undefined,
      authorEmail: authorEmail || undefined,
      subject: rest.join('|'),
    });
  }
  return out;
}

/**
 * Reverse the git log order so the walker runs oldest \u2192 newest. This
 * matches how a user reads a list ("things that have piled up since
 * upstream"), and so the "first failing" report points at the *earliest*
 * regression rather than the latest commit.
 */
export function walkOrder(commits: RawCommit[]): RawCommit[] {
  return [...commits].reverse();
}

/**
 * Roll a list of run results into a summary, picking out the bisect
 * candidate (the first failing commit that comes after at least one pass).
 *
 * Results MUST be passed in the same order as the walk (oldest first).
 */
export function summariseRun(results: RunResult[]): RunSummary {
  const s: RunSummary = {
    total: results.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    notRun: 0,
  };
  let seenPass = false;
  for (const r of results) {
    switch (r.status) {
      case 'pass':    s.passed++; seenPass = true; break;
      case 'fail':    s.failed++; if (!s.firstFailingSha) s.firstFailingSha = r.sha; if (seenPass && !s.bisectSha) s.bisectSha = r.sha; break;
      case 'skipped': s.skipped++; break;
      case 'error':   s.errored++; break;
      case 'not-run': s.notRun++; break;
    }
  }
  return s;
}

/**
 * Render the results + summary into a Markdown report. Keep the layout
 * close to `git bisect log` so users who've done a manual bisect feel at
 * home.
 */
export function renderReport(
  commits: RawCommit[],
  results: RunResult[],
  args: { upstream: string; head: string; command: string },
): string {
  const summary = summariseRun(results);
  const byShortSha = new Map<string, RunResult>(results.map(r => {
    const shortMatch = commits.find(c => c.sha === r.sha);
    return [shortMatch ? shortMatch.shortSha : r.sha.slice(0, 7), r];
  }));

  const lines: string[] = [];
  lines.push(`# Commit-by-commit test run \u2014 \`${args.upstream}..${args.head}\``);
  lines.push('');
  lines.push(`**Command**: \`${args.command}\``);
  lines.push('');
  lines.push(`**Result**: ${summary.passed} pass \u00b7 ${summary.failed} fail \u00b7 ` +
    `${summary.errored} error \u00b7 ${summary.skipped} skipped \u00b7 ${summary.notRun} not run`);
  if (summary.bisectSha) {
    const bisectShort = (commits.find(c => c.sha === summary.bisectSha)?.shortSha) ?? summary.bisectSha.slice(0, 7);
    lines.push('');
    lines.push(`**Likely culprit**: \`${bisectShort}\` \u2014 first failing commit after a passing one.`);
  } else if (summary.firstFailingSha) {
    const ffShort = (commits.find(c => c.sha === summary.firstFailingSha)?.shortSha) ?? summary.firstFailingSha.slice(0, 7);
    lines.push('');
    lines.push(`**First failing commit**: \`${ffShort}\` \u2014 no passing commit before it in this range, so the regression may be older.`);
  }
  lines.push('');
  lines.push('| Status | Commit | Subject | Time | Notes |');
  lines.push('| ------ | ------ | ------- | ----:| ----- |');
  for (const c of commits) {
    const r = byShortSha.get(c.shortSha) ?? { sha: c.sha, status: 'not-run' as RunStatus };
    lines.push(`| ${statusGlyph(r.status)} ${r.status} | \`${c.shortSha}\` | ${escape(c.subject)} | ${r.durationMs !== undefined ? formatMs(r.durationMs) : '\u2014'} | ${reasonOrCode(r)} |`);
  }
  // Detail blocks for each failure (last 50 lines of output)
  const failures = results.filter(r => r.status === 'fail' || r.status === 'error');
  if (failures.length) {
    lines.push('');
    lines.push('## Failure details');
    for (const r of failures) {
      const commit = commits.find(c => c.sha === r.sha);
      lines.push('');
      lines.push(`### \`${commit?.shortSha ?? r.sha.slice(0, 7)}\` \u2014 ${commit ? escape(commit.subject) : '(commit not in range)'}`);
      lines.push(`exit ${r.exitCode ?? '?'} after ${r.durationMs !== undefined ? formatMs(r.durationMs) : '?'}`);
      if (r.reason) {
        lines.push('');
        lines.push(`> ${escape(r.reason)}`);
      }
      if (r.tail) {
        lines.push('');
        lines.push('```');
        lines.push(r.tail);
        lines.push('```');
      }
    }
  }
  return lines.join('\n');
}

function statusGlyph(s: RunStatus): string {
  switch (s) {
    case 'pass':    return '\u2713';
    case 'fail':    return '\u2717';
    case 'skipped': return '~';
    case 'error':   return '!';
    case 'not-run': return '.';
  }
}

function reasonOrCode(r: RunResult): string {
  if (r.reason) return escape(r.reason);
  if (r.exitCode !== undefined && r.exitCode !== 0) return `exit ${r.exitCode}`;
  return '';
}

function escape(s: string): string {
  return (s ?? '').replace(/\|/g, '\\|');
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/**
 * Keep only the last N lines of a (potentially massive) test-output blob.
 * The runner pipes both stderr and stdout into this and we surface them
 * in the report so the user has enough breadcrumbs to start debugging
 * without re-running.
 */
export function tailLines(raw: string, n: number): string {
  if (!raw) return '';
  // Drop a single trailing newline so "a\nb\nc\n" reads as 3 lines, not 4.
  const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const lines = trimmed.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n').trimEnd();
}
