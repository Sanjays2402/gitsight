/**
 * Pure helpers for F138 - Pre-merge readiness checklist.
 *
 * Companion to F101 (PR checkout pre-flight). Where F101 gates
 * `gh pr checkout`, this gates `gh pr merge`. Both share the same
 * PreflightSeverity / verdict shape so the picker UX is consistent.
 *
 * Five gates evaluated for a PR about to be merged:
 *
 *   1. Review approvals   - does the PR have the required number of
 *                           approving reviews? (E.g. 0/2 -> error;
 *                           1/2 -> warning; >=2/2 -> ok.)
 *   2. Status checks      - have all required status checks reported
 *                           success? Pending / failing -> error.
 *   3. Conflict freshness - is the PR merge-state CLEAN, or does
 *                           GitHub report it as DIRTY / UNSTABLE?
 *   4. Base divergence    - has the base branch moved significantly
 *                           since the PR was last updated? (Warn at
 *                           >= 10 commits behind by default.)
 *   5. Test-impact synced - if the PR body has the F125 test-impact
 *                           block, has it been refreshed since the
 *                           last push? (Stale block -> warning.)
 *
 * Aggregate verdict shape: 'ready' / 'caution' / 'blocked', mirroring
 * F101's clear / caution / blocked vocabulary.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/preMergeChecklist.test.ts.
 */

export type CheckSeverity = 'ok' | 'warning' | 'error';
export type MergeVerdict = 'ready' | 'caution' | 'blocked';

export interface MergeCheck {
  id: string;
  title: string;
  severity: CheckSeverity;
  message: string;
  /** Optional remediation hint. */
  hint?: string;
}

export interface MergeReport {
  checks: MergeCheck[];
  verdict: MergeVerdict;
  counts: { ok: number; warning: number; error: number };
}

/**
 * Aggregate the verdict from individual checks.
 *
 *   - any 'error'   -> blocked
 *   - any 'warning' -> caution
 *   - all 'ok'      -> ready
 */
export function aggregateMergeVerdict(checks: MergeCheck[]): MergeVerdict {
  if (checks.some(c => c.severity === 'error')) return 'blocked';
  if (checks.some(c => c.severity === 'warning')) return 'caution';
  return 'ready';
}

export function summariseMergeReport(checks: MergeCheck[]): MergeReport {
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const c of checks) counts[c.severity]++;
  return { checks, verdict: aggregateMergeVerdict(checks), counts };
}

// ── Individual gates ──────────────────────────────────────────────────

/**
 * Review-approval gate. `approvingReviews` is the count of reviews
 * with state APPROVED on the latest commit. `requiredApprovals` is
 * the branch-protection policy (1 by default; some repos require 2).
 */
export function checkReviewApprovals(approvingReviews: number, requiredApprovals: number): MergeCheck {
  const need = Math.max(1, requiredApprovals);
  if (approvingReviews >= need) {
    return {
      id: 'review-approvals',
      title: 'Review approvals',
      severity: 'ok',
      message: `${approvingReviews} approving review${approvingReviews === 1 ? '' : 's'} (need ${need}).`,
    };
  }
  // Zero approvals is always a hard error - the PR has not been
  // reviewed at all. Only warn for "one short" (you've started getting
  // approvals but the count is still under threshold).
  if (approvingReviews > 0 && approvingReviews === need - 1) {
    return {
      id: 'review-approvals',
      title: 'Review approvals',
      severity: 'warning',
      message: `${approvingReviews}/${need} approving review${need === 1 ? '' : 's'} - one short.`,
      hint: 'Ping a reviewer; F105 (find inactive reviewers) can help identify the right person.',
    };
  }
  return {
    id: 'review-approvals',
    title: 'Review approvals',
    severity: 'error',
    message: `${approvingReviews}/${need} approving reviews - cannot merge yet.`,
    hint: 'Request reviews via the PR sidebar, or check F75 (PR Review-Request Inbox).',
  };
}

/**
 * Status-check gate. `verdict` is the rolled-up state of all required
 * status checks (the same field GitHub puts in `mergeStateStatus`).
 *
 * GitHub merge-state vocabulary we honour:
 *   - CLEAN / HAS_HOOKS / UNSTABLE: tests passed (UNSTABLE = non-required
 *     checks failed but required ones passed)
 *   - BEHIND: required checks haven't run against the latest base
 *   - BLOCKED: required checks failing / pending
 *   - DIRTY: merge conflicts (separate gate)
 */
export type StatusCheckVerdict =
  | 'CLEAN' | 'HAS_HOOKS' | 'UNSTABLE'
  | 'BEHIND' | 'BLOCKED' | 'DIRTY'
  | 'UNKNOWN';

