/**
 * Pure helpers for the SCM Pre-Commit-Message Scaffold (F60).
 *
 * Given the list of staged file paths, decide whether to scaffold a
 * conventional-commit header into an empty SCM input box. Reuses the
 * existing suggestType + suggestScope helpers (F29) so the policy stays
 * consistent across the Quick-Insert command and the auto-scaffold.
 *
 * Decision rules (all must hold):
 *   1. No header is scaffolded when the input already contains text.
 *   2. There must be at least one staged path (we don't scaffold on a
 *      bare staging area).
 *   3. The number of staged paths must not exceed maxPathsForScaffold
 *      (default 8). Bigger stagings are usually multi-concern and the
 *      user should write the message themselves.
 *   4. suggestType + suggestScope must both produce a non-default answer.
 *      We never scaffold `feat()` with no scope — that's noise.
 *
 * Pure — no vscode, no child_process. Tests in
 * test/git/commitScaffold.test.ts.
 */
import { suggestType, suggestScope } from './conventionalCommit';

export interface ScaffoldDecision {
  /** True when the caller should write the header to the input box. */
  shouldScaffold: boolean;
  /** Composed header text (without trailing colon-space or subject). */
  header?: string;
  /** Reason for not scaffolding (debug / telemetry). */
  reason?: ScaffoldSkipReason;
}

export type ScaffoldSkipReason =
  | 'input-not-empty'
  | 'no-staged-paths'
  | 'too-many-paths'
  | 'low-confidence'
  | 'no-scope'
  | 'opted-out';

export interface ScaffoldInputs {
  /** Current SCM input box value. */
  inputValue: string;
  /** Repo-relative staged paths. */
  stagedPaths: string[];
  /** Max number of staged paths we'll scaffold against (default 8). */
  maxPathsForScaffold?: number;
  /** Minimum confidence from suggestType to trigger scaffold (default 0.7). */
  minTypeConfidence?: number;
  /**
   * When true, scaffold even when suggestScope returns undefined. Default
   * false because a `feat:` scaffold without a scope is just noise.
   */
  scaffoldWithoutScope?: boolean;
  /** User-provided opt-out toggle (the master enable). Defaults to true. */
  enabled?: boolean;
}

export function decideScaffold(args: ScaffoldInputs): ScaffoldDecision {
  if (args.enabled === false) return { shouldScaffold: false, reason: 'opted-out' };
  if ((args.inputValue ?? '').trim().length > 0) {
    return { shouldScaffold: false, reason: 'input-not-empty' };
  }
  if (!args.stagedPaths || args.stagedPaths.length === 0) {
    return { shouldScaffold: false, reason: 'no-staged-paths' };
  }
  const cap = args.maxPathsForScaffold ?? 8;
  if (args.stagedPaths.length > cap) {
    return { shouldScaffold: false, reason: 'too-many-paths' };
  }
  const minConfidence = args.minTypeConfidence ?? 0.7;
  const { type, confidence } = suggestType(args.stagedPaths);
  if (confidence < minConfidence) {
    return { shouldScaffold: false, reason: 'low-confidence' };
  }
  const scope = suggestScope(args.stagedPaths);
  if (!scope && !args.scaffoldWithoutScope) {
    return { shouldScaffold: false, reason: 'no-scope' };
  }
  return {
    shouldScaffold: true,
    header: composeScaffoldHeader(type, scope),
  };
}

/**
 * Compose the header prefix the caller will write to the SCM input box.
 *
 *   composeScaffoldHeader('feat', 'git')   -> 'feat(git): '
 *   composeScaffoldHeader('docs', undef)   -> 'docs: '
 *   composeScaffoldHeader('docs', 'docs')  -> 'docs: '  (redundant scope dropped)
 *
 * Trailing single space is intentional — the user's cursor lands right
 * where they need to type the subject.
 */
export function composeScaffoldHeader(type: string, scope?: string): string {
  const cleanScope = (scope ?? '').trim();
  // Suppress scope when it's a redundant restatement of the type. This
  // collapses e.g. `docs(docs): ` and `ci(ci): ` to the cleaner short
  // form. Comparison is case-insensitive to be safe — the suggester
  // emits lowercase already, but human-overridden configs may not.
  if (cleanScope && cleanScope.toLowerCase() !== type.toLowerCase()) {
    return `${type}(${cleanScope}): `;
  }
  return `${type}: `;
}

/**
 * Detect whether the current input value LOOKS LIKE one of our scaffolds —
 * either the exact header (no subject yet) OR the header with the user's
 * subject appended but no body. Used by the controller to know whether
 * an out-of-band edit was the user's text or our scaffold lying dormant.
 *
 * Format match (loose, case-sensitive on the type):
 *   <type>(<scope>):  ...    OR    <type>: ...
 */
const HEADER_RE = /^([a-z]+)(?:\(([^)]+)\))?:\s/;

export function isScaffoldShaped(value: string): { type: string; scope?: string; subjectLength: number } | undefined {
  if (!value) return undefined;
  const first = value.split('\n')[0];
  const m = HEADER_RE.exec(first);
  if (!m) return undefined;
  const [, type, scope] = m;
  return {
    type,
    scope: scope || undefined,
    subjectLength: first.length - m[0].length,
  };
}

/**
 * Compare two staging fingerprints to decide whether a rescaffold is
 * warranted. Returns true when the set of staged paths changed in any
 * way (add, remove, rename) — the fingerprint is a sorted-joined string
 * for cheap equality.
 */
export function stagingChanged(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) return true;
  const a = [...prev].sort();
  const b = [...next].sort();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}
