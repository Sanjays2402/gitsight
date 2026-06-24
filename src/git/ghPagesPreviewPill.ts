/**
 * F147 - GitHub Pages preview status-bar pill helpers.
 *
 * Companion to F79 (ghPagesPreview command). The full command picker
 * is opt-in via the command palette; F147 is the passive surface
 * that NUDGES the user toward it whenever a branch has UNCOMMITTED
 * (and/or unpushed) docs changes.
 *
 * Why a pill and not a toast? Toasts are dismissed once. The pill
 * stays visible while the working tree is dirty in docs/, so the
 * user can act when they're ready - and it disappears the moment
 * the working tree is clean again. Matches the F39 forgottenFiles
 * + F90 diffSize cadence.
 *
 * Pure - no vscode, no child_process. Tests in
 * test/git/ghPagesPreviewPill.test.ts.
 *
 * The view-layer controller wires this to the same RepoManager
 * onDidChange signal the other pills use, so a `git add` / commit
 * causes the pill to refresh.
 */

import { classifyDocsImpact, DocsImpactResult } from './ghPagesPreview';

/**
 * Pill visibility verdict. The pill renders only on 'show'; every
 * other verdict hides it (the matching `tooltip` field still gets
 * populated for debug / config UI affordances).
 */
export type PagesPillVerdict =
  | 'show'           // surface the pill (we have uncommitted docs edits)
  | 'hide-clean'     // no docs edits in the working tree
  | 'hide-not-applicable' // repo has no pages config and no .github/workflows pages action
  | 'hide-disabled';  // user opt-out via config

export interface PagesPillArgs {
  /** Enabled config knob. */
  enabled: boolean;
  /** Working-tree-only changed paths (from `git status --porcelain` / diff). */
  workingTreeChangedFiles: string[];
  /** Optional unpushed-range files (from `<upstream>..HEAD` diff). */
  unpushedFiles?: string[];
  /** Pages source directories to match against (default DEFAULT_PAGES_DIRS). */
  pagesDirs?: string[];
  /** True when `gh api repos/.../pages` returned a config OR a
   *  `peaceiris/actions-gh-pages` / `cloudflare/pages-action` workflow
   *  was detected. False when neither was found. */
  hasPagesSurface: boolean;
}

export interface PagesPillState {
  verdict: PagesPillVerdict;
  /** Total docs touches (working + unpushed, deduplicated). */
  totalCount: number;
  /** Working-tree-only count for the pill detail. */
  workingTreeCount: number;
  /** Unpushed range count. */
  unpushedCount: number;
  /** Per-dir counts (using DocsImpactResult shape) for the tooltip. */
  countsByDir: Record<string, number>;
  /** Up to maxMatchedPaths for the tooltip. */
  matchedPaths: string[];
}

const TOOLTIP_PATH_CAP = 20;

export function classifyPagesPill(args: PagesPillArgs): PagesPillState {
  if (!args.enabled) {
    return emptyState('hide-disabled');
  }
  if (!args.hasPagesSurface) {
    return emptyState('hide-not-applicable');
  }
  // Dedup the union so a path that exists in both ranges only counts once.
  const unionSet = new Set<string>();
  for (const p of args.workingTreeChangedFiles ?? []) {
    if (p && p.trim()) unionSet.add(p.trim());
  }
  for (const p of args.unpushedFiles ?? []) {
    if (p && p.trim()) unionSet.add(p.trim());
  }
  const docsImpact: DocsImpactResult = classifyDocsImpact({
    changedFiles: Array.from(unionSet),
    pagesDirs: args.pagesDirs,
    cap: TOOLTIP_PATH_CAP,
  });
  if (!docsImpact.affectsPages) {
    return emptyState('hide-clean');
  }
  // Separately count working-tree-only + unpushed contributions so the
  // tooltip can break them out (the user knows which ones git-add or
  // git-push would resolve).
  const workingImpact = classifyDocsImpact({
    changedFiles: args.workingTreeChangedFiles ?? [],
    pagesDirs: args.pagesDirs,
    cap: TOOLTIP_PATH_CAP,
  });
  const unpushedImpact = classifyDocsImpact({
    changedFiles: args.unpushedFiles ?? [],
    pagesDirs: args.pagesDirs,
    cap: TOOLTIP_PATH_CAP,
  });
  return {
    verdict: 'show',
    totalCount: docsImpact.matchedPaths.length, // matched & deduped
    workingTreeCount: sum(workingImpact.countsByDir),
    unpushedCount: sum(unpushedImpact.countsByDir),
    countsByDir: docsImpact.countsByDir,
    matchedPaths: docsImpact.matchedPaths,
  };
}

