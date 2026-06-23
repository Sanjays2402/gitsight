/**
 * Pure helpers for the Auto-Resolve Trivial Conflicts feature (F113).
 *
 * Composes with F107 (Conflict Resolution Coach). Where F107 walks one
 * conflict at a time, F113 scans ALL open conflict blocks in a file and
 * RESOLVES every block whose difficulty classifies as 'trivial' --
 * without asking per block.
 *
 * The trivial cases (from F107 classifyDifficulty):
 *
 *   1. Both sides identical              -> take ours
 *   2. Ours + base empty                 -> take theirs (we added; they didn't)
 *   3. Theirs + base empty               -> take ours  (they added; we didn't)
 *   4. Only trailing whitespace differs  -> take ours
 *   5. Ours matches base (diff3)         -> take theirs
 *   6. Theirs matches base (diff3)       -> take ours
 *
 * For each, F107.classifyDifficulty returns a `suggestion: ResolutionChoice`
 * which is the canonical "right" answer. We feed that suggestion through
 * F107.applyResolution sequentially.
 *
 * The KEY subtlety: applying resolution N changes the line numbers of
 * blocks N+1..M because the block's `<<<<<<< ... >>>>>>>` span gets
 * REPLACED by a shorter (or longer) content fragment. F107's
 * applyResolution re-extracts conflicts on every call, so it operates
 * on the CURRENT body shape -- but its `blockIndex` parameter is an
 * index into the CURRENT extractConflicts() result. To avoid index
 * drift, we always resolve the LAST trivial block first, then the
 * second-to-last, etc. This keeps earlier blocks' indices stable while
 * we work our way down to block 0.
 *
 * Pure -- no fs, no vscode. Tests in test/git/conflictAutoResolve.test.ts.
 */

import {
  extractConflicts,
  applyResolution,
  classifyDifficulty,
  ResolutionChoice,
  ConflictExtraction,
  Difficulty,
} from './conflictCoach';

export interface AutoResolvePlanEntry {
  /** 0-based block index at planning time. */
  blockIndex: number;
  /** 1-based start line in the ORIGINAL body. */
  startLine: number;
  /** The classifier's reason (e.g. "both sides identical"). */
  reason: string;
  /** What the auto-resolver chose ("ours" / "theirs" / etc). */
  choice: ResolutionChoice;
}

export interface AutoResolvePlan {
  /** Trivial blocks that WILL be auto-resolved (in plan order). */
  entries: AutoResolvePlanEntry[];
  /** Total conflict blocks in the file (some may not be trivial). */
  totalBlocks: number;
  /** Difficulties for ALL blocks, for reporting. */
  difficulties: Difficulty[];
}

/**
 * Build a resolution plan for a given file body. Does NOT mutate.
 * The caller decides whether to apply.
 */
export function buildAutoResolvePlan(body: string): AutoResolvePlan {
  const extractions = extractConflicts(body);
  const difficulties: Difficulty[] = [];
  const entries: AutoResolvePlanEntry[] = [];
  for (let i = 0; i < extractions.length; i++) {
    const ex = extractions[i];
    const d = classifyDifficulty(ex);
    difficulties.push(d.level);
    if (d.level === 'trivial' && d.suggestion) {
      entries.push({
        blockIndex: i,
        startLine: (ex.block.startLine | 0) + 1,
        reason: d.reasons[0] ?? 'trivial',
        choice: d.suggestion,
      });
    }
  }
  return {
    entries,
    totalBlocks: extractions.length,
    difficulties,
  };
}

/**
 * Apply the plan to the body. Returns the new body + a per-entry
 * outcome list.
 *
 * Strategy: resolve blocks from HIGHEST index downward so applying
 * earlier blocks doesn't shift later ones.
 *
 * Each applyResolution call re-extracts conflicts -- so even if the
 * file shifts in unexpected ways, the operation stays safe (we just
 * skip an entry if its block index is no longer in range).
 */
export interface AutoResolveResult {
  body: string;
  /** Per entry: resolved or skipped (with reason). */
  outcomes: { entry: AutoResolvePlanEntry; status: 'resolved' | 'skipped'; reason?: string }[];
  resolvedCount: number;
  skippedCount: number;
}