export function checkStatusChecks(verdict: StatusCheckVerdict, failingCount?: number): MergeCheck {
  switch (verdict) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return {
        id: 'status-checks',
        title: 'Status checks',
        severity: 'ok',
        message: 'All required checks passing.',
      };
    case 'UNSTABLE':
      return {
        id: 'status-checks',
        title: 'Status checks',
        severity: 'warning',
        message: 'Required checks pass but some non-required checks failed.',
        hint: 'Worth a look - some teams treat UNSTABLE as merge-block by policy even though GitHub permits it.',
      };
    case 'BEHIND':
      return {
        id: 'status-checks',
        title: 'Status checks',
        severity: 'warning',
        message: 'Required checks haven\u2019t run against the latest base.',
        hint: 'Update the branch (e.g. merge or rebase from base) to re-trigger CI.',
      };
    case 'BLOCKED':
      return {
        id: 'status-checks',
        title: 'Status checks',
        severity: 'error',
        message: failingCount && failingCount > 0
          ? `${failingCount} required check${failingCount === 1 ? '' : 's'} failing or pending.`
          : 'Required checks failing or pending.',
        hint: 'Check the Actions tab or the F62 status-bar pill for the failing run.',
      };
    case 'DIRTY':
      // Surface this here too so a caller that only inspects the
      // status-checks gate still gets a hint; the dedicated freshness
      // gate captures it as an error.
      return {
        id: 'status-checks',
        title: 'Status checks',
        severity: 'warning',
        message: 'Branch state is DIRTY - resolve conflicts first.',
        hint: 'See the conflict-freshness gate for resolution guidance.',
      };
    case 'UNKNOWN':
    default:
      return {
        id: 'status-checks',
        title: 'Status checks',
        severity: 'warning',
        message: 'Status-check verdict not reported by GitHub yet.',
        hint: 'Try refreshing - if it stays UNKNOWN, the merge-state probe may need to be re-run.',
      };
  }
}

/**
 * Conflict-freshness gate. CLEAN -> ok; DIRTY -> error.
 * Other states are passed through with the right severity.
 */
export function checkConflictFreshness(mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN', mergeStateStatus?: StatusCheckVerdict): MergeCheck {
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    return {
      id: 'conflict-freshness',
      title: 'Conflict freshness',
      severity: 'error',
      message: 'PR has merge conflicts that must be resolved before merging.',
      hint: 'Locally: `git pull origin <base>` then resolve. F107 conflict coach can help.',
    };
  }
  if (mergeable === 'UNKNOWN') {
    return {
      id: 'conflict-freshness',
      title: 'Conflict freshness',
      severity: 'warning',
      message: 'GitHub hasn\u2019t finished computing mergeability yet.',
      hint: 'Try refreshing in a few seconds.',
    };
  }
  return {
    id: 'conflict-freshness',
    title: 'Conflict freshness',
    severity: 'ok',
    message: 'No merge conflicts detected.',
  };
}

/**
 * Base-divergence gate. `behindBy` is the count of commits the PR
 * head is behind its base. Warn at >= 10 commits by default.
 *
 * Why warn vs error? GitHub will rebase / merge happily for the user,
 * but the diff the reviewer LOOKED AT may not be what gets merged
 * (semantic conflicts hidden by clean merges). Surface so they know.
 */
export function checkBaseDivergence(baseBranch: string, behindBy: number, threshold = 10): MergeCheck {
  if (behindBy === 0) {
    return {
      id: 'base-divergence',
      title: 'Base alignment',
      severity: 'ok',
      message: `Up-to-date with ${baseBranch}.`,
    };
  }
  if (behindBy < threshold) {
    return {
      id: 'base-divergence',
      title: 'Base alignment',
      severity: 'ok',
      message: `${behindBy} commit${behindBy === 1 ? '' : 's'} behind ${baseBranch} - minor drift.`,
    };
  }
  return {
    id: 'base-divergence',
    title: 'Base alignment',
    severity: 'warning',
    message: `${behindBy} commits behind ${baseBranch} - reviewer\u2019s diff may differ from the merge result.`,
    hint: 'Consider rebasing or merging base into the PR branch and re-pinging reviewers if anything semantic changed.',
  };
}

/**
 * Test-impact-synced gate. Composes with F125 (test-impact PR-body
 * sync) + F134 (delta verdict). When the body contains the managed
 * block, check whether the block reflects the latest push.
 *
 * Inputs (the view layer derives these by re-running F125's summariser
 * against the current branch + parsing the existing block from the PR
 * body):
 *
 *   - hasBlock: does the PR body include the F125 marker block?
 *   - blockMatchesHead: would re-rendering the block produce the same
 *                       content (modulo timestamp)?
 *
 * No block + opt-out-not-needed -> ok (the gate is opt-in via F125).
 * Block present + stale -> warning + recommend running F125 again.
 * Block present + fresh -> ok.
 */