function emptyState(verdict: PagesPillVerdict): PagesPillState {
  return {
    verdict,
    totalCount: 0,
    workingTreeCount: 0,
    unpushedCount: 0,
    countsByDir: {},
    matchedPaths: [],
  };
}

function sum(counts: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}

/**
 * Build the pill text. Pill text must be tight; we lean on the
 * tooltip for the full breakdown.
 *
 *   Pages: 1 doc change
 *   Pages: 5 doc changes
 *   Pages: docs+_site (12)        // multi-dir, total
 */
export function formatPillText(state: PagesPillState): string {
  if (state.verdict !== 'show') return '';
  const dirs = Object.entries(state.countsByDir)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]) // most-touched dir first
    .map(([dir]) => dir);
  if (dirs.length === 0) {
    // shouldn't happen given affectsPages=true gate, but defensive:
    return `Pages: ${state.totalCount} doc changes`;
  }
  if (dirs.length === 1 && state.totalCount === 1) {
    return `Pages: 1 ${dirs[0]} change`;
  }
  if (dirs.length === 1) {
    return `Pages: ${state.totalCount} ${dirs[0]} changes`;
  }
  // Multi-dir: list up to 3 dirs by churn.
  const head = dirs.slice(0, 3).join('+');
  return `Pages: ${head} (${state.totalCount})`;
}

/**
 * Build the tooltip markdown. The view layer wraps this in a
 * MarkdownString so it gets nice rendering. The structure mirrors
 * the F39 forgottenFiles tooltip:
 *
 *   ### GitHub Pages preview - $TOTAL docs changes
 *
 *   $WT working-tree, $UP unpushed
 *
 *   - docs/foo.md
 *   - docs/bar.md
 *
 *   _Open preview to see what Pages would serve._
 */
export interface BuildPillTooltipArgs {
  state: PagesPillState;
  /** When true, append the unmatched-paths cap notice. */
  maxPathsShown?: number;
}

export function buildPillTooltip(args: BuildPillTooltipArgs): string {
  const { state } = args;
  if (state.verdict !== 'show') return '';
  const lines: string[] = [];
  lines.push(`### GitHub Pages preview \\u2014 ${state.totalCount} doc change${state.totalCount === 1 ? '' : 's'}`);
  lines.push('');
  if (state.workingTreeCount > 0 || state.unpushedCount > 0) {
    const parts: string[] = [];
    if (state.workingTreeCount > 0) {
      parts.push(`${state.workingTreeCount} working tree`);
    }
    if (state.unpushedCount > 0) {
      parts.push(`${state.unpushedCount} unpushed`);
    }
    lines.push(parts.join(' · '));
    lines.push('');
  }
  const cap = args.maxPathsShown ?? TOOLTIP_PATH_CAP;
  const shown = state.matchedPaths.slice(0, cap);
  for (const p of shown) {
    lines.push(`- ${p}`);
  }
  if (state.matchedPaths.length > shown.length) {
    lines.push(`- _\\u2026and ${state.matchedPaths.length - shown.length} more_`);
  }
  lines.push('');
  lines.push('_Click to open the Pages preview command._');
  return lines.join('\n');
}

/**
 * Detect whether the repository has a Pages "surface" - either an
 * actual Pages config OR a workflow that produces a preview. The
 * controller uses this to gate `classifyPagesPill`'s
 * `hasPagesSurface` field.
 *
 * Heuristic: scan workflow file CONTENTS for the canonical preview
 * action names. Cheap regex scan. Caller is responsible for reading
 * the workflow files (typically `.github/workflows/*.yml`).
 */
const PAGES_WORKFLOW_RX = [
  /\bpeaceiris\/actions-gh-pages\b/,
  /\bcloudflare\/pages-action\b/,
  /\bactions\/configure-pages\b/,
  /\bactions\/deploy-pages\b/,
  /\bvercel\/action\b/,
  /\bnetlify\/actions\b/,
];

export function workflowsAdvertisePages(workflowContents: string[]): boolean {
  for (const yaml of workflowContents) {
    if (!yaml) continue;
    for (const rx of PAGES_WORKFLOW_RX) {
      if (rx.test(yaml)) return true;
    }
  }
  return false;
}

/**
 * Compose the hasPagesSurface boolean from the two signals (gh api
 * pages probe + workflow YAML scan). Separated so the view layer
 * can short-circuit when one signal is sufficient.
 */
export interface HasPagesSurfaceArgs {
  /** True when `gh api repos/.../pages` returned 2xx. */
  apiSaysEnabled: boolean;
  /** True when at least one workflow advertises a Pages action. */
  workflowSaysEnabled: boolean;
}

export function hasPagesSurface(args: HasPagesSurfaceArgs): boolean {
  return Boolean(args.apiSaysEnabled || args.workflowSaysEnabled);
}
