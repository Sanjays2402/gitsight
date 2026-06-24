/**
 * F146 - Template auto-suggestion on first protection-setup.
 *
 * Companion to F142 (canned template picker) + F126 (role-derived
 * suggester) + F130 (auto-offer on new branch). When the F126 path
 * fires on a branch whose CURRENT protection state is COMPLETELY
 * empty (no protection at all - the first-time case), suggest the
 * matching canned TEMPLATE as a one-click option BEFORE walking the
 * full role-derived picker.
 *
 * Why? First-time setup is the highest-friction moment. Users land
 * on the picker with a list of 8 rules and have to decide which to
 * enable, with technical descriptions for each. The templates encode
 * the COMMON answers as named bundles; surfacing the most-likely-
 * appropriate one as the default lets the user just hit Enter and
 * be done with it. Power users still get the full picker via the
 * "Choose individual rules" escape hatch.
 *
 * Pure - no vscode. Tests in
 * test/git/branchProtectionTemplateAutoSuggest.test.ts.
 */

import { BranchRole } from './branchProtectionSuggest';
import { ProtectionDecision } from './forcePushGuard';
import { TemplateDefinition, TemplateId, TEMPLATES, getTemplate } from './branchProtectionTemplates';

/**
 * Should we surface the template suggestion on top of the role-derived
 * picker? The verdict states are:
 *
 *   - 'recommend'      - first-time setup; show the suggested template
 *                        as a featured pre-pick.
 *   - 'show-secondary' - branch HAS partial protection; show templates
 *                        as a "Reset to template?" tier below the
 *                        role-derived suggestions (less prominent so
 *                        we don't accidentally clobber custom rules).
 *   - 'suppress'       - branch already has comprehensive protection;
 *                        templates would just be noise.
 */
export type TemplateAutoSuggestVerdict =
  | 'recommend'
  | 'show-secondary'
  | 'suppress';

export interface TemplateAutoSuggestArgs {
  /** Current protection decision from the F71 probe. */
  decision: ProtectionDecision | undefined;
  /** Role classified by F126 (default / release / hotfix / etc). */
  role: BranchRole;
}

export function classifyTemplateAutoSuggest(args: TemplateAutoSuggestArgs): TemplateAutoSuggestVerdict {
  // First-time case: probe failed or returned 'unprotected' state.
  if (!args.decision) return 'recommend';
  if (args.decision.kind === 'unprotected') return 'recommend';
  if (args.decision.kind === 'unknown') {
    // Couldn't classify - probably a permissions issue or gh hiccup.
    // Treat as first-time so the user gets the easy path.
    return 'recommend';
  }
  // 'protected' variant - count enabled rules to decide between
  // secondary and suppress.
  const enabledCount = countEnabledRules(args.decision);
  if (enabledCount === 0) return 'recommend';
  if (enabledCount >= 5) return 'suppress'; // comprehensive setup
  return 'show-secondary';
}

function countEnabledRules(decision: ProtectionDecision): number {
  if (!decision || decision.kind !== 'protected') return 0;
  if (!Array.isArray(decision.rules)) return 0;
  return decision.rules.filter(r => r && r.enabled).length;
}

/**
 * Pick the RECOMMENDED template for a (role, role-context) pair.
 *
 * Mapping rationale:
 *   - default + open-source signal -> open-source-friendly
 *   - default + internal signal    -> internal-strict
 *   - release / hotfix             -> release-only (append-only post-cut)
 *   - long-lived                   -> open-source-friendly (review +
 *                                     checks is enough; no signed
 *                                     commits, no enforce-admins)
 *   - feature / other              -> none (we wouldn't auto-offer F130
 *                                     for these anyway; this branch is
 *                                     defensive against caller misuse)
 *
 * The "isOpenSource" signal is a coarse heuristic the view layer
 * derives from gh repo metadata (visibility=public is a strong
 * indicator; CONTRIBUTING.md + LICENSE adds confidence). When
 * uncertain, prefer 'open-source-friendly' since it's the gentler
 * default (admins can bypass for emergency fixes).
 */
export interface PickTemplateArgs {
  role: BranchRole;
  /** True when the repo looks open-source (visibility=public, etc). */
  isOpenSource?: boolean;
}

