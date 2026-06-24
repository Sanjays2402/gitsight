/**
 * Pure helpers for F142 - Branch protection canned templates.
 *
 * Companion to F126 (suggestProtectionRules) + F135 (delta-only picker).
 * Where F126 derives suggestions from branch role + repo signals, this
 * module provides a small library of named, opinionated rulesets the
 * user can apply in one click - useful for first-time setup ("just
 * lock this branch down sensibly, don't make me think") or for
 * standardising protection across many repos.
 *
 * Three canned templates:
 *
 *   - 'open-source-friendly' - PR review + status checks + no force-push
 *                              + no deletions. Leaves admin bypass ON
 *                              so maintainers can land emergency fixes
 *                              without ceremony.
 *   - 'internal-strict'      - all of the above PLUS linear history +
 *                              required signatures + enforce-admins.
 *                              The "we treat main as production"
 *                              shape that most company orgs land on.
 *   - 'release-only'         - linear history + no force-push +
 *                              no deletions + lock-branch. Optimised
 *                              for branches that should be append-only
 *                              after the release cut.
 *
 * Why hardcoded templates instead of deriving everything from role?
 * Because role-derivation requires the user to understand WHICH rules
 * are appropriate - the templates encode the opinion outright so the
 * user only needs to pick the philosophy. F126's suggester is the
 * "smart" surface; this is the "fast" surface.
 *
 * Pure - no vscode. Tests in test/git/branchProtectionTemplates.test.ts.
 */

import { ProtectionRule } from './forcePushGuard';
import { RuleSuggestion, SuggestionStrength } from './branchProtectionSuggest';

export type TemplateId = 'open-source-friendly' | 'internal-strict' | 'release-only';

export interface TemplateDefinition {
  id: TemplateId;
  /** Short label shown in the picker (e.g. "Open-source friendly"). */
  label: string;
  /** One-sentence description shown as the picker detail line. */
  description: string;
  /** Long-form rationale for the markdown preview. */
  rationale: string;
  /** Rule IDs the template enables. */
  rules: Array<ProtectionRule['id']>;
  /** Required PR review count (only used when rules include 'required-reviews'). */
  requiredApprovingReviewCount?: number;
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'open-source-friendly',
    label: 'Open-source friendly',
    description: 'PR review + status checks + no force-push. Admins can still bypass.',
    rationale: 'Default-on for OSS repos. Requires at least one approving review and CI green before merge, but leaves the admin escape hatch ON so maintainers can land emergency fixes without re-configuring protection.',
    rules: ['required-reviews', 'required-status-checks', 'force-push', 'deletions'],
    requiredApprovingReviewCount: 1,
  },
  {
    id: 'internal-strict',
    label: 'Internal strict',
    description: 'Review + checks + linear history + signed commits + admins included.',
    rationale: 'The shape most company orgs converge on for main: everything the OSS template enforces PLUS linear history (no merge bubbles), required signed commits (cryptographic provenance), and enforce-admins ON (admins cannot bypass). Treat main as production.',
    rules: [
      'required-reviews',
      'required-status-checks',
      'force-push',
      'deletions',
      'required-linear-history',
      'required-signatures',
      'enforce-admins',
    ],
    requiredApprovingReviewCount: 1,
  },
  {
    id: 'release-only',
    label: 'Release-only (locked)',
    description: 'Linear history + no force-push + no deletions + lock the branch.',
    rationale: 'For branches that should be append-only after the release cut. No force-push, no deletions, linear history, AND lock-branch (no further pushes accepted) so the release reference stays stable. Combine with tags for the canonical release pointer.',
    rules: ['required-linear-history', 'force-push', 'deletions', 'lock-branch'],
  },
];

/**
 * Lookup a template by id. Returns undefined for unknown ids so the
 * caller can degrade gracefully (e.g. a future stale config value
 * pointing at a removed template).
 */
export function getTemplate(id: TemplateId): TemplateDefinition | undefined {
  return TEMPLATES.find(t => t.id === id);
}

/**
 * Translate a template into the same `RuleSuggestion[]` shape that
 * F126's suggestProtectionRules emits so the existing
 * buildProtectionPutBody / buildSuggestionPreview can consume both
 * paths uniformly.
 *
 * Each rule from the template becomes a `recommended`-strength
 * suggestion (the user already opted-in by picking the template;
 * weakening the strength would let the F135 delta picker hide them
 * by default). Rules already enabled on the branch are dropped so
 * the suggestion list reflects net-new work.
 */
export interface BuildSuggestionsArgs {
  template: TemplateDefinition;
  /** Currently enabled rule IDs (from a prior protection probe). */
  currentlyEnabled: Set<ProtectionRule['id']>;
}

