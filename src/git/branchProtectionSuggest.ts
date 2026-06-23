/**
 * Pure helpers for F126 - Branch Protection Rule Auto-Suggester.
 *
 * Companion to F71 (force-push guard) and F119 (overview picker). For
 * a branch whose current protection is unprotected / guarded / unknown,
 * suggest a starter ruleset based on:
 *
 *   1. Branch role classifier (default / release / hotfix / feature /
 *      long-lived / other) derived from name + repo defaults.
 *   2. Repo signals (has CI workflows? CODEOWNERS? signed-commit
 *      history?). The view layer probes these; we keep the suggester
 *      pure by taking them as an `EnvironmentSignals` input.
 *
 * Output:
 *   - A ranked list of suggested rule changes (id + label + rationale).
 *   - A JSON body suitable for `gh api -X PUT
 *     repos/:o/:r/branches/:b/protection`.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/branchProtectionSuggest.test.ts.
 *
 * Why not just always suggest "require PR review + status checks"?
 * Because a one-size-fits-all suggestion is wrong for release branches
 * (they need linear history + no force-push too) and overkill for
 * personal feature branches (they probably want nothing). The role
 * classifier scopes the suggestion to what's actually appropriate.
 */

import { ProtectionDecision, ProtectionRule } from './forcePushGuard';

export type BranchRole =
  | 'default'           // main / master / repo default
  | 'release'           // release/* / v1.x / 1.x / production / stable
  | 'hotfix'            // hotfix/* / fix/* (sometimes wants stricter rules)
  | 'long-lived'        // develop / staging / qa / preview
  | 'feature'           // feature/* / feat/* / chore/*
  | 'other';

export interface BranchRoleArgs {
  /** The branch name (e.g. 'release/2026.q2', 'main', 'feature/foo'). */
  branch: string;
  /** Repo default branch when known. Match -> 'default' role wins. */
  defaultBranch?: string;
}

const RELEASE_PATTERNS: RegExp[] = [
  /^release\//i,
  /^releases?-/i,
  /^production$/i,
  /^stable$/i,
  /^v?\d+\.\d+(?:\.\d+)?$/, // 1.2.3 / v1.2 / v1.2.3
  /^v?\d+\.x$/i,            // 1.x / v1.x
];
const HOTFIX_PATTERNS: RegExp[] = [
  /^hotfix\//i,
  /^fix\//i,
  /^patch\//i,
];
const LONG_LIVED_PATTERNS: RegExp[] = [
  /^develop$/i,
  /^development$/i,
  /^dev$/i,
  /^staging$/i,
  /^stage$/i,
  /^qa$/i,
  /^preview$/i,
  /^next$/i,
  /^canary$/i,
];
const FEATURE_PATTERNS: RegExp[] = [
  /^feature\//i,
  /^feat\//i,
  /^chore\//i,
  /^refactor\//i,
  /^docs\//i,
  /^test\//i,
];

export function classifyBranchRole(args: BranchRoleArgs): BranchRole {
  const name = (args.branch || '').trim();
  if (!name) return 'other';
  if (args.defaultBranch && name === args.defaultBranch) return 'default';
  // Common default names without repo metadata.
  if (/^(main|master|trunk)$/i.test(name)) return 'default';
  if (RELEASE_PATTERNS.some(rx => rx.test(name))) return 'release';
  if (HOTFIX_PATTERNS.some(rx => rx.test(name))) return 'hotfix';
  if (LONG_LIVED_PATTERNS.some(rx => rx.test(name))) return 'long-lived';
  if (FEATURE_PATTERNS.some(rx => rx.test(name))) return 'feature';
  return 'other';
}

/**
 * F130 - Decide whether a freshly-created branch SHOULD be offered the
 * F126 protection-suggestion picker as a follow-up.
 *
 * Auto-offer policy:
 *   - 'default'    -> ALWAYS offer (someone re-created main from scratch)
 *   - 'release'    -> ALWAYS offer (release/* branches need rules)
 *   - 'hotfix'     -> offer (hotfixes deserve at least required-reviews)
 *   - 'long-lived' -> offer (develop/staging/qa want rules too)
 *   - 'feature'    -> SKIP (personal branches don't need protection)
 *   - 'other'      -> SKIP (we'd be guessing)
 *
 * The view layer should ALSO respect the user's config opt-out
 * (gitsight.branchProtectionSuggest.autoOfferOnCreate). When opt-out
 * is on, this verdict never gets a chance to fire.
 */
export type AutoOfferVerdict = 'offer' | 'skip';

export function shouldAutoOfferProtection(role: BranchRole): AutoOfferVerdict {
  switch (role) {
    case 'default':
    case 'release':
    case 'hotfix':
    case 'long-lived':
      return 'offer';
    case 'feature':
    case 'other':
      return 'skip';
  }
}

/**
 * Human-readable rationale shown in the toast when auto-offering. The
 * view layer concatenates this onto the toast body so the user knows
 * WHY GitSight is asking.
 */