export function pickRecommendedTemplate(args: PickTemplateArgs): TemplateDefinition | undefined {
  switch (args.role) {
    case 'default':
      return getTemplate(args.isOpenSource === false ? 'internal-strict' : 'open-source-friendly');
    case 'release':
    case 'hotfix':
      return getTemplate('release-only');
    case 'long-lived':
      return getTemplate('open-source-friendly');
    case 'feature':
    case 'other':
      return undefined;
  }
}

/**
 * Build the placeholder copy for the first-time picker row. The
 * caller renders the template + alternatives below.
 */
export function buildAutoSuggestHeadline(template: TemplateDefinition, verdict: TemplateAutoSuggestVerdict): string {
  switch (verdict) {
    case 'recommend':
      return `Apply "${template.label}" template (recommended)`;
    case 'show-secondary':
      return `Reset to "${template.label}" template`;
    case 'suppress':
      return ''; // caller should suppress the row entirely
  }
}

/**
 * Build the picker detail copy explaining WHY this template was
 * recommended. Surfaces the role rationale + the template's own
 * description for transparency.
 */
export interface BuildHeadlineDetailArgs {
  template: TemplateDefinition;
  role: BranchRole;
  verdict: TemplateAutoSuggestVerdict;
}

export function buildAutoSuggestDetail(args: BuildHeadlineDetailArgs): string {
  const roleRationale = describeRoleFit(args.role);
  if (args.verdict === 'recommend') {
    return `${roleRationale}. ${args.template.description}`;
  }
  if (args.verdict === 'show-secondary') {
    return `Replace existing rules with the ${args.template.label.toLowerCase()} baseline.`;
  }
  return '';
}

function describeRoleFit(role: BranchRole): string {
  switch (role) {
    case 'default':
      return 'This is a default branch (main / master) - the canonical place';
    case 'release':
      return 'Release branches benefit from the locked-down ruleset';
    case 'hotfix':
      return 'Hotfix branches should be lock-down-clean after cut';
    case 'long-lived':
      return 'Long-lived branches (develop / staging / qa) need review + CI gates';
    case 'feature':
    case 'other':
      return 'Branch role unclear';
  }
}

/**
 * Compose the full auto-suggest payload the view layer splices into
 * the picker.
 *
 *   buildAutoSuggestPayload({
 *     decision: existing,
 *     role: 'default',
 *     isOpenSource: true,
 *   })
 *
 * Returns undefined when the verdict is 'suppress'. The view layer
 * then walks straight to the role-derived picker.
 */
export interface AutoSuggestPayload {
  template: TemplateDefinition;
  verdict: TemplateAutoSuggestVerdict;
  headline: string;
  detail: string;
  /** Whether the row should be highlighted / pre-picked. */
  prePick: boolean;
}

export interface BuildAutoSuggestPayloadArgs {
  decision: ProtectionDecision | undefined;
  role: BranchRole;
  isOpenSource?: boolean;
}

export function buildAutoSuggestPayload(args: BuildAutoSuggestPayloadArgs): AutoSuggestPayload | undefined {
  const verdict = classifyTemplateAutoSuggest({ decision: args.decision, role: args.role });
  if (verdict === 'suppress') return undefined;
  const template = pickRecommendedTemplate({ role: args.role, isOpenSource: args.isOpenSource });
  if (!template) return undefined;
  const headline = buildAutoSuggestHeadline(template, verdict);
  const detail = buildAutoSuggestDetail({ template, role: args.role, verdict });
  // Pre-pick only on first-time (recommend); secondary stays opt-in.
  return {
    template,
    verdict,
    headline,
    detail,
    prePick: verdict === 'recommend',
  };
}

/**
 * Return the set of TemplateId values the picker should offer as
 * alternatives BELOW the auto-suggested one. Excludes the
 * recommended template (no point seeing it twice) and the
 * 'release-only' template when the branch isn't a release branch
 * (it would just confuse).
 */
export function listAlternativeTemplates(args: { role: BranchRole; recommended: TemplateId }): TemplateDefinition[] {
  const out: TemplateDefinition[] = [];
  for (const tpl of TEMPLATES) {
    if (tpl.id === args.recommended) continue;
    // Hide release-only from non-release branches.
    if (tpl.id === 'release-only') {
      if (args.role !== 'release' && args.role !== 'hotfix' && args.role !== 'default') {
        continue;
      }
    }
    out.push(tpl);
  }
  return out;
}
