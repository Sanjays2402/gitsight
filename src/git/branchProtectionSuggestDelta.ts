/**
 * Pure helpers for F135 - Branch Protection Delta-Only Picker.
 *
 * Companion to F126 (auto-suggester) and F119 (overview picker). When
 * the user re-runs the suggester on a branch that ALREADY has rules,
 * we don't want to spam them with the full picker again - they've
 * seen most of it. Instead, we compute a structured DELTA between:
 *
 *   - The CURRENT protection state (from F71 classifyProtection).
 *   - The PROPOSED ruleset (from F126 suggestProtectionRules).
 *
 * And only surface the rows that would CHANGE if the user accepted
 * the proposal. Plain "already-on" rules are silenced; "would-add"
 * and "would-disable" rules are shown.
 *
 * The picker reads cleaner ("here's what would change") and reduces
 * the chance of an accidental down-grade when the user clicks
 * through the picker too quickly.
 *
 * Pure - no vscode. Tests in test/git/branchProtectionSuggestDelta.test.ts.
 */

import { ProtectionDecision, ProtectionRule } from './forcePushGuard';
import { RuleSuggestion, SuggestionStrength } from './branchProtectionSuggest';

export type DeltaChange = 'would-add' | 'would-strengthen' | 'already-on';

export interface ProtectionRuleDelta {
  id: ProtectionRule['id'];
  label: string;
  rationale: string;
  strength: SuggestionStrength;
  change: DeltaChange;
  weight: number;
}

/**
 * Compute the delta set. Each item in the proposed list is paired
 * with the current state of the matching rule and labelled.
 *
 *   - rule not in `current.rules` (or current.kind != 'protected')
 *     -> 'would-add'
 *   - rule in `current.rules` with enabled=false -> 'would-strengthen'
 *   - rule in `current.rules` with enabled=true  -> 'already-on'
 *
 * Returns suggestions in original weight order; the picker filters
 * by change-kind to render only the ones it cares about.
 */
export function computeProtectionDelta(args: {
  current: ProtectionDecision;
  proposed: RuleSuggestion[];
}): ProtectionRuleDelta[] {
  const { current, proposed } = args;
  const ruleState = new Map<ProtectionRule['id'], boolean>();
  if (current.kind === 'protected') {
    for (const r of current.rules) ruleState.set(r.id, !!r.enabled);
  }
  const out: ProtectionRuleDelta[] = [];
  for (const s of proposed) {
    const known = ruleState.get(s.id);
    let change: DeltaChange;
    if (known === undefined) change = 'would-add';
    else if (known === false) change = 'would-strengthen';
    else change = 'already-on';
    out.push({
      id: s.id,
      label: s.label,
      rationale: s.rationale,
      strength: s.strength,
      change,
      weight: s.weight,
    });
  }
  return out;
}

/**
 * Decide whether the delta picker should suppress itself entirely
 * (no changes worth showing) or proceed.
 *
 *   - all 'already-on' -> 'no-delta' (return 'already-covered')
 *   - some changes      -> 'has-delta'
 *   - empty proposed    -> 'no-delta'
 */
export type DeltaVerdict = 'has-delta' | 'no-delta';

export function classifyDeltaVerdict(deltas: ProtectionRuleDelta[]): DeltaVerdict {
  if (!deltas.length) return 'no-delta';
  for (const d of deltas) {
    if (d.change !== 'already-on') return 'has-delta';
  }
  return 'no-delta';
}

/**
 * Filter to only the rows the picker should display. Drops 'already-on'
 * by default; opt in via `includeAlreadyOn` for the full markdown report.
 */
export function selectDeltaRows(
  deltas: ProtectionRuleDelta[],
  opts: { includeAlreadyOn?: boolean } = {},
): ProtectionRuleDelta[] {
  if (opts.includeAlreadyOn) return [...deltas];
  return deltas.filter(d => d.change !== 'already-on');
}

/**
 * Per-row description string for the picker. Strength affects the
 * tail; change-kind is the lead.
 *
 *   "would-add (recommended) - At least one approving review..."
 *   "would-strengthen (optional) - signed commits..."
 *   "already-on (aggressive) - admins can normally bypass..."
 */