export function applyAutoResolvePlan(body: string, plan: AutoResolvePlan): AutoResolveResult {
  // Sort plan entries by blockIndex DESCENDING so the higher-numbered
  // resolutions go first; earlier blocks keep their indices.
  const sorted = [...plan.entries].sort((a, b) => b.blockIndex - a.blockIndex);
  let workingBody = body;
  const outcomes: AutoResolveResult['outcomes'] = [];
  for (const entry of sorted) {
    const current = extractConflicts(workingBody);
    if (entry.blockIndex < 0 || entry.blockIndex >= current.length) {
      outcomes.push({ entry, status: 'skipped', reason: `block ${entry.blockIndex} no longer in file` });
      continue;
    }
    const blk = current[entry.blockIndex];
    if (!blk.wellFormed) {
      outcomes.push({ entry, status: 'skipped', reason: 'block no longer well-formed' });
      continue;
    }
    try {
      workingBody = applyResolution(workingBody, entry.blockIndex, entry.choice);
      outcomes.push({ entry, status: 'resolved' });
    } catch (e: any) {
      outcomes.push({ entry, status: 'skipped', reason: e?.message ?? 'apply failed' });
    }
  }
  // Re-sort outcomes back into plan order (ascending block index) so the
  // caller sees a stable "in file order" report.
  outcomes.sort((a, b) => a.entry.blockIndex - b.entry.blockIndex);
  const resolved = outcomes.filter(o => o.status === 'resolved').length;
  return {
    body: workingBody,
    outcomes,
    resolvedCount: resolved,
    skippedCount: outcomes.length - resolved,
  };
}

/**
 * One-line summary for a status-bar message or notification.
 *
 *   "GitSight: auto-resolved 4 trivial conflicts on src/foo.ts (2 remaining)"
 */
export function describeAutoResolveOutcome(
  filePath: string,
  result: AutoResolveResult,
  remainingNonTrivial: number,
): string {
  const r = result.resolvedCount;
  const noun = r === 1 ? 'conflict' : 'conflicts';
  const suffix = remainingNonTrivial > 0
    ? ` (${remainingNonTrivial} remaining)`
    : ' \u2014 all clear';
  if (r === 0) {
    return `GitSight: no trivial conflicts to auto-resolve on ${filePath}${suffix}`;
  }
  return `GitSight: auto-resolved ${r} trivial ${noun} on ${filePath}${suffix}`;
}

/**
 * Build a markdown preview of the plan suitable for an
 * "Apply" / "Cancel" modal.
 */
export function buildPlanMarkdown(filePath: string, plan: AutoResolvePlan): string {
  const lines: string[] = [];
  lines.push(`# Auto-Resolve Plan \u2014 ${filePath}`);
  lines.push('');
  if (!plan.entries.length) {
    lines.push(`No trivial conflicts to auto-resolve. ${plan.totalBlocks} block${plan.totalBlocks === 1 ? '' : 's'} need manual review.`);
    return lines.join('\n');
  }
  lines.push(`**${plan.entries.length} of ${plan.totalBlocks}** conflict block${plan.totalBlocks === 1 ? '' : 's'} can be auto-resolved.`);
  lines.push('');
  lines.push('| # | Line | Choice | Reason |');
  lines.push('| --- | --- | --- | --- |');
  for (const e of plan.entries) {
    lines.push(`| ${e.blockIndex + 1} | ${e.startLine} | \`take ${e.choice}\` | ${e.reason} |`);
  }
  const remaining = plan.totalBlocks - plan.entries.length;
  if (remaining > 0) {
    lines.push('');
    lines.push(`**${remaining} block${remaining === 1 ? '' : 's'}** will remain for manual resolution after the auto-pass.`);
  }
  return lines.join('\n');
}

/**
 * Count blocks per difficulty bucket. Useful for the picker subtitle.
 *
 *   { trivial: 3, small: 1, moderate: 0, large: 2 }
 */
export function countDifficulties(plan: AutoResolvePlan): Record<Difficulty, number> {
  const counts: Record<Difficulty, number> = { trivial: 0, small: 0, moderate: 0, large: 0 };
  for (const d of plan.difficulties) counts[d]++;
  return counts;
}

/**
 * Plan + outcome + remaining-non-trivial in one trip -- convenience
 * for the controller's status-bar message after a successful apply.
 */
export function countRemaining(body: string): number {
  // After applying the plan to the body, every block left in the file
  // is either non-trivial OR a previously-malformed entry. Either way
  // they need manual attention.
  return extractConflicts(body).length;
}

// Re-export ConflictExtraction so the view's import surface is a single
// module rather than two.
export type { ConflictExtraction };