export function describeAutoOfferRationale(role: BranchRole): string {
  switch (role) {
    case 'default':
      return 'this looks like a default branch (main / master / trunk)';
    case 'release':
      return 'this looks like a release branch';
    case 'hotfix':
      return 'this looks like a hotfix branch';
    case 'long-lived':
      return 'this looks like a long-lived branch (develop / staging / qa)';
    case 'feature':
      return 'this looks like a feature branch';
    case 'other':
      return 'unable to classify branch role';
  }
}

/** Signals the view layer probes once before calling the suggester. */
export interface EnvironmentSignals {
  /** True when `.github/workflows/*.{yml,yaml}` exists. */
  hasCiWorkflows: boolean;
  /** Workflow names extracted from the YAML `name:` field for status-check selection. */
  workflowJobNames?: string[];
  /** True when a CODEOWNERS file exists. */
  hasCodeowners: boolean;
  /** True when the recent commits include signed commits (gh log %GG marker). */
  hasSignedCommits: boolean;
  /** Total recent commits used to derive `hasSignedCommits` (to gauge confidence). */
  recentCommitCount?: number;
}

export type SuggestionStrength = 'recommended' | 'optional' | 'aggressive';

export interface RuleSuggestion {
  /** Aligns with ProtectionRule.id from F71 so the picker can show
   *  which existing rules would CHANGE (vs which are already on). */
  id: ProtectionRule['id'];
  /** Short label for the picker row. */
  label: string;
  /** One-sentence rationale shown as the picker description. */
  rationale: string;
  strength: SuggestionStrength;
  /** Numeric weight for ordering (higher = more important to surface). */
  weight: number;
}

/**
 * Suggest a ruleset for a branch given its role + the current
 * protection state + environment signals.
 *
 * Strategy: start from the role's baseline, drop rules already enabled,
 * upgrade strength based on signals (e.g. status-checks become
 * recommended when CI workflows exist; recommend signed commits only
 * when we see a history of signed commits).
 */
export interface SuggestArgs {
  branch: string;
  role: BranchRole;
  current: ProtectionDecision;
  signals: EnvironmentSignals;
}

export function suggestProtectionRules(args: SuggestArgs): RuleSuggestion[] {
  const { role, current, signals } = args;
  const existing = new Set<ProtectionRule['id']>();
  if (current.kind === 'protected') {
    for (const r of current.rules) {
      if (r.enabled) existing.add(r.id);
    }
  }

  const out: RuleSuggestion[] = [];
  const push = (s: RuleSuggestion) => {
    if (existing.has(s.id)) return; // already on - skip
    out.push(s);
  };

  // Baseline rules for the default branch:
  if (role === 'default' || role === 'release') {
    push({
      id: 'required-reviews',
      label: 'Require PR review',
      rationale: 'At least one approving review before merge keeps `main` from absorbing unreviewed changes.',
      strength: 'recommended',
      weight: 100,
    });
    push({
      id: 'force-push',
      label: 'Disallow force-push',
      rationale: 'Force-push rewrites history; keep it off on shared branches so commits stay stable for everyone.',
      strength: 'recommended',
      weight: 90,
    });
    push({
      id: 'deletions',
      label: 'Disallow branch deletion',
      rationale: 'Stops accidental deletion of the long-lived branch from a stale tab in GitHub UI.',
      strength: 'recommended',
      weight: 80,
    });
  }
  if (role === 'release') {
    push({
      id: 'required-linear-history',
      label: 'Require linear history',
      rationale: 'Release branches want a clean linear chain for cherry-picks + release notes - no merge bubbles.',
      strength: 'recommended',
      weight: 85,
    });
  }
  if (role === 'long-lived' || role === 'default') {
    push({
      id: 'required-status-checks',
      label: 'Require status checks to pass',
      rationale: signals.hasCiWorkflows
        ? `CI is in place (${signals.workflowJobNames?.length ?? '?'} workflow${(signals.workflowJobNames?.length ?? 0) === 1 ? '' : 's'} detected) - gate merges on green builds.`
        : 'When CI exists, require it to pass before merging.',
      strength: signals.hasCiWorkflows ? 'recommended' : 'optional',
      weight: 75,
    });
  }
  if (role === 'hotfix') {
    push({
      id: 'required-reviews',
      label: 'Require PR review',
      rationale: 'Hotfix branches go straight to production - at least one second-pair-of-eyes review.',
      strength: 'recommended',
      weight: 95,
    });
    push({
      id: 'required-status-checks',
      label: 'Require status checks',
      rationale: 'Hotfixes are by definition urgent - the CI gate stops a panic merge from breaking things further.',
      strength: signals.hasCiWorkflows ? 'recommended' : 'optional',
      weight: 80,
    });
  }
  if (signals.hasSignedCommits && (role === 'default' || role === 'release')) {
    push({
      id: 'required-signatures',
      label: 'Require signed commits',
      rationale: 'Recent commits are signed - turning this on keeps the lineage cryptographically auditable.',
      strength: 'optional',
      weight: 50,
    });
  }
  if (role === 'default' || role === 'release') {
    push({
      id: 'enforce-admins',
      label: 'Include administrators',
      rationale: 'Admins can normally bypass branch protection - turn this on for actual policy enforcement.',
      strength: 'aggressive',
      weight: 30,
    });
  }
  // Feature / other branches: no suggestions by default - they're
  // ephemeral; protecting them adds friction without benefit.

  // Stable sort: weight desc, then strength priority (recommended >
  // optional > aggressive), then id.
  out.sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    const ra = strengthRank(a.strength);
    const rb = strengthRank(b.strength);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  return out;
}

