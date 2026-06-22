/**
 * Pure helpers for the PR checkout pre-flight (F101).
 *
 * Extends F75 prReviewInbox: when the user picks a review-requested
 * PR, instead of going straight to `gh pr checkout`, run a battery
 * of safety checks first and present the results as a pre-flight
 * report. The user can then decide whether to proceed.
 *
 * Checks (each one is a pure classifier; the view layer wires them
 * to actual git/gh commands):
 *
 *   1. Origin match    — does the workspace clone's origin match the
 *                        PR's repository? (Already enforced by F75;
 *                        this duplicates the rule for our verdict.)
 *   2. Working tree    — is the current branch clean? Dirty checkouts
 *                        either fail or trigger an auto-stash; we
 *                        want to warn first.
 *   3. Branch exists   — is the PR's headRefName already present
 *                        locally? If so we'd switch instead of fetch.
 *   4. Base divergence — has the base branch moved since the PR was
 *                        created? (Stale-against-base detection helps
 *                        the reviewer know they'll see merge-resolved
 *                        diffs.)
 *   5. Conflict risk   — would the PR's changeset conflict with any
 *                        of the user's recent commits on the current
 *                        branch? (Heuristic: per-file overlap, not a
 *                        full 3-way merge probe.)
 *
 * The aggregate verdict is one of:
 *   - clear:    no blockers; checkout is safe.
 *   - caution:  non-blocking warnings (dirty tree, base diverged,
 *               file overlap with recent commits).
 *   - blocked:  a hard refusal (origin mismatch, conflict-prone
 *               overlap that the user should review first).
 *
 * Pure - no vscode, no child_process. Tests in test/git/prCheckoutPreflight.test.ts.
 */

export type PreflightSeverity = 'ok' | 'warning' | 'error';

export type PreflightVerdict = 'clear' | 'caution' | 'blocked';

export interface PreflightCheck {
  id: string;
  /** Display title - keep < 60 chars. */
  title: string;
  severity: PreflightSeverity;
  /** Human explanation, suitable for a markdown bullet. */
  message: string;
  /** Optional remediation hint. */
  hint?: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  verdict: PreflightVerdict;
  /** Convenience: counts of severity tiers. */
  counts: { ok: number; warning: number; error: number };
}

/**
 * Aggregate a verdict from a list of checks.
 *
 *   - any check at 'error'    -> blocked
 *   - any check at 'warning'  -> caution
 *   - all 'ok'                -> clear
 */
export function aggregateVerdict(checks: PreflightCheck[]): PreflightVerdict {
  if (checks.some(c => c.severity === 'error')) return 'blocked';
  if (checks.some(c => c.severity === 'warning')) return 'caution';
  return 'clear';
}

export function summariseChecks(checks: PreflightCheck[]): PreflightReport {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const c of checks) counts[c.severity]++;
  return { checks, verdict: aggregateVerdict(checks), counts };
}

/**
 * Origin-match check. `localSlug` is the workspace's origin in
 * `org/repo` form (or undefined when not a GitHub remote); `prSlug`
 * is the PR's `repository.nameWithOwner`.
 */
export function checkOriginMatch(localSlug: string | undefined, prSlug: string): PreflightCheck {
  if (!localSlug) {
    return {
      id: 'origin-match',
      title: 'Origin match',
      severity: 'error',
      message: 'Workspace clone does not have a GitHub origin remote.',
      hint: 'Open this PR in your browser instead, or clone the right repo first.',
    };
  }
  if (localSlug.toLowerCase() !== prSlug.toLowerCase()) {
    return {
      id: 'origin-match',
      title: 'Origin match',
      severity: 'error',
      message: `Workspace origin (${localSlug}) doesn't match PR repo (${prSlug}).`,
      hint: '`gh pr checkout` would land the wrong branch in this clone. Open in browser instead.',
    };
  }
  return {
    id: 'origin-match',
    title: 'Origin match',
    severity: 'ok',
    message: `Workspace clone matches ${prSlug}.`,
  };
}

/**
 * Working-tree cleanliness. `dirtyPaths` is the count of unstaged
 * changes (from `git status --porcelain`). Pass 0 when clean.
 */
export function checkWorkingTree(dirtyPaths: number): PreflightCheck {
  if (dirtyPaths === 0) {
    return {
      id: 'working-tree',
      title: 'Working tree',
      severity: 'ok',
      message: 'Working tree is clean - safe to switch branches.',
    };
  }
  return {
    id: 'working-tree',
    title: 'Working tree',
    severity: 'warning',
    message: `${dirtyPaths} unstaged change${dirtyPaths === 1 ? '' : 's'} in the current tree.`,
    hint: 'GitSight will auto-stash before the checkout (composes with F48). Or commit/discard first.',
  };
}

/**
 * Branch-already-present check. When the head branch is already in
 * the local refs, `gh pr checkout` will fast-forward rather than
 * fetch - usually fine but worth surfacing.
 */
export function checkBranchAlreadyLocal(headRefName: string, localBranches: string[]): PreflightCheck {
  const exists = localBranches.includes(headRefName);
  if (!exists) {
    return {
      id: 'branch-local',
      title: 'Local branch',
      severity: 'ok',
      message: `No local branch named "${headRefName}" - gh will fetch it fresh.`,
    };
  }
  return {
    id: 'branch-local',
    title: 'Local branch',
    severity: 'warning',
    message: `Local branch "${headRefName}" already exists - gh will fast-forward or refuse.`,
    hint: 'Confirm the local branch matches the PR head (no detached local commits) before continuing.',
  };
}