export function checkTestImpactSynced(args: { hasBlock: boolean; blockMatchesHead: boolean }): MergeCheck {
  if (!args.hasBlock) {
    return {
      id: 'test-impact-synced',
      title: 'Test-impact synced',
      severity: 'ok',
      message: 'No test-impact block present (gate is opt-in via F125).',
    };
  }
  if (args.blockMatchesHead) {
    return {
      id: 'test-impact-synced',
      title: 'Test-impact synced',
      severity: 'ok',
      message: 'Test-impact block is up-to-date with the latest push.',
    };
  }
  return {
    id: 'test-impact-synced',
    title: 'Test-impact synced',
    severity: 'warning',
    message: 'Test-impact block is stale - reviewers may be looking at the wrong tests.',
    hint: 'Run `GitSight: Inject Test-Impact into PR Body` to refresh, or enable testImpactPrBody.autoSync.',
  };
}

// ── Composition ──────────────────────────────────────────────────────

export interface PreMergeInputs {
  approvingReviews: number;
  requiredApprovals: number;
  statusCheckVerdict: StatusCheckVerdict;
  failingCheckCount?: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus?: StatusCheckVerdict;
  baseBranch: string;
  baseBehindBy: number;
  baseDivergenceThreshold?: number;
  testImpactHasBlock: boolean;
  testImpactBlockMatchesHead: boolean;
}

export function runPreMergeChecklist(inputs: PreMergeInputs): MergeReport {
  // Conflict freshness goes first because the user reading the report
  // wants the show-stopper at the top. The aggregate verdict is the
  // same regardless of order; ordering is purely for readability.
  const checks: MergeCheck[] = [
    checkConflictFreshness(inputs.mergeable, inputs.mergeStateStatus),
    checkStatusChecks(inputs.statusCheckVerdict, inputs.failingCheckCount),
    checkReviewApprovals(inputs.approvingReviews, inputs.requiredApprovals),
    checkBaseDivergence(inputs.baseBranch, inputs.baseBehindBy, inputs.baseDivergenceThreshold),
    checkTestImpactSynced({
      hasBlock: inputs.testImpactHasBlock,
      blockMatchesHead: inputs.testImpactBlockMatchesHead,
    }),
  ];
  return summariseMergeReport(checks);
}

/**
 * One-line summary for the picker placeholder.
 *
 *   "Merge: ready"
 *   "Merge: caution - 1 warning (test-impact synced)"
 *   "Merge: blocked - 2 errors (conflict-freshness, status-checks)"
 */
export function describeMergeReport(report: MergeReport): string {
  const issues = report.checks.filter(c => c.severity !== 'ok');
  if (!issues.length) return 'Merge: ready';
  const tier = report.verdict === 'blocked'
    ? `blocked - ${report.counts.error} error${report.counts.error === 1 ? '' : 's'}`
    : `caution - ${report.counts.warning} warning${report.counts.warning === 1 ? '' : 's'}`;
  return `Merge: ${tier} (${issues.map(c => c.id).join(', ')})`;
}

/**
 * Full markdown report for the scratch buffer preview.
 */
export function renderMergeReport(prDisplay: string, report: MergeReport): string {
  const lines: string[] = [];
  lines.push(`# Pre-merge: ${prDisplay}`);
  lines.push('');
  lines.push(`Verdict: **${report.verdict.toUpperCase()}** (${report.counts.error} error / ${report.counts.warning} warning / ${report.counts.ok} ok)`);
  lines.push('');
  for (const c of report.checks) {
    const glyph = c.severity === 'error' ? '[error]'
                : c.severity === 'warning' ? '[warn]'
                : '[ok]';
    lines.push(`## ${glyph} ${c.title}`);
    lines.push(c.message);
    if (c.hint) {
      lines.push('');
      lines.push(`Hint: ${c.hint}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Should the merge picker include an "Override + merge anyway" path?
 * Only when the verdict is 'caution'. 'blocked' verdicts never get the
 * override (we don't want to encourage merging through hard errors).
 */
export function allowsOverride(verdict: MergeVerdict): boolean {
  return verdict === 'caution';
}

/**
 * GitHub `mergeStateStatus` value normaliser. Tolerates the all-caps
 * shape from the GraphQL API and the lowercase variants from REST.
 */
export function normaliseMergeStateStatus(input: string | undefined | null): StatusCheckVerdict {
  if (!input) return 'UNKNOWN';
  const upper = input.toString().toUpperCase().trim();
  switch (upper) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
    case 'BEHIND':
    case 'BLOCKED':
    case 'DIRTY':
      return upper;
    default:
      return 'UNKNOWN';
  }
}

/**
 * GitHub `mergeable` value normaliser. Same pattern.
 */
export function normaliseMergeable(input: string | undefined | null): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (!input) return 'UNKNOWN';
  const upper = input.toString().toUpperCase().trim();
  if (upper === 'MERGEABLE' || upper === 'CONFLICTING') return upper;
  return 'UNKNOWN';
}
