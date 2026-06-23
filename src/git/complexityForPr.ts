/**
 * Pure helpers for F114 - Lazy-load complexity for `gh pr view`.
 *
 * F111 stamps a per-file complexity badge in the explorer; this module
 * is the PR-aggregate counterpart. Given a list of files changed in a
 * PR (with their bodies on disk, as `git show ${pr-tip}:${path}` would
 * emit them), classify each one and roll up into a single summary the
 * PrTimelinePill tooltip + a dedicated picker can render.
 *
 * Why this lives in its own file (not extending complexityBadge.ts):
 *  - The badge module is per-file lazy via VS Code's
 *    FileDecorationProvider. The PR aggregate is bulk, one-shot,
 *    triggered from a picker. Different lifecycle, different surface.
 *  - The aggregate has its own ranked output (highest-complexity-first)
 *    and per-bucket totals — that's UI-shaped knowledge that doesn't
 *    belong in the per-file pure module.
 *
 * Pure - no fs, no vscode. Tests in test/git/complexityForPr.test.ts.
 */

import {
  computeComplexity,
  classifyBucket,
  badgeFor,
  isAnalysableFile,
  ComplexityBucket,
  ComplexityScore,
} from './complexityBadge';

export interface PrChangedFile {
  /** Repo-relative path of the file on the PR tip. */
  path: string;
  /** File body as a string. Caller fetches via `git show <sha>:<path>`. */
  body: string;
  /** Optional change kind from git diff --raw - for UI hints. */
  changeKind?: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
}

export interface PrComplexityRow {
  path: string;
  score: ComplexityScore;
  /** Single-letter badge for the bucket; '' for low (no badge). */
  badge: string;
}

export interface PrComplexitySummary {
  /** Per-file scores, highest-bucket-first then highest-score-first within bucket. */
  rows: PrComplexityRow[];
  /** Files that were filtered out by isAnalysableFile (binary / vendored). */
  skipped: number;
  /** Files dropped because change-kind is 'D' (delete) - nothing to score. */
  deleted: number;
  /** Bucket histogram across the analysable files. */
  buckets: Record<ComplexityBucket, number>;
  /** Sum of `score` across analysable files. */
  totalScore: number;
  /** Highest individual bucket observed; undefined when nothing analysable. */
  topBucket?: ComplexityBucket;
  /** Total analysable count (`= sum(buckets)`). */
  analysed: number;
}

/**
 * Build the aggregate summary across every file in a PR.
 *
 * Order invariants:
 *   - extreme > high > medium > low within `rows`
 *   - within each bucket, higher score wins
 *   - within equal score, lexicographic path tiebreak so output is
 *     stable across calls (tests assert this)
 */
export function summarisePrComplexity(files: PrChangedFile[]): PrComplexitySummary {
  const rows: PrComplexityRow[] = [];
  const buckets: Record<ComplexityBucket, number> = { low: 0, medium: 0, high: 0, extreme: 0 };
  let skipped = 0;
  let deleted = 0;
  let totalScore = 0;

  for (const f of files) {
    if (f.changeKind === 'D') { deleted++; continue; }
    if (!isAnalysableFile(f.path)) { skipped++; continue; }
    const score = computeComplexity(f.body ?? '');
    rows.push({ path: f.path, score, badge: badgeFor(score.bucket) ?? '' });
    buckets[score.bucket] += 1;
    totalScore += score.score;
  }

  const bucketRank: Record<ComplexityBucket, number> = { low: 0, medium: 1, high: 2, extreme: 3 };
  rows.sort((a, b) => {
    const br = bucketRank[b.score.bucket] - bucketRank[a.score.bucket];
    if (br !== 0) return br;
    const sc = b.score.score - a.score.score;
    if (sc !== 0) return sc;
    return a.path.localeCompare(b.path);
  });

  let topBucket: ComplexityBucket | undefined;
  if (buckets.extreme > 0) topBucket = 'extreme';
  else if (buckets.high > 0) topBucket = 'high';
  else if (buckets.medium > 0) topBucket = 'medium';
  else if (buckets.low > 0) topBucket = 'low';

  return {
    rows,
    skipped,
    deleted,
    buckets,
    totalScore,
    topBucket,
    analysed: buckets.low + buckets.medium + buckets.high + buckets.extreme,
  };
}

