/**
 * Pure helpers for F116 - DCO Signed-off-by enforcement.
 *
 * Many open-source projects (Linux kernel, kubernetes, docker, the LLVM
 * project, ...) require every commit to carry a Developer Certificate
 * of Origin sign-off:
 *
 *   Signed-off-by: Jane Doe <jane@example.com>
 *
 * Detection sources (any one enough):
 *   - .github/CONTRIBUTING.md mentions DCO or `Signed-off-by`
 *   - CONTRIBUTING.md  (repo root variant)
 *   - DCO file at the repo root (the convention used by docker/k8s)
 *
 * This module provides the pure shape:
 *   - detectDcoRequirement(files): walks a candidate list returning
 *     a 4-state verdict (required / suggested / unknown / disabled).
 *   - hasSignoffTrailer(message, identity?): does the commit body
 *     carry a valid Signed-off-by line (optionally matching identity)?
 *   - composeSignoffLine(identity): produce the exact trailer line.
 *   - lintCommitMessageForDco(message, identity?): returns a list of
 *     problems suitable for surfacing via the SCM input box
 *     validator (mirrors commitLint.ts shape).
 *
 * Pure - no fs, no vscode, no child_process. Tests in
 * test/git/dcoSignoff.test.ts.
 */

export type DcoVerdict = 'required' | 'suggested' | 'unknown' | 'disabled';

export interface DcoSource {
  /** Repo-relative path of the file. */
  path: string;
  /** Body of the file, ascii / utf-8 only is fine - no parsing happens. */
  body: string;
}

export interface DcoRequirementResult {
  verdict: DcoVerdict;
  /** Which file triggered the verdict; undefined for `disabled` / `unknown`. */
  source?: string;
  /** Human-readable reason for the verdict (used in surface tooltips). */
  reason?: string;
}

const DCO_KEYWORD_REQUIRED = /\b(?:DCO|Developer Certificate of Origin)\b/i;
const SIGNOFF_MENTION = /Signed-off-by/i;
const REQUIRED_VERBS = /(?:require|require[sd]|mandate[sd]?|must|enforce[sd]?)\s+(?:.{0,80}?)(?:DCO|sign[- ]?off|Signed-off-by)/i;
const SUGGESTED_VERBS = /(?:prefer|recommended|encourage[sd]?|please)\s+(?:.{0,80}?)(?:DCO|sign[- ]?off|Signed-off-by)/i;

/**
 * Walk candidate files in priority order. The first file that fires
 * `required` wins; otherwise the first that fires `suggested`. If
 * NOTHING in any file mentions DCO/Signed-off-by, returns `unknown`.
 *
 * Special case: when a dedicated `DCO` text file exists at the root,
 * its presence ALONE is enough to mark the project as required - that's
 * the convention used by docker, kubernetes, and the linux kernel.
 */
export function detectDcoRequirement(files: DcoSource[]): DcoRequirementResult {
  // 1. DCO root file - strongest signal.
  const dcoFile = files.find(f => /^DCO(?:\.md|\.txt)?$/i.test(f.path));
  if (dcoFile) {
    return {
      verdict: 'required',
      source: dcoFile.path,
      reason: 'Repo carries a top-level DCO file - sign-off is mandatory.',
    };
  }

  // 2. CONTRIBUTING / governance files mentioning DCO with required verbs.
  let bestSuggested: DcoRequirementResult | undefined;
  for (const f of files) {
    const body = f.body ?? '';
    if (!body) continue;
    if (!DCO_KEYWORD_REQUIRED.test(body) && !SIGNOFF_MENTION.test(body)) continue;
    if (REQUIRED_VERBS.test(body)) {
      return {
        verdict: 'required',
        source: f.path,
        reason: `${f.path} requires DCO sign-off on every commit.`,
      };
    }
    if (SUGGESTED_VERBS.test(body) && !bestSuggested) {
      bestSuggested = {
        verdict: 'suggested',
        source: f.path,
        reason: `${f.path} mentions DCO/Signed-off-by as recommended.`,
      };
    } else if (!bestSuggested) {
      // Plain mention without an explicit verb still nudges to suggested.
      bestSuggested = {
        verdict: 'suggested',
        source: f.path,
        reason: `${f.path} references DCO/Signed-off-by.`,
      };
    }
  }
  return bestSuggested ?? { verdict: 'unknown' };
}

export interface SignoffIdentity {
  name: string;
  email: string;
}

const SIGNOFF_LINE_RE = /^Signed-off-by:\s+(.+?)\s+<([^>\s]+@[^>\s]+)>\s*$/im;

/**
 * Detect ANY Signed-off-by trailer in the message body. When an
 * identity is supplied, additionally require a case-insensitive email
 * match - that's the DCO contract (the committer's own sign-off, not
 * someone else's prior sign-off).
 */