export function buildTemplateSuggestions(args: BuildSuggestionsArgs): RuleSuggestion[] {
  const { template, currentlyEnabled } = args;
  const out: RuleSuggestion[] = [];
  for (let i = 0; i < template.rules.length; i++) {
    const id = template.rules[i];
    if (currentlyEnabled.has(id)) continue;
    out.push({
      id,
      label: labelForRule(id),
      rationale: rationaleForRule(id, template.id),
      strength: 'recommended' as SuggestionStrength,
      // Preserve the template's authoring order so the picker reads
      // top-to-bottom in a sensible reading order.
      weight: template.rules.length - i,
    });
  }
  return out;
}

function labelForRule(id: ProtectionRule['id']): string {
  switch (id) {
    case 'required-reviews':         return 'Require PR review';
    case 'required-status-checks':   return 'Require status checks to pass';
    case 'force-push':               return 'Disallow force-push';
    case 'deletions':                return 'Disallow branch deletion';
    case 'required-linear-history':  return 'Require linear history';
    case 'required-signatures':      return 'Require signed commits';
    case 'enforce-admins':           return 'Include administrators';
    case 'lock-branch':              return 'Lock branch (no further pushes)';
    default:                         return id;
  }
}

function rationaleForRule(id: ProtectionRule['id'], template: TemplateId): string {
  switch (id) {
    case 'required-reviews':
      return template === 'internal-strict'
        ? 'Internal strict: every merge needs at least one approving review - no solo merges.'
        : 'At least one approving review before merge keeps unreviewed changes out of the branch.';
    case 'required-status-checks':
      return 'CI green is a merge prerequisite - protects the branch from PRs that don\u2019t pass tests.';
    case 'force-push':
      return 'Force-push rewrites history; disallowing it keeps commits stable for everyone.';
    case 'deletions':
      return 'Stops accidental branch deletion from a stale tab in the GitHub UI.';
    case 'required-linear-history':
      return 'Linear history (no merge bubbles) - easier to cherry-pick + read release notes from.';
    case 'required-signatures':
      return 'Cryptographically signed commits - lineage stays auditable.';
    case 'enforce-admins':
      return 'Admin bypass is OFF - the rules apply to administrators too. Production-grade enforcement.';
    case 'lock-branch':
      return 'Branch is append-only after this - no further pushes accepted. Use tags for the canonical release pointer.';
    default:
      return 'Template-supplied rule.';
  }
}

/**
 * Build the markdown preview for a template - shown when the user
 * picks "Open template preview" before applying.
 */
export interface TemplatePreviewArgs {
  template: TemplateDefinition;
  branch: string;
  suggestions: RuleSuggestion[];
}

export function buildTemplatePreview(args: TemplatePreviewArgs): string {
  const lines: string[] = [];
  lines.push(`# Template: ${args.template.label}`);
  lines.push('');
  lines.push(`Applying to branch: \`${args.branch}\``);
  lines.push('');
  lines.push(args.template.rationale);
  lines.push('');
  if (args.suggestions.length === 0) {
    lines.push('_This template\u2019s rules are already all enabled on this branch - nothing to apply._');
    return lines.join('\n');
  }
  lines.push(`## ${args.suggestions.length} rule${args.suggestions.length === 1 ? '' : 's'} to enable`);
  lines.push('');
  for (const s of args.suggestions) {
    lines.push(`- **${s.label}** - ${s.rationale}`);
  }
  if (args.template.requiredApprovingReviewCount && args.template.rules.includes('required-reviews')) {
    lines.push('');
    lines.push(`_Required approving reviews: ${args.template.requiredApprovingReviewCount}._`);
  }
  return lines.join('\n');
}

/**
 * Human-readable picker subtitle for a template:
 *
 *   "Open-source friendly - 3 of 4 rules to enable"
 *   "Internal strict - already covered"
 */
export function describeTemplateDelta(args: { template: TemplateDefinition; suggestions: RuleSuggestion[] }): string {
  if (args.suggestions.length === 0) {
    return `${args.template.label} - already covered`;
  }
  const total = args.template.rules.length;
  return `${args.template.label} - ${args.suggestions.length} of ${total} rule${total === 1 ? '' : 's'} to enable`;
}

/**
 * Verdict whether a template covers the currently-enabled rules already.
 * Used by the picker to mark templates with a glyph difference (e.g.
 * a check vs a wrench) so the user sees at-a-glance which templates
 * would actually do something.
 */
export type TemplateCoverageVerdict = 'already-covered' | 'partial' | 'none';

export function classifyTemplateCoverage(args: {
  template: TemplateDefinition;
  currentlyEnabled: Set<ProtectionRule['id']>;
}): TemplateCoverageVerdict {
  const { template, currentlyEnabled } = args;
  let covered = 0;
  for (const id of template.rules) {
    if (currentlyEnabled.has(id)) covered++;
  }
  if (covered === template.rules.length) return 'already-covered';
  if (covered === 0) return 'none';
  return 'partial';
}
