/**
 * Pure linter for commit messages — used by the SCM input box validator.
 *
 * Rules (each one is independently toggleable in config):
 *   - subjectTooLong: subject line longer than maxSubjectLength (default 72).
 *   - subjectEndsWithPeriod: subject ends with a `.` (Conventional Commits).
 *   - subjectStartsLower: subject starts with a lowercase letter (unless the
 *     first token looks like a Conventional Commits type like `feat:`).
 *   - bodyLineTooLong: any body line longer than maxBodyLength (default 100).
 *   - trailingWhitespace: any line ends in whitespace.
 *   - missingBlankLineAfterSubject: second line is non-empty.
 *   - missingBody: subject ends in `:` but no body follows.
 *   - wipPrefix: subject starts with WIP, fixup!, or squash!.
 *
 * Severity buckets:
 *   - error: blocks the commit-time validator (the SCM input box marks the row red).
 *   - warning: shown as a warning row in the box (still commits).
 *
 * No vscode / no child_process — pure.
 */

export type LintSeverity = 'error' | 'warning';

export interface LintProblem {
  code: string;
  severity: LintSeverity;
  /** 0-based line number in the original message. */
  line: number;
  message: string;
}

export interface LintOptions {
  maxSubjectLength?: number;     // default 72
  maxBodyLength?: number;        // default 100
  requireBlankLineAfterSubject?: boolean; // default true
  warnTrailingWhitespace?: boolean;       // default true
  warnLowercaseSubject?: boolean;         // default false
  warnSubjectPeriod?: boolean;            // default true
  warnWipPrefix?: boolean;                // default true
  warnMissingBody?: boolean;              // default true
}

const CC_TYPE_PREFIX = /^[a-z]+(\([^)]+\))?!?:\s/;

export function lintCommitMessage(message: string, opts: LintOptions = {}): LintProblem[] {
  const {
    maxSubjectLength = 72,
    maxBodyLength = 100,
    requireBlankLineAfterSubject = true,
    warnTrailingWhitespace = true,
    warnLowercaseSubject = false,
    warnSubjectPeriod = true,
    warnWipPrefix = true,
    warnMissingBody = true,
  } = opts;

  const problems: LintProblem[] = [];
  if (!message || !message.trim()) return problems;

  // Treat \r\n as \n for consistent indexing.
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const subject = lines[0] ?? '';

  // Subject rules
  if (subject.length > maxSubjectLength) {
    problems.push({
      code: 'subjectTooLong',
      severity: 'error',
      line: 0,
      message: `Subject is ${subject.length} chars (max ${maxSubjectLength}).`,
    });
  }
  if (warnSubjectPeriod && /[.!?]$/.test(subject)) {
    problems.push({
      code: 'subjectEndsWithPunct',
      severity: 'warning',
      line: 0,
      message: 'Subject should not end with punctuation.',
    });
  }
  if (warnLowercaseSubject && subject && /^[a-z]/.test(subject) && !CC_TYPE_PREFIX.test(subject)) {
    problems.push({
      code: 'subjectStartsLower',
      severity: 'warning',
      line: 0,
      message: 'Subject should start with a capital letter (or a Conventional Commits type).',
    });
  }
  if (warnWipPrefix && /^(wip\b|fixup!|squash!|amend!)/i.test(subject)) {
    problems.push({
      code: 'wipPrefix',
      severity: 'error',
      line: 0,
      message: 'Refusing to commit a WIP / fixup! / squash! message.',
    });
  }

  // Blank line between subject and body
  if (requireBlankLineAfterSubject && lines.length >= 2 && lines[1].length > 0) {
    problems.push({
      code: 'missingBlankLine',
      severity: 'warning',
      line: 1,
      message: 'Leave a blank line between the subject and body.',
    });
  }

  // Subject ends with colon → expect a body
  if (warnMissingBody && /:\s*$/.test(subject)) {
    const body = lines.slice(1).join('\n').trim();
    if (!body) {
      problems.push({
        code: 'missingBody',
        severity: 'warning',
        line: 0,
        message: 'Subject ends with ":" — add a body explaining the change.',
      });
    }
  }

  // Body rules
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length > maxBodyLength) {
      problems.push({
        code: 'bodyLineTooLong',
        severity: 'warning',
        line: i,
        message: `Body line ${i + 1} is ${raw.length} chars (recommend wrapping at ${maxBodyLength}).`,
      });
    }
    if (warnTrailingWhitespace && /[ \t]+$/.test(raw)) {
      problems.push({
        code: 'trailingWhitespace',
        severity: 'warning',
        line: i,
        message: `Line ${i + 1} has trailing whitespace.`,
      });
    }
  }

  if (warnTrailingWhitespace && /[ \t]+$/.test(subject)) {
    problems.push({
      code: 'trailingWhitespace',
      severity: 'warning',
      line: 0,
      message: 'Subject has trailing whitespace.',
    });
  }

  return problems;
}

/** Highest severity among a list of problems, or `undefined` when empty. */
export function topSeverity(problems: LintProblem[]): LintSeverity | undefined {
  if (!problems.length) return undefined;
  return problems.some(p => p.severity === 'error') ? 'error' : 'warning';
}

/** One-line summary used for status-bar tooltips / VS Code validation. */
export function summariseProblems(problems: LintProblem[]): string {
  if (!problems.length) return 'Commit message looks good.';
  const errs = problems.filter(p => p.severity === 'error').length;
  const warns = problems.filter(p => p.severity === 'warning').length;
  const parts: string[] = [];
  if (errs) parts.push(`${errs} error${errs === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  return parts.join(', ');
}