export function hasSignoffTrailer(message: string, identity?: SignoffIdentity): boolean {
  if (!message) return false;
  const re = /^Signed-off-by:\s+(.+?)\s+<([^>\s]+@[^>\s]+)>\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    if (!identity) return true;
    const emailFound = m[2].trim().toLowerCase();
    const emailWanted = identity.email.trim().toLowerCase();
    if (emailFound === emailWanted) return true;
  }
  return false;
}

/**
 * Render the trailer line for an identity. Caller is responsible for
 * appending it to the message body (with the standard trailer block
 * conventions - blank line between body and first trailer).
 */
export function composeSignoffLine(identity: SignoffIdentity): string {
  const name = (identity.name ?? '').trim();
  const email = (identity.email ?? '').trim();
  if (!name || !email) return '';
  return `Signed-off-by: ${name} <${email}>`;
}

export interface DcoLintProblem {
  code: 'missing-signoff' | 'wrong-email-signoff';
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Lint a commit message for DCO compliance. Two failure shapes:
 *   - missing-signoff: no Signed-off-by trailer at all
 *   - wrong-email-signoff: there IS a sign-off but it's someone else's
 *     email (typical when amending a contributor's commit and forgetting
 *     to re-sign).
 *
 * Severity is decided by the caller via `severity` arg, defaulting to
 * `error` when the requirement is `required` and `warning` when
 * `suggested`.
 */
export function lintCommitMessageForDco(
  message: string,
  args: {
    identity?: SignoffIdentity;
    severity?: 'error' | 'warning';
  } = {},
): DcoLintProblem[] {
  const problems: DcoLintProblem[] = [];
  const severity = args.severity ?? 'warning';
  const identity = args.identity;

  const hasAny = hasSignoffTrailer(message);
  if (!hasAny) {
    problems.push({
      code: 'missing-signoff',
      severity,
      message: identity
        ? `Missing Signed-off-by trailer. Append: ${composeSignoffLine(identity)}`
        : 'Missing Signed-off-by trailer (DCO requirement).',
    });
    return problems;
  }
  if (identity && !hasSignoffTrailer(message, identity)) {
    problems.push({
      code: 'wrong-email-signoff',
      severity,
      message: `Signed-off-by present but email does not match the committing identity (${identity.email}). Add your own sign-off.`,
    });
  }
  return problems;
}

/**
 * Append a Signed-off-by trailer to a commit message, preserving the
 * existing trailer block. Returns the message unchanged when a matching
 * trailer is already present (no double-signing).
 *
 * Follows the same git-interpret-trailers convention as F73 commit
 * footer composer: blank line separates body from trailer block; same
 * trailer key appends inline to an existing trailer block.
 */
export function appendSignoffTrailer(message: string, identity: SignoffIdentity): string {
  const line = composeSignoffLine(identity);
  if (!line) return message;
  if (hasSignoffTrailer(message, identity)) return message;

  // Normalise to LF for consistent processing then re-emit LF.
  const normalised = (message ?? '').replace(/\r\n/g, '\n');
  if (!normalised.trim()) return line;

  const trimmedRight = normalised.replace(/\s+$/, '');
  // Detect existing trailer block: last non-empty line matches a
  // Key: value shape AND is preceded by a blank line OR is the only
  // line below the subject.
  const lines = trimmedRight.split('\n');
  const lastIdx = lines.length - 1;
  let lastNonEmpty = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) { lastNonEmpty = lines[i]; break; }
  }
  const isTrailerShape = /^[A-Za-z][A-Za-z0-9-]*:\s+\S/.test(lastNonEmpty);
  if (isTrailerShape && lines.length >= 3) {
    // Find blank line before the trailer block.
    let blankBeforeIdx = lastIdx - 1;
    while (blankBeforeIdx >= 0 && lines[blankBeforeIdx].length > 0) blankBeforeIdx--;
    if (blankBeforeIdx >= 0 && blankBeforeIdx !== lastIdx - 1) {
      // Trailer block exists with multiple lines; append without blank.
      return `${trimmedRight}\n${line}`;
    }
    if (blankBeforeIdx >= 0) {
      // Single existing trailer; append directly.
      return `${trimmedRight}\n${line}`;
    }
  }
  // No trailer block yet - body needs a blank line before the trailer.
  return `${trimmedRight}\n\n${line}`;
}

/**
 * Standard list of candidate filenames to check for the DCO requirement.
 * Order matters: dedicated DCO file wins over CONTRIBUTING mentions.
 */
export const DCO_CANDIDATE_FILES: string[] = [
  'DCO',
  'DCO.md',
  'DCO.txt',
  'CONTRIBUTING.md',
  'CONTRIBUTING',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
];