/**
 * Short one-line label fit for the PrTimelinePill tooltip row:
 *
 *   "12 files · 3 H · 1 X"            (highest visible buckets shown)
 *   "8 files · 2 M · 6 low"           (M/H/X buckets are abbreviated; low spelled)
 *   "no analysable files"             (everything was skipped/deleted)
 *
 * We only show bucket counts for buckets that actually have entries.
 */
export function formatPillLabel(s: PrComplexitySummary): string {
  if (s.analysed === 0) {
    if (s.skipped + s.deleted > 0) return 'no analysable files';
    return 'no files';
  }
  const parts: string[] = [];
  parts.push(`${s.analysed} file${s.analysed === 1 ? '' : 's'}`);
  if (s.buckets.extreme) parts.push(`${s.buckets.extreme} X`);
  if (s.buckets.high) parts.push(`${s.buckets.high} H`);
  if (s.buckets.medium) parts.push(`${s.buckets.medium} M`);
  if (s.buckets.low && !s.buckets.medium && !s.buckets.high && !s.buckets.extreme) {
    parts.push(`${s.buckets.low} low`);
  }
  return parts.join(' \u00b7 ');
}

/**
 * Multi-line markdown body for the PrTimelinePill tooltip OR a picker
 * detail row. Mirrors the buildComplexityTooltip shape from F111.
 */
export function buildPrComplexityTooltip(s: PrComplexitySummary): string {
  const lines: string[] = [];
  lines.push(`**PR complexity**  -  ${formatPillLabel(s)}`);
  lines.push('');
  if (s.analysed === 0) {
    if (s.deleted) lines.push(`- ${s.deleted} deleted file${s.deleted === 1 ? '' : 's'}`);
    if (s.skipped) lines.push(`- ${s.skipped} skipped (binary / vendored)`);
    return lines.join('\n');
  }
  if (s.buckets.extreme) lines.push(`- ${s.buckets.extreme} extreme (X)`);
  if (s.buckets.high) lines.push(`- ${s.buckets.high} high (H)`);
  if (s.buckets.medium) lines.push(`- ${s.buckets.medium} medium (M)`);
  if (s.buckets.low) lines.push(`- ${s.buckets.low} low`);
  if (s.skipped) lines.push(`- ${s.skipped} skipped`);
  if (s.deleted) lines.push(`- ${s.deleted} deleted`);
  lines.push('');
  lines.push(`Total score: ${s.totalScore}`);
  if (s.topBucket && s.topBucket !== 'low') {
    lines.push('');
    lines.push('_Hottest files first:_');
    const top = s.rows.slice(0, 5);
    for (const r of top) {
      const tag = badgeFor(r.score.bucket) || 'L';
      lines.push(`- \`${r.path}\`  -  ${tag} (score ${r.score.score})`);
    }
  }
  return lines.join('\n');
}

/** Markdown for a full report (the picker's "Open report" action). */
export function buildPrComplexityReport(
  s: PrComplexitySummary,
  args: { prNumber?: number; range?: string },
): string {
  const lines: string[] = [];
  const title = args.prNumber !== undefined
    ? `# PR #${args.prNumber} - File Complexity Report`
    : '# PR File Complexity Report';
  lines.push(title);
  lines.push('');
  if (args.range) lines.push(`_range: \`${args.range}\`_`, '');
  lines.push(`**Files**: ${s.analysed} analysed, ${s.skipped} skipped, ${s.deleted} deleted`);
  lines.push(`**Total score**: ${s.totalScore}`);
  lines.push(`**Buckets**: extreme ${s.buckets.extreme} \u00b7 high ${s.buckets.high} \u00b7 medium ${s.buckets.medium} \u00b7 low ${s.buckets.low}`);
  lines.push('');
  lines.push('| File | Bucket | Score | Decisions | Nesting | Lines | Functions |');
  lines.push('| --- | --- | ---:| ---:| ---:| ---:| ---:|');
  for (const r of s.rows) {
    lines.push(
      `| \`${escapePipe(r.path)}\` | ${capitalise(r.score.bucket)} | ${r.score.score} | ${r.score.decisions} | ${r.score.maxNesting} | ${r.score.logicalLines} | ${r.score.functions} |`,
    );
  }
  return lines.join('\n');
}

function capitalise(s: string): string { return s.length ? s[0].toUpperCase() + s.slice(1) : s; }
function escapePipe(s: string): string { return s.replace(/\|/g, '\\|'); }

/**
 * Re-export the helpers a view-layer caller is likely to want from a
 * single import site so the controller doesn't have to also pull
 * complexityBadge.ts.
 */
export { classifyBucket, badgeFor };