function strengthRank(s: SuggestionStrength): number {
  switch (s) {
    case 'recommended': return 0;
    case 'optional':    return 1;
    case 'aggressive':  return 2;
  }
}

/**
 * Build the JSON body for `gh api -X PUT repos/:o/:r/branches/:b/protection`.
 *
 * The GitHub API requires several nested objects to be present (or
 * explicitly null) even when leaving them off; this helper composes
 * them from a flat picked-id list so the caller doesn't have to remember
 * the schema.
 *
 * `picked` is the list of suggestion ids the user accepted. Each id
 * maps to a slot in the PUT body. Any current state that isn't being
 * changed by a picked id is left as-is in the request.
 */
export interface BuildPutBodyArgs {
  picked: Array<ProtectionRule['id']>;
  /** Currently enabled rule ids - so we don't downgrade rules the user already had. */
  currentlyEnabled: Set<ProtectionRule['id']>;
  /** Status check job names (workflow names). Required when picked includes 'required-status-checks'. */
  statusCheckContexts?: string[];
  /** Required-review count (default 1). */
  requiredApprovingReviewCount?: number;
}

export function buildProtectionPutBody(args: BuildPutBodyArgs): Record<string, any> {
  const allRules = new Set<ProtectionRule['id']>([...args.currentlyEnabled, ...args.picked]);
  const reviewCount = args.requiredApprovingReviewCount ?? 1;
  const body: Record<string, any> = {
    // GitHub requires explicit nulls for unset fields.
    required_status_checks: null,
    enforce_admins: allRules.has('enforce-admins') ? true : null,
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: allRules.has('required-linear-history'),
    allow_force_pushes: !allRules.has('force-push'),
    allow_deletions: !allRules.has('deletions'),
    required_signatures: allRules.has('required-signatures'),
    lock_branch: allRules.has('lock-branch'),
  };
  if (allRules.has('required-status-checks')) {
    body.required_status_checks = {
      strict: true,
      contexts: args.statusCheckContexts ?? [],
    };
  }
  if (allRules.has('required-reviews')) {
    body.required_pull_request_reviews = {
      required_approving_review_count: reviewCount,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
    };
  }
  return body;
}

/**
 * Build the markdown preview shown before the PUT call. Lists picked
 * rules + their rationale + the workflow contexts for status checks.
 */
export function buildSuggestionPreview(args: {
  branch: string;
  role: BranchRole;
  suggestions: RuleSuggestion[];
  signals: EnvironmentSignals;
}): string {
  const lines: string[] = [];
  lines.push(`# Branch Protection Suggestion - \`${args.branch}\``);
  lines.push('');
  lines.push(`Branch role: **${args.role}**`);
  lines.push('');
  if (args.suggestions.length === 0) {
    lines.push('_No further suggestions - the existing ruleset already covers the recommended baseline._');
    return lines.join('\n');
  }
  const groups: Record<SuggestionStrength, RuleSuggestion[]> = {
    recommended: [],
    optional: [],
    aggressive: [],
  };
  for (const s of args.suggestions) groups[s.strength].push(s);

  for (const tier of ['recommended', 'optional', 'aggressive'] as const) {
    if (groups[tier].length === 0) continue;
    lines.push(`## ${tier[0].toUpperCase()}${tier.slice(1)}`);
    lines.push('');
    for (const s of groups[tier]) {
      lines.push(`- **${s.label}** - ${s.rationale}`);
    }
    lines.push('');
  }
  if (args.signals.hasCiWorkflows && args.signals.workflowJobNames?.length) {
    lines.push('## Workflow contexts');
    lines.push('');
    lines.push('When you accept the status-checks rule, GitSight wires these workflow names as required contexts:');
    lines.push('');
    for (const job of args.signals.workflowJobNames) {
      lines.push(`- \`${job}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Human-readable verdict + summary for the picker title.
 *
 *   "release/2026.q2 - 4 recommended rules pending"
 *   "main - already covered"
 */
export function describeSuggestionVerdict(args: { branch: string; suggestions: RuleSuggestion[] }): string {
  if (args.suggestions.length === 0) return `${args.branch} - already covered`;
  const counts = { recommended: 0, optional: 0, aggressive: 0 };
  for (const s of args.suggestions) counts[s.strength]++;
  const parts: string[] = [];
  if (counts.recommended) parts.push(`${counts.recommended} recommended`);
  if (counts.optional) parts.push(`${counts.optional} optional`);
  if (counts.aggressive) parts.push(`${counts.aggressive} aggressive`);
  return `${args.branch} - ${parts.join(' / ')}`;
}