export function describeDeltaRow(d: ProtectionRuleDelta): string {
  const kindLabel = d.change === 'would-add' ? 'would add'
                  : d.change === 'would-strengthen' ? 'would enable'
                  : 'already on';
  return `${kindLabel} (${d.strength}) - ${d.rationale}`;
}

/**
 * One-line title for the picker, e.g.:
 *   "main - 3 changes (2 add, 1 strengthen)"
 *   "release/2026.q2 - already at the proposed baseline"
 */
export function describeDeltaTitle(branch: string, deltas: ProtectionRuleDelta[]): string {
  const verdict = classifyDeltaVerdict(deltas);
  if (verdict === 'no-delta') {
    return `${branch} - already at the proposed baseline`;
  }
  const adds = deltas.filter(d => d.change === 'would-add').length;
  const strengths = deltas.filter(d => d.change === 'would-strengthen').length;
  const total = adds + strengths;
  const parts: string[] = [];
  if (adds) parts.push(`${adds} add${adds === 1 ? '' : ''}`);
  if (strengths) parts.push(`${strengths} strengthen${strengths === 1 ? '' : ''}`);
  return `${branch} - ${total} change${total === 1 ? '' : 's'} (${parts.join(', ')})`;
}

/**
 * Build a markdown report body suitable for "Open full report" action.
 * Includes all three change-kinds in separate sections; sections only
 * appear when populated.
 *
 *   # Branch Protection Delta - `main`
 *
 *   ## Would add (2)
 *   - **Require PR review** (recommended) - rationale...
 *
 *   ## Would strengthen (1)
 *   - **Require signed commits** (optional) - rationale...
 *
 *   ## Already covered (3)
 *   - **Disallow force-push** (recommended)
 */
export function buildDeltaReport(args: {
  branch: string;
  deltas: ProtectionRuleDelta[];
  /** When true, include the "Already covered" section. Default true. */
  includeAlreadyOn?: boolean;
}): string {
  const includeAlreadyOn = args.includeAlreadyOn ?? true;
  const lines: string[] = [];
  lines.push(`# Branch Protection Delta - \`${args.branch}\``);
  lines.push('');
  const verdict = classifyDeltaVerdict(args.deltas);
  if (verdict === 'no-delta') {
    lines.push('_No changes - existing ruleset already meets or exceeds the proposed baseline._');
    return lines.join('\n');
  }
  const groups = {
    'would-add': args.deltas.filter(d => d.change === 'would-add'),
    'would-strengthen': args.deltas.filter(d => d.change === 'would-strengthen'),
    'already-on': args.deltas.filter(d => d.change === 'already-on'),
  };
  const sectionTitle: Record<DeltaChange, string> = {
    'would-add': 'Would add',
    'would-strengthen': 'Would strengthen',
    'already-on': 'Already covered',
  };
  for (const kind of ['would-add', 'would-strengthen'] as const) {
    if (groups[kind].length === 0) continue;
    lines.push(`## ${sectionTitle[kind]} (${groups[kind].length})`);
    lines.push('');
    for (const d of groups[kind]) {
      lines.push(`- **${d.label}** (${d.strength}) - ${d.rationale}`);
    }
    lines.push('');
  }
  if (includeAlreadyOn && groups['already-on'].length > 0) {
    lines.push(`## ${sectionTitle['already-on']} (${groups['already-on'].length})`);
    lines.push('');
    for (const d of groups['already-on']) {
      lines.push(`- **${d.label}** (${d.strength})`);
    }
  }
  return lines.join('\n').replace(/\n+$/g, '');
}

/**
 * Convert delta rows back into a `picked` list suitable for
 * buildProtectionPutBody. Used when the user clicks "Apply all"
 * on a delta picker - we want every CHANGE applied (not the
 * already-on ones, which would be a no-op).
 */
export function pickAllChanges(deltas: ProtectionRuleDelta[]): Array<ProtectionRule['id']> {
  return deltas
    .filter(d => d.change !== 'already-on')
    .map(d => d.id);
}