/**
 * Base-divergence check. `behindBy` and `aheadBy` come from
 * `git rev-list --left-right --count <base>...origin/<base>`. When
 * the base has moved on the remote but locally we still point at
 * the older sha, surface it.
 */
export function checkBaseDivergence(baseRefName: string, behindBy: number, aheadBy: number): PreflightCheck {
  if (behindBy === 0) {
    return {
      id: 'base-divergence',
      title: 'Base alignment',
      severity: 'ok',
      message: `Local "${baseRefName}" is up-to-date with origin.`,
    };
  }
  return {
    id: 'base-divergence',
    title: 'Base alignment',
    severity: 'warning',
    message: `Local "${baseRefName}" is ${behindBy} commit${behindBy === 1 ? '' : 's'} behind origin (you have ${aheadBy} local).`,
    hint: 'You may see merge-resolved differences that aren\u2019t in the PR. Pull base first for an accurate review.',
  };
}

/**
 * Conflict-risk check. `overlappingFiles` is the count of files the
 * PR touches that also appear in the user's last N commits on the
 * current branch. This is a heuristic - it does NOT prove a real
 * merge conflict but flags when overlap is high.
 */
export function checkConflictRisk(overlappingFiles: number, prTotalFiles: number): PreflightCheck {
  if (overlappingFiles === 0) {
    return {
      id: 'conflict-risk',
      title: 'Conflict risk',
      severity: 'ok',
      message: 'PR touches no files you\u2019ve recently changed.',
    };
  }
  const ratio = prTotalFiles > 0 ? overlappingFiles / prTotalFiles : 0;
  if (ratio < 0.25) {
    return {
      id: 'conflict-risk',
      title: 'Conflict risk',
      severity: 'warning',
      message: `${overlappingFiles} of ${prTotalFiles} PR file${prTotalFiles === 1 ? '' : 's'} overlap with your recent changes.`,
      hint: 'Low overlap - probably fine. Skim the listed files before approving.',
    };
  }
  return {
    id: 'conflict-risk',
    title: 'Conflict risk',
    severity: 'error',
    message: `${overlappingFiles} of ${prTotalFiles} PR file${prTotalFiles === 1 ? '' : 's'} overlap with your recent changes (${Math.round(ratio * 100)}%).`,
    hint: 'High overlap. Switch out of WIP first, or expect merge-resolution work.',
  };
}

/**
 * Compose all five checks into a single report. Caller supplies the
 * pre-computed inputs; this stays pure.
 */
export interface PreflightInputs {
  localSlug: string | undefined;
  prSlug: string;
  dirtyPaths: number;
  headRefName: string;
  baseRefName: string;
  localBranches: string[];
  baseBehindBy: number;
  baseAheadBy: number;
  overlappingFiles: number;
  prTotalFiles: number;
}

export function runPreflight(inputs: PreflightInputs): PreflightReport {
  const checks: PreflightCheck[] = [
    checkOriginMatch(inputs.localSlug, inputs.prSlug),
    checkWorkingTree(inputs.dirtyPaths),
    checkBranchAlreadyLocal(inputs.headRefName, inputs.localBranches),
    checkBaseDivergence(inputs.baseRefName, inputs.baseBehindBy, inputs.baseAheadBy),
    checkConflictRisk(inputs.overlappingFiles, inputs.prTotalFiles),
  ];
  return summariseChecks(checks);
}

/**
 * Render the report as a one-line summary suitable for the picker
 * placeholder, e.g.:
 *
 *   "Pre-flight: 2 warnings - dirty tree, base behind 3"
 */
export function describeReport(report: PreflightReport): string {
  const issues = report.checks.filter(c => c.severity !== 'ok');
  if (!issues.length) return 'Pre-flight: clear';
  const tier = report.verdict === 'blocked' ? 'blocked' :
               report.counts.warning === 1 ? '1 warning' :
               `${report.counts.warning} warning${report.counts.warning === 1 ? '' : 's'}`;
  return `Pre-flight: ${tier} - ${issues.map(c => c.title.toLowerCase()).join(', ')}`;
}

/**
 * Render the report as full markdown for a scratch buffer preview.
 */
export function renderPreflightMarkdown(prDisplay: string, report: PreflightReport): string {
  const lines: string[] = [];
  lines.push(`# Pre-flight: ${prDisplay}`);
  lines.push('');
  lines.push(`Verdict: **${report.verdict.toUpperCase()}** (${report.counts.error} error / ${report.counts.warning} warning / ${report.counts.ok} ok)`);
  lines.push('');
  for (const c of report.checks) {
    const glyph = c.severity === 'error' ? '[error]' :
                  c.severity === 'warning' ? '[warn]' : '[ok]';
    lines.push(`## ${glyph} ${c.title}`);
    lines.push(c.message);
    if (c.hint) lines.push('');
    if (c.hint) lines.push(`Hint: ${c.hint}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Pure helper used by the view: compute file overlap given two
 * arrays of file paths. Case-insensitive on macOS-typical paths.
 */
export function countOverlap(prFiles: string[], myRecentFiles: string[]): number {
  if (!prFiles.length || !myRecentFiles.length) return 0;
  const recent = new Set(myRecentFiles.map(f => f.toLowerCase()));
  let n = 0;
  for (const f of prFiles) {
    if (recent.has(f.toLowerCase())) n++;
  }
  return n;
}
